import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeAncestry, type OwnerIdentity } from "./idle-observer-process.mts";
export type { OwnerIdentity } from "./idle-observer-process.mts";
export interface ObservationRun { version: 1; runId: string; sessionId: string; armNonce: string;
  createdAt: string; expiresAt: string; owner: OwnerIdentity; codeSha256: string }
export interface ObservationMetadata {
  runId: string; event: string; notificationType?: string; receivedAt: string;
  owner: OwnerIdentity; codeSha256: string; sequence: number }
export interface ObservationJournal { version: 1; runId: string; events: ObservationMetadata[] }
export interface ObservationDeps {
  now?: () => Date; ancestry?: (pid: number) => OwnerIdentity[] | null;
  codeSha256?: () => string | null; activityWrite?: (fd: number, text: string) => void; activityPrepare?: (file: string) => void;
}
export type ObservationResult = "recorded" | "ignored";
const MAX_LIFETIME_MS = 10 * 60_000, MAX_INPUT_BYTES = 1024 * 1024;
const MAX_EVENTS = 16, MAX_ACTIVITY_WITNESSES = 16;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const ACTIVITY_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const SOURCE_FILE = fileURLToPath(import.meta.url);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value); }
function owner(value: unknown): value is OwnerIdentity {
  return record(value) && Number.isInteger(value.pid) && (value.pid as number) > 1
    && typeof value.startedAt === "string" && value.startedAt.length > 0 && value.startedAt.length <= 256; }
function runContract(value: unknown): value is ObservationRun {
  return record(value) && value.version === 1 && typeof value.runId === "string" && TOKEN.test(value.runId)
    && typeof value.sessionId === "string" && TOKEN.test(value.sessionId)
    && typeof value.armNonce === "string" && SHA256.test(value.armNonce) && typeof value.createdAt === "string"
    && typeof value.expiresAt === "string"
    && owner(value.owner) && typeof value.codeSha256 === "string" && SHA256.test(value.codeSha256);
}
function windowsOwned(file: string, privateMode: boolean): boolean {
  try {
    const script = "$p=$env:KHEREP_IDLE_PATH;"
      + "$a=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};"
      + "$o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;"
      + "$c=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"
      + "if($o -ne $c){return};if($env:KHEREP_IDLE_PRIVATE -ne '1'){'1';return};"
      + "$r=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);"
      + "$f=[Security.AccessControl.FileSystemRights]::FullControl;$ok=$r.Count -gt 0;"
      + "foreach($e in $r){if($e.IdentityReference.Value -ne $c -or $e.AccessControlType -ne 'Allow'"
      + " -or (($e.FileSystemRights -band $f) -ne $f)){$ok=$false}};if($ok){'1'}";
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, KHEREP_IDLE_PATH: file, KHEREP_IDLE_PRIVATE: privateMode ? "1" : "0" },
    }).trim() === "1";
  } catch { return false; }
}
function securePath(file: string, kind: "file" | "directory", privateMode = true): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) return false;
    if (process.platform === "win32") return windowsOwned(file, privateMode);
    return typeof process.getuid === "function" && stat.uid === process.getuid()
      && (!privateMode || (stat.mode & 0o077) === 0);
  } catch { return false; }
}
function restrictWindows(file: string): void {
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {
      encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  if (!sid) throw new Error("identity unavailable");
  if (!windowsOwned(file, false)) execFileSync("icacls.exe", [file, "/setowner", `*${sid}`, "/Q"], {
    windowsHide: true, timeout: 5_000, stdio: "ignore" });
  const script = "$p=$env:KHEREP_IDLE_PATH;$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;"
    + "$a=New-Object Security.AccessControl.FileSecurity;$a.SetAccessRuleProtection($true,$false);"
    + "$r=New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','Allow');$a.AddAccessRule($r);(New-Object IO.FileInfo -ArgumentList $p).SetAccessControl($a)";
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5_000, stdio: "ignore", env: { ...process.env, KHEREP_IDLE_PATH: file } });
}
function openPrivateNew(file: string, prepare?: (file: string) => void, retainOnFailure = false): number {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    prepare?.(file);
    if (process.platform === "win32") restrictWindows(file); else fs.chmodSync(file, 0o600);
    if (!securePath(file, "file")) throw new Error("private file not established");
    return fd;
  } catch (error) { fs.closeSync(fd); if (!retainOnFailure) fs.rmSync(file, { force: true }); throw error; }
}
function parseJsonFile(file: string): unknown {
  const text = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new Error("oversize");
  return JSON.parse(text) as unknown; }
function validWindow(run: ObservationRun, now: Date): boolean {
  const created = Date.parse(run.createdAt);
  const expires = Date.parse(run.expiresAt);
  const current = now.getTime();
  return Number.isFinite(created) && Number.isFinite(expires) && created <= current && current <= expires
    && expires > created && expires - created <= MAX_LIFETIME_MS; }
function ownCodeSha256(): string | null {
  try {
    if (![SOURCE_FILE, path.join(path.dirname(SOURCE_FILE), "idle-observer-process.mts")]
      .every((file) => securePath(file, "file", false))) return null;
    return observerCodeSha256();
  } catch {
    return null;
  }
}
export function observerCodeSha256(observerFile: string = SOURCE_FILE): string {
  const files = [observerFile, path.join(path.dirname(observerFile), "idle-observer-process.mts")]
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const name = path.basename(file);
    const bytes = fs.readFileSync(file);
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
function journal(value: unknown, runId: string): ObservationJournal | null {
  if (!record(value) || value.version !== 1 || value.runId !== runId || !Array.isArray(value.events)
    || value.events.length > MAX_EVENTS) return null;
  const events = value.events as unknown[];
  if (!events.every((item) => record(item) && item.runId === runId && typeof item.event === "string"
    && typeof item.receivedAt === "string" && owner(item.owner) && typeof item.codeSha256 === "string"
    && SHA256.test(item.codeSha256) && Number.isInteger(item.sequence) && (item.sequence as number) > 0)) return null;
  return value as unknown as ObservationJournal;
}
function writeActivityWitness(runDir: string, metadata: ObservationMetadata,
  write: (fd: number, text: string) => void, prepare?: (file: string) => void): boolean {
  const text = `${JSON.stringify(metadata, null, 2)}\n`;
  for (let index = 0; index < MAX_ACTIVITY_WITNESSES; index++) {
    const file = path.join(runDir, `activity-${String(index).padStart(2, "0")}.json`);
    let fd: number | undefined;
    try {
      fd = openPrivateNew(file, prepare, true);
      write(fd, text);
      fs.fsyncSync(fd); fs.closeSync(fd);
      fd = undefined;
      return securePath(file, "file");
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return false;
    }
  }
  const overflow = path.join(runDir, "activity-overflow");
  let fd: number | undefined;
  try {
    fd = openPrivateNew(overflow, prepare, true);
    fs.writeFileSync(fd, "activity witness capacity exceeded\n");
    fs.fsyncSync(fd); fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  return securePath(overflow, "file");
}
function nextSequence(runDir: string, runId: string): number {
  const file = path.join(runDir, "journal.json");
  if (!fs.existsSync(file)) return 1;
  if (!securePath(file, "file")) return Number.MAX_SAFE_INTEGER;
  try {
    const current = journal(parseJsonFile(file), runId);
    return current ? (current.events.at(-1)?.sequence ?? 0) + 1 : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
function writeAtomic(file: string, value: unknown): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openPrivateNew(temp);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd); fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
export function observeEvent(runDir: string, armNonce: string, input: unknown,
  deps: ObservationDeps = {}): ObservationResult {
  const lock = path.join(runDir, ".observer.lock");
  let lockFd: number | undefined;
  try {
    if (!path.isAbsolute(runDir) || !securePath(runDir, "directory")) return "ignored";
    const runFile = path.join(runDir, "run.json");
    if (!securePath(runFile, "file")) return "ignored";
    const run = parseJsonFile(runFile);
    if (!runContract(run) || armNonce !== run.armNonce || !validWindow(run, (deps.now ?? (() => new Date()))())) return "ignored";
    if (!record(input) || input.session_id !== run.sessionId || typeof input.hook_event_name !== "string") return "ignored";
    const event = input.hook_event_name;
    if (event === "Notification" ? input.notification_type !== "idle_prompt" : !ACTIVITY_EVENTS.has(event)) return "ignored";
    const actualCode = (deps.codeSha256 ?? ownCodeSha256)();
    if (actualCode !== run.codeSha256) return "ignored";
    const ancestry = (deps.ancestry ?? readNativeAncestry)(process.ppid);
    if (!ancestry?.some((item) => item.pid === run.owner.pid && item.startedAt === run.owner.startedAt)) return "ignored";
    const receivedAt = (deps.now ?? (() => new Date()))().toISOString();
    const baseMetadata = {
      runId: run.runId, event, ...(event === "Notification" ? { notificationType: "idle_prompt" } : {}),
      receivedAt, owner: run.owner, codeSha256: run.codeSha256,
    };
    const activityWitnessed = ACTIVITY_EVENTS.has(event)
      && writeActivityWitness(runDir, { ...baseMetadata, sequence: nextSequence(runDir, run.runId) },
        deps.activityWrite ?? ((fd, text) => fs.writeFileSync(fd, text, "utf8")), deps.activityPrepare);
    if (ACTIVITY_EVENTS.has(event) && !activityWitnessed) return "ignored";
    try { lockFd = openPrivateNew(lock); }
    catch { return activityWitnessed ? "recorded" : "ignored"; }
    const journalFile = path.join(runDir, "journal.json");
    let current: ObservationJournal = { version: 1, runId: run.runId, events: [] };
    if (fs.existsSync(journalFile)) {
      if (!securePath(journalFile, "file")) return "ignored";
      const parsed = journal(parseJsonFile(journalFile), run.runId);
      if (!parsed) return "ignored";
      current = parsed;
    }
    if (event === "Notification" && current.events.some((item) => item.event === "Notification" && item.notificationType === "idle_prompt")) return "ignored";
    if (current.events.length >= MAX_EVENTS) return activityWitnessed ? "recorded" : "ignored";
    const metadata: ObservationMetadata = { ...baseMetadata, sequence: (current.events.at(-1)?.sequence ?? 0) + 1 };
    writeAtomic(journalFile, { ...current, events: [...current.events, metadata] });
    return "recorded";
  } catch {
    return "ignored";
  } finally {
    if (lockFd !== undefined) {
      fs.closeSync(lockFd);
      try { fs.rmSync(lock, { force: true }); } catch { /* fail closed on the next callback */ }
    }
  }
}
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
async function callback(): Promise<void> {
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (Buffer.byteLength(text) > MAX_INPUT_BYTES) return;
    }
    const runDir = argument("--run-dir");
    const arm = argument("--arm");
    if (process.argv[2] === "callback" && runDir && arm) observeEvent(runDir, arm, JSON.parse(text) as unknown);
  } catch {
    // Observation is fail-closed and never affects Claude's normal flow.
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SOURCE_FILE) await callback();

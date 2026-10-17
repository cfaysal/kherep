import fs from "node:fs";
import path from "node:path";

import { LAUNCHER_REASONS, LAUNCHER_SCRIPT, PIN_COMMIT, cmdShim, posixShim, ps1Shim } from "./launcher-template.mts";

// Issue #436. The stable per-host Control Plane command. <configRoot>/bin/ holds
// kherep-node.mjs, which reads the managed service receipt at call time and
// runs the CLI of the pin it names, plus shims for humans. The files never name
// a pin, so service upgrade and rollback move only the receipt and the command
// keeps working. Agents run launcherCommand(root); nothing changes PATH.

export const LAUNCHER_FILE = "kherep-node.mjs";

export interface LauncherInput { platform: NodeJS.Platform; configRoot: string; nodeExecutable: string }
export interface LauncherFile { name: string; content: string; mode: number }
export type LauncherStatus = "written" | "unchanged";
export type LauncherFailure = Exclude<keyof typeof LAUNCHER_REASONS, "spawn">;
export type LauncherResolution =
  | { ok: true; receipt: string; pin: string; cli: string; nodeExecutable: string }
  | { ok: false; reason: LauncherFailure; receipt: string };

// The file system as resolveLauncher sees it; tests substitute a Windows or a
// macOS view. readFile throws an error with code ENOENT for a missing file.
export interface LauncherIo { path: path.PlatformPath; readFile(file: string): string; isFile(file: string): boolean }

const flavor = (platform: NodeJS.Platform): path.PlatformPath => platform === "win32" ? path.win32 : path.posix;
const slashes = (value: string, platform: NodeJS.Platform): string => platform === "win32" ? value.replaceAll("\\", "/") : value;

// Every rendered path sits in double quotes in sh, cmd and PowerShell, so the
// characters those quotes do not make literal are refused. On Windows a single
// quote is refused too, as taskCliCommand() does for the same two shells.
function quotable(value: string, label: string, platform: NodeJS.Platform): string {
  if (!flavor(platform).isAbsolute(value)) throw new Error(`the launcher ${label} must be an absolute path`);
  if (/[\u0000-\u001f\u007f"`$]/.test(value) || (platform === "win32" ? /['%]/.test(value) : value.includes("\\"))) {
    throw new Error(`the launcher ${label} contains a character that cannot be quoted for every shell`);
  }
  return value;
}

export function launcherPath(root: string, platform: NodeJS.Platform = process.platform): string {
  return flavor(platform).join(root, "bin", LAUNCHER_FILE);
}

// The one command string every instruction, rule and check names (PR B, PR C).
export function launcherCommand(root: string, platform: NodeJS.Platform = process.platform): string {
  quotable(root, "config root", platform);
  return `node "${slashes(launcherPath(root, platform), platform)}"`;
}

// The bytes depend only on the platform, the config root and the Node
// executable; the POSIX shim is written on Windows too, for Git Bash.
export function renderLauncher(input: LauncherInput): LauncherFile[] {
  const { platform } = input;
  const node = slashes(quotable(input.nodeExecutable, "Node executable", platform), platform);
  const script = slashes(launcherPath(quotable(input.configRoot, "config root", platform), platform), platform);
  const files: LauncherFile[] = [
    { name: "kherep-node", content: posixShim(node, script), mode: 0o700 },
    { name: LAUNCHER_FILE, content: LAUNCHER_SCRIPT, mode: 0o600 },
  ];
  if (platform === "win32") {
    files.push({ name: "kherep-node.cmd", content: cmdShim(input.nodeExecutable), mode: 0o600 },
      { name: "kherep-node.ps1", content: ps1Shim(input.nodeExecutable), mode: 0o600 });
  }
  return files.sort((left, right) => (left.name < right.name ? -1 : 1));
}

function current(file: string): { bytes: Buffer; mode: number } | null {
  try { return { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Content-addressed and idempotent: a file is replaced (temporary file, then
// rename) only when its bytes or, outside Windows, its mode differ.
export function ensureLauncher(root: string, options: Omit<LauncherInput, "configRoot">):
  { status: LauncherStatus; written: string[] } {
  const files = renderLauncher({ ...options, configRoot: root });
  const dir = path.join(root, "bin");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const file of files) {
    const target = path.join(dir, file.name);
    const existing = current(target);
    const bytes = Buffer.from(file.content, "utf8");
    if (existing && Buffer.compare(existing.bytes, bytes) === 0 && (process.platform === "win32" || existing.mode === file.mode)) continue;
    const temp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, bytes, { mode: file.mode });
      fs.chmodSync(temp, file.mode);
      fs.renameSync(temp, target);
    } finally { fs.rmSync(temp, { force: true }); }
    written.push(file.name);
  }
  return { status: written.length > 0 ? "written" : "unchanged", written };
}

const hostIo: LauncherIo = {
  path,
  readFile: file => fs.readFileSync(file, "utf8"),
  isFile: (file) => { try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; } },
};

interface ReceiptShape { version?: unknown; binding?: { nodeExecutable?: unknown; source?: Record<string, unknown> } }

// What the generated launcher resolves, step for step (launcher-template.mts):
// a subset of the service receipt validation, then the pin's manifest and CLI.
export function resolveLauncher(root: string, io: LauncherIo = hostIo): LauncherResolution {
  const receipt = io.path.join(root, "control-plane", "service", "receipt.json");
  const fail = (reason: LauncherFailure): LauncherResolution => ({ ok: false, reason, receipt });
  let value: ReceiptShape;
  try { value = JSON.parse(io.readFile(receipt)) as ReceiptShape; } catch (error) {
    return fail((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid");
  }
  const node = value?.binding?.nodeExecutable;
  const source = value?.binding?.source;
  const pin = source?.root;
  if (value?.version !== 1 || source?.kind !== "pin" || source.verified !== true
    || typeof pin !== "string" || !io.path.isAbsolute(pin) || typeof node !== "string" || !io.path.isAbsolute(node)
    || typeof source.commit !== "string" || !PIN_COMMIT.test(source.commit)) return fail("invalid");
  if (!io.isFile(io.path.join(pin, ".kherep-source.json"))) return fail("missing-pin");
  const cli = io.path.join(pin, "modules", "control-plane", "node", "cli.mts");
  if (!io.isFile(cli)) return fail("missing-cli");
  return { ok: true, receipt, pin, cli, nodeExecutable: node };
}

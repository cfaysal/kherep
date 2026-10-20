import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHELL_TOOLS = new Set(["Bash", "shell_command", "exec_command", "functions.exec"]);
const PATCH_TOOLS = new Set(["apply_patch", "Edit", "Write", "MultiEdit"]);

// A Codex hook payload as it arrives on stdin. tool_input is a string for
// functions.exec and apply_patch, an object for the shell and file tools.
export interface HookPayload {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: string;
  transcript_path?: string | null;
  [key: string]: unknown;
}

export function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "source", "code", "input", "patch"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(input);
}

function decodeStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try { return JSON.parse(literal); } catch { return ""; }
  }
  return literal.slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\");
}

export function shellCommandsFromExec(source: unknown): string[] {
  const commands: string[] = [];
  const pattern = /tools\.shell_command\s*\(\s*\{[\s\S]{0,500}?\bcommand\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const match of String(source || "").matchAll(pattern)) {
    const command = decodeStringLiteral(match[1]);
    if (command) commands.push(command);
  }
  return commands;
}

export function normalizeDeployApproval(payload: HookPayload): HookPayload {
  const input = payload.tool_input;
  const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof command !== "string") return payload;
  const powershell = /\$env:KHEREP_DEPLOY_AUTH\s*=\s*['"]approved['"]\s*;/i;
  if (!powershell.test(command)) return payload;
  return { ...payload, tool_input: { ...(input as Record<string, unknown>), command: `KHEREP_DEPLOY_AUTH=approved ${command}` } };
}

export function patchPaths(text: unknown, cwd?: string): string[] {
  const source = String(text || "").replace(/\\r\\n|\\n/g, "\n");
  const found: string[] = [];
  const pattern = /\*\*\* (?:Add|Update|Delete) File:\s*([^\r\n"']+)/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[1].trim().replace(/\\\\/g, "\\");
    const target = path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
    if (!found.includes(target)) found.push(target);
  }
  return found;
}

// Privacy checks need every actual target, including move destinations. Unlike
// the best-effort post-hook scanner, ambiguous patch headers fail closed.
function privacyPatchPaths(input: unknown, cwd?: string): string[] {
  if (typeof input !== "string") return [];
  const lines = input.trim().split(/\r?\n/);
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return [];
  const found = new Set<string>();
  let moveAllowed = false;
  for (const line of lines.slice(1, -1)) {
    const operation = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    let value: string;
    if (operation) {
      value = operation[2];
      moveAllowed = operation[1] === "Update";
    } else if (move && moveAllowed) {
      value = move[1];
      moveAllowed = false;
    } else {
      moveAllowed = false;
      if (line.startsWith("*** ") && line !== "*** End of File") return [];
      continue;
    }
    if (!value.trim() || /[\x00-\x1f]/.test(value)) return [];
    found.add(path.resolve(cwd || process.cwd(), value));
  }
  return [...found];
}

export function normalizePayloads(payload: HookPayload, phase = "pre"): HookPayload[] {
  const tool = String(payload.tool_name || "");
  const text = inputText(payload.tool_input);
  if (tool === "apply_patch" && phase === "pre-privacy") {
    const input = payload.tool_input;
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const rawPatch = typeof input === "string" ? input : record.input ?? record.patch ?? record.command;
    const paths = privacyPatchPaths(rawPatch, payload.cwd);
    if (!paths.length) return [{ ...payload, tool_name: "Edit", tool_input: { original_input: input } }];
    return paths.map((filePath) => ({
      ...payload, tool_name: "Edit",
      tool_input: { file_path: filePath, new_string: String(rawPatch).replace(/^[+-]/gm, ""), original_input: input },
    }));
  }
  if (phase === "post" && (PATCH_TOOLS.has(tool) || tool === "functions.exec")) {
    const paths = patchPaths(text, payload.cwd);
    if (paths.length) return paths.map((filePath) => ({
      ...payload,
      tool_name: "Edit",
      tool_input: { file_path: filePath, new_string: text },
    }));
  }
  if (SHELL_TOOLS.has(tool)) {
    let commands = tool === "functions.exec" ? shellCommandsFromExec(text) : [];
    if (tool === "functions.exec" && phase === "pre-privacy") {
      const toolCallCount = (text.match(/\btools\.[A-Za-z0-9_]+/g) || []).length;
      if (commands.length !== 1 || toolCallCount !== 1) commands = [];
    }
    const base = typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {};
    return (commands.length ? commands : [text]).map((command) => ({
      ...payload,
      tool_name: "Bash",
      tool_input: { ...base, command },
    }));
  }
  if (PATCH_TOOLS.has(tool)) return [{ ...payload, tool_name: tool === "apply_patch" ? "Edit" : tool }];
  if (["spawn_agent", "Agent", "Task"].includes(tool)) return [{ ...payload, tool_name: "Agent" }];
  return [payload];
}

// Issue #258. Codex blocks a PreToolUse call on exit 2 with a stderr reason, or
// on exit 0 with this JSON on stdout; anything else is a non-blocking failure.
// On Windows Codex runs commandWindows under pwsh, which reports a native exit 2
// as 1, so a guard's exit 2 reaches Codex only as this JSON.
// Issue #507, part 3: in a PreToolUse phase a guard that cannot run is a deny naming
// the file (missing, empty, no regular file, spawn failed or threw, killed, past its
// budget and then killed with SIGKILL, no budget left, exit other than 0 or 2, over
// 1 MiB of output, stdout that is no decision); a printed "ask", which Codex parses
// but does not support, is a deny. PostToolUse phases run exactly as before.
const PRE_TOOL_USE_PHASES = new Set(["pre", "pre-no-transcript", "pre-privacy"]);

// One integer clock from this process's start, SAFETY_MARGIN_MS before the `timeout = 10`
// of both rendered pre-privacy entries (a test pins it). spawnSync throws on a fractional
// timeout (ERR_OUT_OF_RANGE, measured on Node 26.10), so every budget is an integer.
const HOOK_TIMEOUT_MS = 10_000;
const SAFETY_MARGIN_MS = 1_500;
const START = Math.floor(Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now());
const DEADLINE = START + HOOK_TIMEOUT_MS - SAFETY_MARGIN_MS;
const remaining = (): number => Math.max(0, DEADLINE - Date.now());
const GUARD_TIMEOUT_MS = 5_000;
const MIN_SPAWN_MS = 100; // a spawn costs about 85 ms; with less left none is started
// A re-check gets <= RECHECK_MAX_MS of what is left, none below RECHECK_MIN_MS; its lib loads within RECHECK_LOAD_MS.
const RECHECK_MAX_MS = 6_000, RECHECK_MIN_MS = 1_000, RECHECK_LOAD_MS = 2_000;
const HEARTBEAT_WINDOW_MS = 1_800_000; // = claude/hooks/lib/integrity-heartbeat.mts
const SELF = path.resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
const INVOKED_DIR = path.dirname(SELF);

const DECISIONS = ["deny", "ask", "allow"] as const;
type Decision = typeof DECISIONS[number];
// No decision: a plain allow or a notice only. `broken`: the guard file could not run (a re-check follows).
// `system`: the guard's top-level systemMessage (issue #507, part 4).
interface Verdict { decision?: Decision; reason: string; notice?: string; system?: string; broken?: boolean }
type Spawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
// guardArgs reach the guard after its path; deadline is an absolute end (ms since the epoch); spawn is a test seam.
export interface AdaptedOptions { guardArgs?: string[]; deadline?: number; spawn?: Spawn }
export interface AdaptedResult { stdout: string; stderr: string; status: number; broken?: boolean }

const failure = (file: string, why: string, broken = true): Verdict => ({ decision: "deny", broken,
  reason: `[hook-adapter] ${file} cannot run (${why}); the tool call is blocked until hook integrity restores it`,
});
const firstLine = (error: unknown): string => String((error as Error)?.message || error).split(/\r?\n/)[0];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Why the file cannot be run, or undefined when it can.
function unrunnable(file: string): string | undefined {
  if (!path.isAbsolute(file)) return "path is not absolute";
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : `stat failed: ${code ?? String(error)}`;
  }
  if (!stat.isFile()) return "not a regular file";
  if (stat.size === 0) return "empty, 0 bytes";
  return undefined;
}

const NOT_DECISION = "stdout is not a PreToolUse decision";
const FIELDS = ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext"];

// The first decision field with a value Codex would reject or drop, or undefined.
function invalidField({ permissionDecision, permissionDecisionReason, additionalContext }: Record<string, unknown>): string | undefined {
  if (permissionDecision !== undefined && !DECISIONS.includes(permissionDecision as Decision)) return "permissionDecision";
  // A reason without a decision would be dropped.
  if (permissionDecisionReason !== undefined && (typeof permissionDecisionReason !== "string" || !permissionDecision)) return "permissionDecisionReason";
  if (additionalContext !== undefined && (typeof additionalContext !== "string" || !additionalContext)) return "additionalContext";
  return undefined;
}

// The verdict a guard printed on exit 0, or why stdout is not the accepted shape
// (claude/hooks/guard-dispatch.mts): a field that would be dropped fails.
function printed(stdout: string): Verdict | string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return NOT_DECISION; }
  if (!isObject(parsed) || !isObject(parsed.hookSpecificOutput)) return NOT_DECISION;
  const output = parsed.hookSpecificOutput;
  if (output.hookEventName !== "PreToolUse") return NOT_DECISION;
  const extra = Object.keys(parsed).find((key) => key !== "hookSpecificOutput" && key !== "systemMessage")
    ?? Object.keys(output).find((key) => !FIELDS.includes(key));
  if (extra !== undefined) return `${NOT_DECISION} (unsupported field ${extra || '""'})`;
  // Issue #507, part 4. Codex documents a top-level systemMessage for PreToolUse: a non-empty string passes through.
  const { systemMessage } = parsed;
  if (systemMessage !== undefined && (typeof systemMessage !== "string" || !systemMessage)) return `${NOT_DECISION} (invalid field systemMessage)`;
  const invalid = invalidField(output);
  if (invalid) return `${NOT_DECISION} (invalid field ${invalid})`;
  const { permissionDecision, permissionDecisionReason, additionalContext } = output;
  if (permissionDecision === undefined && additionalContext === undefined) return NOT_DECISION;
  return { decision: permissionDecision as Decision | undefined, reason: (permissionDecisionReason as string | undefined) ?? "",
    ...(additionalContext ? { notice: additionalContext as string } : {}), ...(systemMessage ? { system: systemMessage as string } : {}) };
}

// error first: a grandchild that holds the pipe leaves status 0 with ETIMEDOUT.
function judge(file: string, result: SpawnSyncReturns<string>, budget: number): Verdict {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return failure(file, `timed out after ${(budget / 1000).toFixed(1)} s`);
    if (code === "ENOBUFS") return failure(file, "output exceeded the 1 MiB buffer");
    return failure(file, `spawn failed (${code ?? "unknown"})`);
  }
  if (result.signal) return failure(file, `killed by ${result.signal}`);
  if (result.status === 2) {
    return { decision: "deny", reason: result.stderr.trim() || `${path.basename(file)} blocked this tool call without giving a reason.` };
  }
  if (result.status !== 0) return failure(file, `exit code ${result.status}`);
  if (!result.stdout.trim()) return { reason: "" };
  const shown = printed(result.stdout);
  if (typeof shown === "string") return failure(file, shown);
  return shown.decision === "ask"
    ? { ...shown, decision: "deny", reason: `${file} asked for confirmation; Codex has no ask, so the call is denied` } : shown;
}

// The strongest decision with its reasons, plus every notice in order.
function combine(verdicts: Verdict[]): Verdict | undefined {
  const decision = DECISIONS.find((candidate) => verdicts.some((verdict) => verdict.decision === candidate));
  const reason = verdicts.filter((verdict) => decision && verdict.decision === decision)
    .map((verdict) => verdict.reason).filter(Boolean).join("\n");
  const notice = verdicts.map((verdict) => verdict.notice).filter(Boolean).join("\n");
  const system = verdicts.map((verdict) => verdict.system).filter(Boolean).join("\n");
  if (!decision && !notice) return undefined;
  return { decision, reason, ...(notice ? { notice } : {}), ...(system ? { system } : {}) };
}

const render = (verdict: Verdict | undefined, top: Record<string, string> = {}): string => verdict ? JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", ...(verdict.decision ? { permissionDecision: verdict.decision } : {}),
    ...(verdict.reason ? { permissionDecisionReason: verdict.reason } : {}), ...(verdict.notice ? { additionalContext: verdict.notice } : {}) },
  ...(verdict.system ? { systemMessage: verdict.system } : {}), ...top }) : "";

// The budget of one guard item: an integer, whatever the clock's fraction.
export const budgetFor = (capEnd: number, hardEnd: number, now: number): number => Math.floor(Math.min(capEnd, hardEnd) - now);

// Every item of a PreToolUse phase within one budget; the first deny ends the loop.
function preToolUse(target: string, phase: string, payload: HookPayload, timeoutMs: number | undefined,
  options: AdaptedOptions): { verdict?: Verdict; stderr: string; broken: boolean } {
  const why = unrunnable(target);
  if (why) return { verdict: failure(target, why), stderr: "", broken: true };
  const begin = Date.now();
  const capEnd = timeoutMs === undefined ? Infinity : begin + timeoutMs;
  const hardEnd = options.deadline ?? Infinity;
  const items = normalizePayloads(payload, phase);
  const verdicts: Verdict[] = [];
  let stderr = "";
  for (const [index, item] of items.entries()) {
    const normalized = phase === "pre-no-transcript" ? normalizeDeployApproval({ ...item, transcript_path: null }) : item;
    const budget = budgetFor(capEnd, hardEnd, Date.now());
    let verdict: Verdict;
    if (budget < MIN_SPAWN_MS) {
      verdict = failure(target, `budget exhausted before item ${index + 1} of ${items.length} (${Date.now() - begin} ms used)`, false);
    } else {
      try {
        // Node 22/24 print a type-stripping ExperimentalWarning for an .mts guard on stderr.
        const result = (options.spawn ?? spawnSync)(process.execPath, ["--disable-warning=ExperimentalWarning", target, ...(options.guardArgs ?? [])],
          { encoding: "utf8", input: JSON.stringify(normalized), windowsHide: true, timeout: budget, killSignal: "SIGKILL" });
        stderr += result.stderr ?? "";
        verdict = judge(target, result, budget);
      } catch (error) {
        // Option validation or anything else Node throws before the child exists: no file fault.
        verdict = failure(target, `spawn threw (${(error as NodeJS.ErrnoException)?.code ?? "unknown"}: ${firstLine(error)})`, false);
      }
    }
    verdicts.push(verdict);
    if (verdict.decision === "deny") break;
  }
  return { verdict: combine(verdicts), stderr, broken: verdicts.some((verdict) => verdict.broken) };
}

// The PostToolUse loop as before #507 part 3: no kill signal, no guard arguments, status passed through.
function postToolUse(target: string, phase: string, payload: HookPayload, timeoutMs?: number): AdaptedResult {
  let held = "";
  let stderr = "";
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  for (const item of normalizePayloads(payload, phase)) {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", target], { encoding: "utf8",
      input: JSON.stringify(item), windowsHide: true, ...(deadline === undefined ? {} : { timeout: Math.max(1, deadline - Date.now()) }) });
    if (result.stdout) held += result.stdout;
    if (result.stderr) stderr += result.stderr;
    if (result.error || result.signal || result.status !== 0) return { stdout: held, stderr, status: result.status || 1 };
  }
  return { stdout: held, stderr, status: 0 };
}

// Also used by the shell dispatcher: reuse the exact normalization and guard
// invocation without starting one adapter process per guard. A PreToolUse
// result has status 0 and at most one decision document on stdout.
export function runAdaptedHook(target: string, phase: string, payload: HookPayload, timeoutMs?: number,
  options: AdaptedOptions = {}): AdaptedResult {
  if (!PRE_TOOL_USE_PHASES.has(phase)) return postToolUse(target, phase, payload, timeoutMs);
  const { verdict, stderr, broken } = preToolUse(target, phase, payload, timeoutMs, options);
  return { stdout: render(verdict), stderr, status: 0, broken };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const ms = remaining();
    const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error(`stdin not closed within ${ms} ms`)); }, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

// `work`, or `late()` after ms; the timer keeps the process alive meanwhile.
function within<T, L>(work: Promise<T>, ms: number, late: () => L): Promise<T | L> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<L>((resolve) => { timer = setTimeout(() => resolve(late()), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

type RecheckLib = typeof import("../../claude/hooks/lib/guard-recheck.mts");

// Issue #507, part 4. A peer dispatcher is proven only as the bytes the last integrity run judged:
// that run records each dispatcher file's (dev, ino, size, mtimeNs) from an fd-bound snapshot in
// heartbeat.json "peers" (lib/integrity-heartbeat.mts provenPeer). Any difference, no record, or a
// peer that cannot run is a guard failure: the re-check parses and restores it; this process
// compares one bigint stat with the record and parses nothing.
const PEER_FIELDS = [["ino", "inode"], ["dev", "device"], ["size", "size"], ["mtimeNs", "mtime"]] as const;
function recordedPeers(home: string): Record<string, unknown> | undefined {
  try {
    const { peers } = JSON.parse(fs.readFileSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json"), "utf8")) as { peers?: unknown };
    return isObject(peers) ? peers : undefined;
  } catch { return undefined; }
}
function peerDrift(file: string, peers: Record<string, unknown> | undefined): string | undefined {
  const record = peers?.[path.basename(file)];
  if (!isObject(record)) return "no proven record";
  let stat: fs.BigIntStats;
  try { stat = fs.statSync(file, { bigint: true }); } catch (error) { return `stat failed: ${(error as NodeJS.ErrnoException).code ?? String(error)}`; }
  const changed = PEER_FIELDS.find(([key]) => record[key] !== String(stat[key]));
  return changed && `${changed[1]} changed since the last proven check`;
}

// The hook integrity re-check notice, or undefined; never a decision. Only the
// installed copy (<home>/hooks/kherep-maestro) re-checks, through the installed
// lib/guard-recheck.mts and codex-hook-integrity.mts beside it; no environment
// variable is read. The shell dispatcher, which no hook checks for itself, is
// checked first; a line about it heads the notice.
async function recheck(payload: string, broken: boolean): Promise<string | undefined> {
  if (path.basename(INVOKED_DIR) !== "kherep-maestro" || path.basename(path.dirname(INVOKED_DIR)) !== "hooks") return undefined;
  const home = path.dirname(path.dirname(INVOKED_DIR));
  const peer = path.join(INVOKED_DIR, "codex-shell-checks.mts");
  const drift = unrunnable(peer) ?? peerDrift(peer, recordedPeers(home));
  const notice = await recheckRun(home, payload, broken || drift !== undefined)
    .catch((error) => `hook integrity re-check unavailable (lib/guard-recheck.mts cannot be loaded: ${firstLine(error)})`);
  return drift ? `${peer} cannot be trusted (${drift})\n${notice}` : notice;
}

// A broken lib throws here or at its first call.
async function recheckRun(home: string, payload: string, broken: boolean): Promise<string | undefined> {
  const loadMs = Math.min(RECHECK_LOAD_MS, remaining());
  const lib = await within(import(pathToFileURL(path.join(INVOKED_DIR, "lib", "guard-recheck.mts")).href) as Promise<RecheckLib>,
    loadMs, () => undefined);
  if (!lib) return `hook integrity re-check unavailable (lib/guard-recheck.mts did not load within ${loadMs} ms)`;
  const { stale, lastOk } = lib.heartbeatState(home, HEARTBEAT_WINDOW_MS);
  if (!stale && !broken) return undefined;
  const context = { why: !stale ? "guard failure" : lastOk ? "stale heartbeat" : "no heartbeat", lastOk };
  const script = path.join(INVOKED_DIR, "codex-hook-integrity.mts");
  const why = unrunnable(script);
  if (why) return lib.recheckNotice(context, [`${script} cannot run (${why})`]);
  const budgetMs = Math.max(0, Math.min(RECHECK_MAX_MS, remaining() - 250));
  if (budgetMs < RECHECK_MIN_MS) return lib.recheckNotice(context, [`skipped, ${budgetMs} ms left of the hook budget; the next matching call re-checks`]);
  return lib.runRecheck({ script, home, payload, budgetMs, ...context, trigger: "hook-adapter", env: { CODEX_HOME: home } });
}

// One document on stdout, the guards' stderr and the re-check block on stderr; exits
// once every write called back. The notice goes to additionalContext on an allow,
// to a top-level systemMessage on a deny, never into the decision.
function emit(verdict: Verdict | undefined, stderr: string, notice?: string): void {
  let doc: string;
  if (verdict?.decision === "deny") {
    const lines = notice ? notice.split("\n") : [];
    const integrity = notice ? `Kherep hook integrity: ${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} more)` : ""}` : "";
    // The guard's own systemMessage first, then the integrity line (issue #507, part 4).
    const systemMessage = [verdict.system, integrity].filter(Boolean).join("\n");
    doc = render(verdict, systemMessage ? { systemMessage } : {});
  } else {
    doc = render(notice ? combine([...(verdict ? [verdict] : []), { reason: "", notice }]) : verdict);
  }
  let pending = 0;
  const flushed = (): void => { if (--pending === 0) process.exit(0); };
  const put = (stream: NodeJS.WriteStream, text: string): void => { pending++; stream.write(text, flushed); };
  if (stderr) put(process.stderr, stderr);
  if (notice) put(process.stderr, `${notice}\n`);
  if (doc) put(process.stdout, doc);
  if (pending === 0) process.exit(0);
}

// PostToolUse phases: as before #507 part 3.
function postMain(target: string | undefined, phase: string): void {
  if (!target || !path.isAbsolute(target)) return;
  let payload: HookPayload;
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
  const result = runAdaptedHook(target, phase, payload);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}

async function main(target: string | undefined, phase: string): Promise<void> {
  if (!target) return emit(failure(SELF, "no guard given"), "");
  if (!path.isAbsolute(target)) return emit(failure(SELF, "guard path is not absolute"), "");
  let raw: string;
  try { raw = await readStdin(); } catch (error) { return emit(failure(SELF, firstLine(error)), ""); }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { /* not JSON */ }
  if (!isObject(payload)) return emit(failure(SELF, "stdin is not a JSON object"), "");
  const result = preToolUse(target, phase, payload as HookPayload, Math.min(GUARD_TIMEOUT_MS, remaining()),
    { guardArgs: process.argv.slice(4), deadline: DEADLINE });
  const notice = await within(recheck(raw, result.broken), remaining(),
    () => "hook integrity re-check unavailable (no result before the hook deadline)");
  emit(result.verdict, result.stderr, notice);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const target = process.argv[2];
  const phase = process.argv[3] || "pre";
  if (!PRE_TOOL_USE_PHASES.has(phase)) postMain(target, phase);
  else main(target, phase).catch((error: unknown) => emit(failure(SELF, `internal error: ${firstLine(error)}`), ""));
}

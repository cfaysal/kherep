#!/usr/bin/env node
// The native entry of every managed Claude hook (issue #507, part 2):
//   node "<home>/kherep/hook-runtime/entry.mts" <pretool|reader|writer> "<home>/hooks/<main>" [args...]
//
// It lives outside the repaired hooks/ tree and imports node:* only, so no file
// it starts can break it. It runs the main as a real Node main with the same
// argv tail, cwd, environment and stdin bytes, behind a preload that admits the
// process to the hooks directory's coordination (coordinator.mts) before Node
// loads the main or its imports. The child reports "ready" over a private IPC
// channel; without that report nothing the child prints is accepted.
//
// pretool: a valid PreToolUse result, a silent allow and exit 2 pass through;
// anything else (no admission, a missing, empty or broken main, a signal, a
// timeout, an exit other than 0 or 2, output that is no PreToolUse decision)
// becomes a deny that names the main, printed before Claude Code's 30 s cancel.
// When the main itself could not run, one integrity writer may repair it for
// the next call; this call stays denied. reader/writer (every other event): the
// child's output and exit code pass through; a child that was not admitted ends
// with a fixed line on stderr and exit 1, never with a PreToolUse decision.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROTOCOL = 1;
const START = Date.now();
// The dispatcher's own deadline (25 s) ends first; this one stays below the 30 s cancel.
const CHILD_DEADLINE = START + 25_000;
const OUTER_DEADLINE = START + 28_000;
const COORDINATOR = new URL("./coordinator.mts", import.meta.url).href;
const MODES = ["pretool", "reader", "writer"] as const;
type Mode = typeof MODES[number];
interface Config { v: number; mode: "reader" | "writer"; root: string; target: string; deadline: number }
// The hooks directory of this installation (coordinator.mts derives the same one and refuses any other).
const HOOKS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");
interface Result { ready: boolean; code: number | null; signal: string | null; stdout: string; stderr: string; why?: string }

// Drops exactly the runtime's own experimental warnings (node:sqlite, type stripping of
// its .mts files) and hands every other warning to Node's own listeners. Node prints a
// warning on a later tick, so this also catches the one this process's load emitted.
const QUIET = "{const q=new Set([\"SQLite is an experimental feature and might change at any time\",\"Type Stripping is an "
  + "experimental feature and might change at any time\"]),d=process.listeners(\"warning\");process.removeAllListeners("
  + "\"warning\");process.on(\"warning\",w=>{if(!(w&&w.name===\"ExperimentalWarning\"&&q.has(w.message)))for(const l "
  + "of d)l.call(process,w)})}";
// The entry's own type-stripping warning, emitted while Node loaded this file, is dropped the same way.
const RUNTIME_WARNINGS = new Set(["SQLite is an experimental feature and might change at any time",
  "Type Stripping is an experimental feature and might change at any time"]);
const NODE_WARNING_LISTENERS = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && RUNTIME_WARNINGS.has(warning.message)) return;
  for (const listener of NODE_WARNING_LISTENERS) listener.call(process, warning);
});

// Identical in coordinator.mts (a test compares them): the --import argument that admits a node process.
export function preloadArg(coordinatorUrl: string, config: Config): string {
  const program = `${QUIET}try{const m=await import(${JSON.stringify(coordinatorUrl)});await m.preload(${JSON.stringify(config)})}`
    + "catch(e){const k=e&&e.kherepKind;process.stderr.write(\"[hook-runtime] not admitted (\"+(typeof k===\"string\"&&"
    + "/^[a-z-]{1,24}$/.test(k)?k:\"bootstrap failed\")+\")\\n\");process.exit(70)}";
  return `--import=data:text/javascript,${encodeURIComponent(program)}`;
}

function readStdin(until: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = Number.isFinite(until) ? setTimeout(() => { process.stdin.destroy(); resolve(null); }, Math.max(0, until - Date.now())) : undefined;
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

// Runs one admitted child. Resolves at the latest at `until`; a child still
// running then is killed and not waited for (its own lock ends with it).
function runChild(config: Config, args: string[], input: Buffer, until: number | null,
  childEnv: NodeJS.ProcessEnv = process.env): Promise<Result> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let ready = false;
    let done = false;
    const settle = (code: number | null, signal: string | null, why?: string): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ ready, code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), why });
    };
    const child = spawn(process.execPath, [preloadArg(COORDINATOR, config), config.target, ...args],
      { stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true, env: childEnv });
    const timer = until === null ? null : setTimeout(() => {
      settle(null, null, `timed out after ${Math.round((until - START) / 1000)} s`);
      child.kill("SIGKILL");
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      child.disconnect?.();
    }, Math.max(0, until - Date.now()));
    child.on("message", (message: { kherep?: unknown; v?: unknown; pid?: unknown }) => {
      if (message?.kherep === "ready" && message.v === PROTOCOL && message.pid === child.pid) ready = true;
    });
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => settle(null, null, `spawn failed (${(error as NodeJS.ErrnoException).code ?? "unknown"})`));
    child.on("close", (code, signal) => settle(code, signal));
    child.stdin!.on("error", () => {});
    child.stdin!.end(input);
  });
}

const FIELDS = ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext"];
const DECISIONS = ["deny", "ask", "allow"];

// The child's stdout as the accepted PreToolUse shape, or why it is not.
function preToolShape(stdout: string): string {
  let parsed: { hookSpecificOutput?: Record<string, unknown> } & Record<string, unknown>;
  try { parsed = JSON.parse(stdout); } catch { return "stdout is not a PreToolUse decision"; }
  const output = parsed?.hookSpecificOutput;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !output || typeof output !== "object" || Array.isArray(output)
    || Object.keys(parsed).some((key) => key !== "hookSpecificOutput") || Object.keys(output).some((key) => !FIELDS.includes(key))
    || output.hookEventName !== "PreToolUse") return "stdout is not a PreToolUse decision";
  const { permissionDecision: decision, permissionDecisionReason: reason, additionalContext: context } = output;
  if (decision !== undefined && !DECISIONS.includes(decision as string)) return "stdout has an invalid permissionDecision";
  if (reason !== undefined && (typeof reason !== "string" || decision === undefined)) return "stdout has an invalid permissionDecisionReason";
  if (context !== undefined && (typeof context !== "string" || !context)) return "stdout has an invalid additionalContext";
  return decision === undefined && context === undefined ? "stdout is not a PreToolUse decision" : "";
}

// Why the child did not run to a usable end, or "" when it did.
function failureOf(result: Result): { why: string; mainFailed: boolean } {
  if (result.why) return { why: result.why, mainFailed: false };
  if (!result.ready) {
    const kind = /\[hook-runtime\] not admitted \(([a-z -]+)\)/.exec(result.stderr)?.[1] ?? "it ended before admission";
    return { why: `not admitted: ${kind}`, mainFailed: kind === "main-missing" || kind === "main-empty" };
  }
  if (result.signal) return { why: `killed by ${result.signal}`, mainFailed: true };
  if (result.code !== 0 && result.code !== 2) return { why: `exit code ${result.code}`, mainFailed: true };
  return { why: "", mainFailed: false };
}

// Writes what is given, then exits once every used stream took its bytes.
function finish(stdout: string, stderr: string, code: number): void {
  let pending = 0;
  const flushed = (): void => { if (--pending === 0) process.exit(code); };
  for (const [stream, text] of [[process.stderr, stderr], [process.stdout, stdout]] as const) {
    if (text) { pending++; stream.write(text, flushed); }
  }
  if (pending === 0) process.exit(code);
}

const deny = (reason: string, context = ""): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "deny", permissionDecisionReason: reason, ...(context ? { additionalContext: context } : {}) } });

// A main as diagnostics name it: its path inside the hooks directory, else its file name.
// Reasons reach the model, so no absolute path and no raw error text goes into them.
function labelOf(target: string): string {
  const rel = path.relative(HOOKS_ROOT, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : path.basename(target);
}

// The one integrity writer a broken PreToolUse main may start, within what is left.
async function repairAttempt(input: Buffer): Promise<string> {
  const script = path.join(HOOKS_ROOT, "live-hook-integrity.mts");
  if (Date.now() > OUTER_DEADLINE - 2000 || !fs.existsSync(script)) return "";
  // Its home is this installation's, as the dispatcher passes it: Claude Code sets no CLAUDE_HOME.
  const result = await runChild({ v: PROTOCOL, mode: "writer", root: HOOKS_ROOT, target: script, deadline: OUTER_DEADLINE - 500 },
    ["--trigger", "hook-entry"], input, OUTER_DEADLINE - 500, { ...process.env, CLAUDE_HOME: path.dirname(HOOKS_ROOT) });
  const lines = result.ready ? result.stdout.split(/\r?\n/).filter((line) => line.trim()) : [];
  const status = failureOf(result).why;
  return `hook integrity re-check (hook entry):\n${[...lines, ...(status ? [status] : [])].map((line) => `  - ${line}`).join("\n")}`;
}

// The cap of one journal step: limit, cut so that it ends by end; a test pins its use in journalDeny.
export const capBefore = (limit: number, end: number, now = Date.now()): number => Math.max(0, Math.min(limit, end - now));

// `work` settled within ms: true when it resolved, false when it failed or the time ran out.
function settled(work: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); });
  return Promise.race([Promise.resolve().then(work).then(() => true, () => false), late]).finally(() => clearTimeout(timer));
}

// Issue #504: a deny of a delegated run's call (valid agent_id, not the handback) goes to the
// denied-call journal of this home with the fixed reason only, else a marker, before OUTER_DEADLINE - 200.
// The marker write is awaited until OUTER_DEADLINE - 2_000, not a fixed 400 ms slice (issue #614): finish()
// exits through process.exit, which abandons a pending fs.promises write, so a slow write left no marker.
// The 2 s before OUTER_DEADLINE widen the deny's margin before the 30 s cancel: losing a deny is worse.
async function journalDeny(input: Buffer, reason: string): Promise<void> {
  if (input.length > 1_048_576) return; // no unbounded parse on the deny path
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(input.toString("utf8")); } catch { return; }
  const id = payload?.agent_id, tool = payload?.tool_name, end = OUTER_DEADLINE - 200;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || tool === "SubagentHandback") return;
  const dir = path.join(path.dirname(HOOKS_ROOT), ".cache", "denied-calls"), base = path.join(dir, id);
  const line = JSON.stringify({ v: 1, kind: "entry-deny", at: new Date().toISOString(),
    id: typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 128) : null, tool: typeof tool === "string" ? tool.slice(0, 80) : null, reason });
  if (await settled(() => fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => fs.promises.appendFile(`${base}.jsonl`, `${line}\n`, { mode: 0o600 })), capBefore(500, end))) return;
  await settled(() => fs.promises.appendFile(`${base}.failed`, "append\n", { mode: 0o600 })
    .catch(() => fs.promises.rename(`${base}.jsonl`, `${base}.failed`)), OUTER_DEADLINE - 2_000 - Date.now());
}

async function main(): Promise<void> {
  const [modeArg, targetArg, ...rest] = process.argv.slice(2);
  const mode = MODES.find((candidate) => candidate === modeArg) as Mode | undefined;
  const pretool = mode === "pretool";
  if (!mode || !targetArg) {
    const why = "[hook-entry] usage: entry.mts <pretool|reader|writer> <main> [args...]";
    return pretool ? finish(deny(why), "", 0) : finish("", `${why}\n`, 1);
  }
  const target = path.resolve(targetArg);
  const input = await readStdin(pretool ? OUTER_DEADLINE - 1000 : Number.POSITIVE_INFINITY);
  const label = labelOf(target);
  const blocked = (why: string): string => `[hook-entry] ${label} cannot run (${why}); the tool call is blocked until hook integrity restores it`;
  if (input === null) return pretool ? finish(deny(blocked("stdin not closed in time")), "", 0) : finish("", "[hook-entry] stdin unreadable\n", 1);
  const config: Config = { v: PROTOCOL, mode: mode === "writer" ? "writer" : "reader", root: HOOKS_ROOT, target,
    deadline: pretool ? CHILD_DEADLINE : START + 600_000 };
  const result = await runChild(config, rest, input, pretool ? OUTER_DEADLINE - 600 : null);
  const failure = failureOf(result);
  if (!pretool) {
    if (!result.ready) return finish("", `[hook-entry] ${label} ${failure.why}\n`, 1);
    return finish(result.stdout, result.stderr, result.signal ? 1 : result.code ?? 1);
  }
  if (!failure.why && result.code === 2) return finish("", result.stderr, 2);
  const shape = failure.why || !result.stdout.trim() ? "" : preToolShape(result.stdout);
  if (!failure.why && !shape) return finish(result.stdout, result.stderr, 0);
  const context = failure.mainFailed ? await repairAttempt(input) : "";
  await journalDeny(input, blocked(failure.why || shape));
  finish(deny(blocked(failure.why || shape), context), result.ready ? result.stderr : "", 0);
}

// Imported (a test compares preloadArg) it does nothing; run as the main it is the hook.
const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
const real = (file: string): string => { try { return fs.realpathSync(file); } catch { return file; } };
// An internal error is a deny only for PreToolUse; any other event gets the fixed line and exit 1.
if (invoked && real(invoked) === real(self)) main().catch(() => (process.argv[2] === "pretool"
  ? finish(deny("[hook-entry] internal error; the tool call is blocked"), "", 0) : finish("", "[hook-entry] internal error\n", 1)));

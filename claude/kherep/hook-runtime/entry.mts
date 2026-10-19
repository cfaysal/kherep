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

const PROTOCOL = 1;
const START = Date.now();
// The dispatcher's own deadline (25 s) ends first; this one stays below the 30 s cancel.
const CHILD_DEADLINE = START + 25_000;
const OUTER_DEADLINE = START + 28_000;
const COORDINATOR = new URL("./coordinator.mts", import.meta.url).href;
const MODES = ["pretool", "reader", "writer"] as const;
type Mode = typeof MODES[number];
interface Config { v: number; mode: "reader" | "writer"; target: string; deadline: number }
interface Result { ready: boolean; code: number | null; signal: string | null; stdout: string; stderr: string; why?: string }

// Identical in coordinator.mts (a test compares them): the --import argument that admits a node process.
export function preloadArg(coordinatorUrl: string, config: Config): string {
  const program = `try{const m=await import(${JSON.stringify(coordinatorUrl)});await m.preload(${JSON.stringify(config)})}`
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
function runChild(config: Config, args: string[], input: Buffer, until: number | null): Promise<Result> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let ready = false;
    let done = false;
    const finish = (code: number | null, signal: string | null, why?: string): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ ready, code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), why });
    };
    const child = spawn(process.execPath, [preloadArg(COORDINATOR, config), config.target, ...args],
      { stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    const timer = until === null ? null : setTimeout(() => {
      finish(null, null, `timed out after ${Math.round((until - START) / 1000)} s`);
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
    child.on("error", (error) => finish(null, null, `spawn failed: ${error.message}`));
    child.on("close", (code, signal) => finish(code, signal));
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
    const kind = /\[hook-runtime\] not admitted \(([a-z-]+)\)/.exec(result.stderr)?.[1] ?? "it ended before admission";
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

// The one integrity writer a broken PreToolUse main may start, within what is left.
async function repairAttempt(target: string, input: Buffer): Promise<string> {
  const script = path.join(path.dirname(target), "live-hook-integrity.mts");
  if (Date.now() > OUTER_DEADLINE - 2000 || !fs.existsSync(script)) return "";
  const result = await runChild({ v: PROTOCOL, mode: "writer", target: script, deadline: OUTER_DEADLINE - 500 },
    ["--trigger", "hook-entry"], input, OUTER_DEADLINE - 500);
  const lines = result.ready ? result.stdout.split(/\r?\n/).filter((line) => line.trim()) : [];
  const status = failureOf(result).why;
  return `hook integrity re-check (hook entry):\n${[...lines, ...(status ? [status] : [])].map((line) => `  - ${line}`).join("\n")}`;
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
  const blocked = (why: string): string => `[hook-entry] ${target} cannot run (${why}); the tool call is blocked until hook integrity restores it`;
  if (input === null) return pretool ? finish(deny(blocked("stdin not closed in time")), "", 0) : finish("", "[hook-entry] stdin unreadable\n", 1);
  const config: Config = { v: PROTOCOL, mode: mode === "writer" ? "writer" : "reader", target,
    deadline: pretool ? CHILD_DEADLINE : START + 600_000 };
  const result = await runChild(config, rest, input, pretool ? OUTER_DEADLINE - 600 : null);
  const failure = failureOf(result);
  if (!pretool) {
    if (failure.why && !result.ready) return finish("", `[hook-entry] ${target} ${failure.why}\n`, 1);
    return finish(result.stdout, result.stderr, result.signal ? 1 : result.code ?? 1);
  }
  if (!failure.why && result.code === 2) return finish("", result.stderr, 2);
  const shape = failure.why || !result.stdout.trim() ? "" : preToolShape(result.stdout);
  if (!failure.why && !shape) return finish(result.stdout, result.stderr, 0);
  const context = failure.mainFailed ? await repairAttempt(target, input) : "";
  finish(deny(blocked(failure.why || shape), context), result.ready ? result.stderr : "", 0);
}

main().catch(() => finish(deny("[hook-entry] internal error; the tool call is blocked"), "", 0));

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { stageClaudeClient } from "./claude-mcp-client.mts";
import { writeJsonAtomic } from "./inbox.mts";

// Shared fixture of the staged Claude intent hook tests (issue #657). Every
// wait ends on an event or on its own bound, never on a count of polls. Only
// the child's 'close' (process ended, stdio closed) counts as closed; 'error'
// events are evidence, since they also report failed kills. A fixture root is
// removed only after every hook started under it closed.

export interface HookClose { code: number | null; signal: NodeJS.Signals | null }

export interface HookRun {
  child: ChildProcess;
  startedAt: number; // performance.now() right before spawn: the origin of every elapsedMs
  stdout: Buffer[];
  stderr: Buffer[];
  errors: string[]; // child, stdin and kill errors
  exit: HookClose | null; // the 'exit' event
  close: HookClose | null; // the 'close' event
  closed: Promise<HookClose>; // resolves on 'close' only
}

export type Publication =
  | { kind: "published"; name: string; elapsedMs: number }
  | ({ kind: "exited"; elapsedMs: number } & HookClose)
  | { kind: "timeout"; boundMs: number; elapsedMs: number };

export type Closure = ({ kind: "closed" } & HookClose) | { kind: "timeout"; boundMs: number };

export interface OwnedRoot { root: string; runs: HookRun[] }

const SESSIONS_CALL = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
  session_id: "actual-session", tool_use_id: "actual-call", tool_input: { limit: 5 } };
const DIAGNOSTIC_CHARS = 4_000;

export const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");
const elapsedSince = (run: HookRun): number => Math.round(performance.now() - run.startedAt);

export function ownedRoot(t: TestContext, prefix: string): OwnedRoot {
  const owned: OwnedRoot = { root: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), runs: [] };
  t.after(() => removeWhenClosed(owned));
  return owned;
}

// A hook whose close was not observed may still write: its root is kept and the cleanup fails.
export function removeWhenClosed(owned: OwnedRoot): void {
  const open = owned.runs.filter((run) => run.close === null);
  if (open.length > 0) {
    throw new Error(`fixture kept at ${owned.root}: close not observed for hook pid `
      + `${open.map((run) => run.child.pid).join(", ")}`);
  }
  fs.rmSync(owned.root, { recursive: true, force: true });
}

// Stages the client, writes its policy and starts the staged hook. The run is
// owned and every listener attached before anything else can throw.
export function startStagedHook(opts: { outputRoot: string; clientRoot: string; configRoot: string;
  runs: HookRun[]; claudeCode?: boolean; preload?: string[] }): { run: HookRun; intents: string; receipts: string } {
  const { outputRoot, clientRoot, configRoot, runs, claudeCode = true, preload = [] } = opts;
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const state = path.join(configRoot, "control-plane");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "policy.json"), JSON.stringify({ version: 1, allowedCommands: [],
    remoteMcp: { enabled: true, claudeCode } }));
  const startedAt = performance.now();
  const child = spawn(process.execPath, [...preload.flatMap((url) => ["--import", url]),
    path.join(outputRoot, "control-plane/node/mcp-intent-hook.mts"), "--config-root", configRoot,
    "--runtime", "claude-code"], { stdio: ["pipe", "pipe", "pipe"] });
  const run: HookRun = { child, startedAt, stdout: [], stderr: [], errors: [], exit: null, close: null,
    closed: new Promise((resolve) => child.once("close", (code, signal) => {
      run.close = { code, signal };
      resolve(run.close);
    })) };
  runs.push(run);
  child.once("exit", (code, signal) => { run.exit = { code, signal }; });
  child.on("error", (error) => run.errors.push(`child: ${error.message}`));
  child.stdout?.on("data", (chunk: Buffer) => run.stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => run.stderr.push(chunk));
  // A hook that exits before reading its input yields EPIPE: recorded, not thrown.
  child.stdin?.on("error", (error) => run.errors.push(`stdin: ${error.message}`));
  try {
    child.stdin?.end(JSON.stringify(SESSIONS_CALL));
  } catch (error) {
    run.errors.push(`stdin: ${(error as Error).message}`);
  }
  return { run, intents: path.join(state, "mcp", "intents"), receipts: path.join(state, "mcp", "receipts") };
}

// The close, or null once ms passed without it. Never reports a timeout as closed.
async function closedWithin(run: HookRun, ms: number): Promise<HookClose | null> {
  let timer: NodeJS.Timeout | undefined;
  const close = await Promise.race([run.closed, new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  })]);
  clearTimeout(timer);
  return close;
}

// First of: a published intent, the hook's close, or the bound. Read before the
// scan, a close still lets an intent published right before it be found.
export async function awaitPublishedIntent(run: HookRun, intents: string,
  { pollMs = 10, boundMs = 30_000 } = {}): Promise<Publication> {
  const deadline = performance.now() + boundMs;
  for (;;) {
    const closed = run.close;
    const name = publishedName(intents);
    if (name) return { kind: "published", name, elapsedMs: elapsedSince(run) };
    if (closed) return { kind: "exited", ...closed, elapsedMs: elapsedSince(run) };
    if (performance.now() >= deadline) return { kind: "timeout", boundMs, elapsedMs: elapsedSince(run) };
    await closedWithin(run, Math.min(pollMs, deadline - performance.now()));
  }
}

function publishedName(intents: string): string {
  if (!fs.existsSync(intents)) return "";
  // Only a published intent; the hook's atomic write first creates a ".<id>.json.<uuid>.tmp" (issue #226).
  return fs.readdirSync(intents).find((name) => !name.startsWith(".") && name.endsWith(".json")) ?? "";
}

export async function awaitClose(run: HookRun, { boundMs = 30_000 } = {}): Promise<Closure> {
  const close = await closedWithin(run, boundMs);
  return close ? { kind: "closed", ...close } : { kind: "timeout", boundMs };
}

// For a test's finally: SIGKILL if not closed, then wait for the close within
// killWaitMs. Rejects when it is not observed; the run then stays open.
export async function ensureClosed(run: HookRun, { killWaitMs = 10_000 } = {}): Promise<HookClose> {
  if (run.close) return run.close;
  try {
    if (!run.child.kill("SIGKILL")) run.errors.push("kill: SIGKILL was not delivered");
  } catch (error) {
    run.errors.push(`kill: ${(error as Error).message}`);
  }
  const close = await closedWithin(run, killWaitMs);
  if (!close) throw new Error(`hook close not observed ${killWaitMs} ms after SIGKILL\n${describe(run)}`);
  return close;
}

// The receipt the hook consumes, written as the daemon writes it.
export function answerIntent(receipts: string, requestId: string): void {
  fs.mkdirSync(receipts, { recursive: true });
  writeJsonAtomic(path.join(receipts, `${requestId}.json`), { requestId, ok: true, expiresAt: Date.now() + 60_000,
    version: 1 });
}

// The JSON lines a preload below wrote to the hook's stderr; only complete lines.
export function preloadEvents(run: HookRun): Record<string, unknown>[] {
  const lines = text(run.stderr).split("\n");
  lines.pop();
  return lines.map((line) => line.trim()).filter((line) => line.startsWith('{"kherep657"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function awaitPreloadEvent(run: HookRun, kind: string,
  { boundMs = 30_000 } = {}): Promise<Record<string, unknown> | null> {
  const deadline = performance.now() + boundMs;
  for (;;) {
    const event = preloadEvents(run).find((candidate) => candidate.kherep657 === kind);
    if (event || run.close || performance.now() >= deadline) return event ?? null;
    await closedWithin(run, Math.min(10, deadline - performance.now()));
  }
}

// An assertion message: the given facts, then the run's lifecycle and bounded output.
export function describe(run: HookRun, ...facts: object[]): string {
  const tail = (value: string): string => value.slice(-DIAGNOSTIC_CHARS);
  const fields = { ...Object.assign({}, ...facts), pid: run.child.pid ?? null, elapsedMs: elapsedSince(run),
    exit: run.exit ?? "not observed", close: run.close ?? "not observed", errors: run.errors,
    stdout: tail(text(run.stdout)), stderr: tail(text(run.stderr)) };
  const format = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
  return Object.entries(fields).map(([key, value]) => `${key}: ${format(value)}`).join("\n");
}

const preloadUrl = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;

// Preloaded into the hook: the first rename onto <dir>/intents/<name>.json
// pauses beforeMs before and afterMs after it runs, and each pause reports to
// stderr that it started and how it ended, so a test asserts engagement rather
// than a wall clock. The temp file is written unchanged (the #226 filter stays
// exercised); every other rename is untouched.
export function intentRenamePreload({ beforeMs = 0, afterMs = 0 }: { beforeMs?: number; afterMs?: number }): string {
  return preloadUrl(String.raw`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const report = (fields) => fs.writeSync(2, JSON.stringify({ kherep657: 'intent-rename', ...fields }) + '\n');
const pause = (phase, ms, target) => {
  if (ms <= 0) return;
  report({ phase, target, started: true });
  const start = performance.now();
  const result = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  report({ phase, target, result, pausedMs: Math.round(performance.now() - start) });
};
const rename = fs.renameSync;
let fired = false;
fs.renameSync = (from, to) => {
  if (fired || !/[\\/]intents[\\/][^\\/]+\.json$/.test(String(to))) return rename(from, to);
  fired = true;
  pause('before', ${beforeMs}, String(to));
  rename(from, to);
  pause('after', ${afterMs}, String(to));
};
syncBuiltinESMExports();`);
}

export const CRASH_MARKER = "kherep-657 preload crashed at import";
// The hook fails before it publishes anything.
export const CRASH_AT_IMPORT_PRELOAD = preloadUrl(`throw new Error(${JSON.stringify(CRASH_MARKER)});`);
// The hook never loads: it runs until killed.
export const HANG_AT_IMPORT_PRELOAD = preloadUrl("setInterval(() => {}, 1 << 30); await new Promise(() => {});");
// As above, after starting a grandchild that inherits the hook's stdio: a
// SIGKILL ends the hook, but its 'close' waits for the grandchild (60 s at most).
export const STDIO_HOLDING_HANG_PRELOAD = preloadUrl(String.raw`import { spawn } from 'node:child_process';
import fs from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
fs.writeSync(2, JSON.stringify({ kherep657: 'grandchild', pid: grandchild.pid }) + '\n');
setInterval(() => {}, 1 << 30);
await new Promise(() => {});`);

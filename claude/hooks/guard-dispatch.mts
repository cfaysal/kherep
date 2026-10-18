#!/usr/bin/env node
// Issue #507, parts 1 and 2. Runs the PreToolUse guards of one matcher group,
// fails closed when a guard cannot run, and starts the hook integrity re-check.
//   node "<home>/hooks/guard-dispatch.mts" "<home>/hooks/<guard-a>.mts" ...
//
// Wired directly, an empty guard is an allow and a broken one a non-blocking
// error. Here each becomes a deny naming the file: missing, empty, no regular
// file, outside this directory, not spawnable, killed by a signal, past its cap,
// an exit other than 0 or 2, or stdout other than hookSpecificOutput alone with
// hookEventName, an optional decision and reason, an optional additionalContext,
// at least one of the two. So does stdin that is no JSON object or stays open.
// A working guard keeps its verdict (exit 2 = deny with stderr as the reason).
// Guards run in parallel to the end; decisions combine deny > ask > allow,
// notices join as additionalContext. At most one JSON document, nothing for a
// plain allow, each guard's stderr forwarded, exit 0 always. Guards get no args.
//
// Re-check (part 2): with <home>/.cache/hook-integrity/heartbeat.json older than
// 30 minutes or missing, live-hook-integrity.mts --trigger guard-dispatch runs
// in parallel with the guards, after them when a guard could not run; <home> is
// the parent of this file's directory as invoked. Its lines are one more notice
// (and stderr), never a decision: a restored guard runs from the next call on.
// One deadline 5 s before the 30 s hook timeout bounds stdin, guards and the
// re-check, so a decided deny is printed before Claude Code cancels the hook.
// Static imports are node:* only: a broken lib/ file cannot stop this loading.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Each PreToolUse entry of claude/settings.user.json has "timeout": 30; a test pins both.
const HOOK_TIMEOUT_MS = 30_000;
// Outside this clock: Node start (<= 2 s assumed; 0.09 s on macOS, Windows UNKNOWN), emit (<= 0.5 s).
const SAFETY_MARGIN_MS = 5_000;
const DEADLINE = Date.now() + HOOK_TIMEOUT_MS - SAFETY_MARGIN_MS;
const remaining = (): number => Math.max(0, DEADLINE - Date.now());
const GUARD_TIMEOUT_MS = 10_000;
// A re-check gets at most RECHECK_MAX_MS of what is left; below RECHECK_MIN_MS it is skipped.
const RECHECK_MAX_MS = 20_000, RECHECK_MIN_MS = 2_000;
const HEARTBEAT_WINDOW_MS = 1_800_000; // = lib/integrity-heartbeat.mts; each side has a boundary test
const SELF = fileURLToPath(import.meta.url);
const DIR = path.dirname(SELF);
const INVOKED_DIR = path.dirname(path.resolve(process.argv[1] ?? SELF));
const HOME = path.dirname(INVOKED_DIR);

const DECISIONS = ["deny", "ask", "allow"] as const;
type Decision = typeof DECISIONS[number];
// No decision: exit 0 without output (a plain allow) or a notice only. `broken`:
// the guard could not run, which starts a re-check; a policy deny does not.
interface Verdict { decision?: Decision; reason: string; notice?: string; broken?: boolean }
interface Outcome { verdict: Verdict; stderr: string }

const failure = (file: string, why: string): Verdict => ({ decision: "deny", broken: true,
  reason: `[guard-dispatch] ${file} cannot run (${why}); the tool call is blocked until hook integrity restores it`,
});

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

// The directory a path really lives in: a symlinked Claude home (macOS /var ->
// /private/var) must not put its own guards outside.
function realDir(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// The real path of the file itself, so a symlinked guard counts where it points.
// A missing file keeps its name under the real directory and fails at stat.
function realFile(file: string): string {
  try { return fs.realpathSync(file); } catch { return path.join(realDir(path.dirname(file)), path.basename(file)); }
}

// Why the file cannot be run, or undefined when it can.
function unrunnable(file: string, ownDir: string): string | undefined {
  const real = realFile(file);
  if (!isInside(real, ownDir)) return `outside ${DIR}`;
  if (path.relative(real, path.join(ownDir, path.basename(SELF))) === "") return "it is the dispatcher itself";
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : `stat failed: ${code ?? String(error)}`;
  }
  if (!stat.isFile()) return "not a regular file";
  if (stat.size === 0) return "empty, 0 bytes";
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const NOT_DECISION = "stdout is not a PreToolUse decision";
const FIELDS = ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext"];

// The verdict a guard printed on exit 0, or why stdout is not the accepted
// shape. A field the dispatcher would drop changes the guard's intent, so an
// unknown field fails instead of being ignored.
function printed(stdout: string): Verdict | string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return NOT_DECISION; }
  if (!isObject(parsed) || !isObject(parsed.hookSpecificOutput)) return NOT_DECISION;
  const output = parsed.hookSpecificOutput;
  if (output.hookEventName !== "PreToolUse") return NOT_DECISION;
  const extra = Object.keys(parsed).find((key) => key !== "hookSpecificOutput")
    ?? Object.keys(output).find((key) => !FIELDS.includes(key));
  if (extra !== undefined) return `${NOT_DECISION} (unsupported field ${extra || '""'})`;
  const { permissionDecision, permissionDecisionReason, additionalContext } = output;
  if (permissionDecision !== undefined && !DECISIONS.includes(permissionDecision as Decision)) {
    return `${NOT_DECISION} (invalid field permissionDecision)`;
  }
  // A reason without a decision would be dropped.
  if (permissionDecisionReason !== undefined && (typeof permissionDecisionReason !== "string" || !permissionDecision)) {
    return `${NOT_DECISION} (invalid field permissionDecisionReason)`;
  }
  if (additionalContext !== undefined && (typeof additionalContext !== "string" || !additionalContext)) {
    return `${NOT_DECISION} (invalid field additionalContext)`;
  }
  if (permissionDecision === undefined && additionalContext === undefined) return NOT_DECISION;
  return {
    decision: permissionDecision as Decision | undefined,
    reason: permissionDecisionReason ?? "",
    ...(additionalContext ? { notice: additionalContext } : {}),
  };
}

function judge(file: string, code: number | null, signal: string | null, stdout: string, stderr: string): Verdict {
  if (signal) return failure(file, `killed by ${signal}`);
  if (code === 2) {
    return { decision: "deny", reason: stderr.trim() || `${file} blocked this tool call without giving a reason` };
  }
  if (code !== 0) return failure(file, `exit code ${code}`);
  if (!stdout.trim()) return { reason: "" };
  const result = printed(stdout);
  return typeof result === "string" ? failure(file, result) : result;
}

// Node versions that strip types with a warning print this one for a .mts guard.
// It is no diagnostic of the guard, so only this exact warning is dropped; every
// other warning of the guard stays in its stderr and in an exit-2 reason.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n(?:\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning "
  + "was created\\)\\r?\\n)?", "gm");

function runGuard(file: string, payload: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false;
    const filtered = (): string => stderr.replace(TYPE_STRIPPING_WARNING, "");
    const settle = (verdict: Verdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ verdict, stderr: filtered() });
    };
    const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const cap = Math.min(GUARD_TIMEOUT_MS, remaining());
    const timer = setTimeout(() => {
      settle(failure(file, `timed out after ${Number((cap / 1000).toFixed(1))} s`));
      child.kill("SIGKILL");
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    }, cap);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => settle(failure(file, `spawn failed: ${error.message}`)));
    child.on("close", (code, signal) => settle(judge(file, code, signal, stdout, filtered())));
    // A guard may exit without reading its payload; the broken pipe is no verdict.
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}

// The strongest decision with its reasons, plus every notice in argument order.
// A printed allow passes through: it lets Claude Code skip its permission prompt.
function combine(verdicts: Verdict[]): Verdict | undefined {
  const decision = DECISIONS.find((candidate) => verdicts.some((verdict) => verdict.decision === candidate));
  const reason = verdicts.filter((verdict) => decision && verdict.decision === decision)
    .map((verdict) => verdict.reason).filter(Boolean).join("\n");
  const notice = verdicts.map((verdict) => verdict.notice).filter(Boolean).join("\n");
  if (!decision && !notice) return undefined;
  return { decision, reason, ...(notice ? { notice } : {}) };
}

const firstLine = (error: unknown): string => String((error as Error)?.message || error).split(/\r?\n/)[0];

// The re-check notice, or undefined when the heartbeat is fresh and every guard
// ran. Text only, never a verdict; settled at the latest at the deadline.
async function recheck(payload: string, guards: Promise<Outcome[]>, ownDir: string): Promise<string | undefined> {
  // A broken lib throws here or, empty (an empty namespace), at its first call.
  const lib = await import("./lib/guard-recheck.mts");
  const { stale, lastOk } = lib.heartbeatState(HOME, HEARTBEAT_WINDOW_MS);
  if (!stale && !(await guards).some((outcome) => outcome.verdict.broken)) return undefined;
  const context = { why: !stale ? "guard failure" : lastOk ? "stale heartbeat" : "no heartbeat", lastOk };
  const script = path.join(INVOKED_DIR, "live-hook-integrity.mts");
  const why = unrunnable(script, ownDir);
  if (why) return lib.recheckNotice(context, [`${script} cannot run (${why})`]);
  const budgetMs = Math.min(RECHECK_MAX_MS, remaining());
  if (budgetMs >= RECHECK_MIN_MS) return lib.runRecheck({ script, home: HOME, payload, budgetMs, ...context });
  return lib.recheckNotice(context, [`skipped, ${budgetMs} ms left of the hook budget; the next matching call re-checks`]);
}

async function dispatch(guards: string[]): Promise<{ verdict?: Verdict; stderr: string[] }> {
  let raw: string;
  try { raw = await readStdin(); } catch (error) { return { verdict: failure(SELF, firstLine(error)), stderr: [] }; }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { /* not JSON */ }
  if (!isObject(payload)) return { verdict: failure(SELF, "stdin is not a JSON object"), stderr: [] };
  if (!guards.length) return { verdict: failure(SELF, "no guard given"), stderr: [] };
  const ownDir = realDir(DIR);
  const running = Promise.all(guards.map((arg) => {
    const file = path.resolve(arg);
    const why = unrunnable(file, ownDir);
    return why ? { verdict: failure(file, why), stderr: "" } : runGuard(file, raw);
  }));
  const checking = recheck(raw, running, ownDir)
    .catch((error) => `hook integrity re-check unavailable (lib/guard-recheck.mts cannot be loaded: ${firstLine(error)})`);
  const [outcomes, notice] = await Promise.all([running, checking]);
  const verdicts = outcomes.map((outcome) => outcome.verdict);
  const stderr = outcomes.map((outcome) => outcome.stderr);
  if (notice) { verdicts.push({ reason: "", notice }); stderr.push(notice); }
  return { verdict: combine(verdicts), stderr };
}

function emit(verdict: Verdict | undefined, stderr: string[]): void {
  for (const text of stderr) if (text) process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  process.exitCode = 0;
  if (!verdict) return;
  const output = { hookEventName: "PreToolUse",
    ...(verdict.decision ? { permissionDecision: verdict.decision } : {}),
    ...(verdict.reason ? { permissionDecisionReason: verdict.reason } : {}),
    ...(verdict.notice ? { additionalContext: verdict.notice } : {}) };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
}

dispatch(process.argv.slice(2)).then(
  ({ verdict, stderr }) => emit(verdict, stderr),
  (error: unknown) => emit(failure(SELF, `internal error: ${error instanceof Error ? error.message : String(error)}`), []),
);

#!/usr/bin/env node
// Issue #507, part 1. Runs the PreToolUse guards of one matcher group and fails
// closed when a guard cannot run.
//
//   node "<home>/hooks/guard-dispatch.mts" "<home>/hooks/<guard-a>.mts" ...
//
// Wired directly, an empty guard exits 0 with no output and Claude Code takes
// that as allow; a missing or broken guard exits 1, which Claude Code treats as
// a non-blocking error. Here every such case becomes a deny that names the file:
// a guard that is missing, empty or no regular file, lies outside this
// directory, cannot be spawned, is killed by a signal, runs past 10 s, exits
// with a code other than 0 or 2, or prints anything but the accepted PreToolUse
// shape: hookSpecificOutput alone, with hookEventName, an optional decision and
// reason, an optional additionalContext, at least one of the two, nothing else.
// So does stdin that is not a JSON object.
//
// A working guard keeps its verdict: exit 2 is a deny with its stderr as the
// reason, a JSON decision passes through, exit 0 without output is allow, and an
// additionalContext without a decision is a notice. All guards run in parallel
// and every one runs to the end, also after a deny. Decisions combine as
// deny > ask > allow; every notice is passed on as additionalContext, also
// without a decision. The dispatcher prints at most one JSON document, nothing
// for a plain allow, forwards each guard's stderr, and always exits 0.
//
// Static imports come from node:* only, so a broken lib/ file cannot stop this
// file from loading. A guard receives no arguments: none of the wired Claude
// guards takes one.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 10_000;
const SELF = fileURLToPath(import.meta.url);
const DIR = path.dirname(SELF);

const DECISIONS = ["deny", "ask", "allow"] as const;
type Decision = typeof DECISIONS[number];
// No decision: exit 0 without output (a plain allow) or a notice only.
interface Verdict { decision?: Decision; reason: string; notice?: string }
interface Outcome { verdict: Verdict; stderr: string }

const failure = (file: string, why: string): Verdict => ({
  decision: "deny",
  reason: `[guard-dispatch] ${file} cannot run (${why}); the tool call is blocked until hook integrity restores it`,
});

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
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
  if (extra) return `${NOT_DECISION} (unsupported field ${extra})`;
  const { permissionDecision, permissionDecisionReason, additionalContext } = output;
  if (permissionDecision !== undefined && !DECISIONS.includes(permissionDecision as Decision)) {
    return `${NOT_DECISION} (invalid field permissionDecision)`;
  }
  if (permissionDecisionReason !== undefined && typeof permissionDecisionReason !== "string") {
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

function runGuard(file: string, payload: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (verdict: Verdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ verdict, stderr });
    };
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      settle(failure(file, `timed out after ${TIMEOUT_MS / 1000} s`));
      child.kill("SIGKILL");
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => settle(failure(file, `spawn failed: ${error.message}`)));
    child.on("close", (code, signal) => settle(judge(file, code, signal, stdout, stderr)));
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

async function dispatch(guards: string[]): Promise<{ verdict?: Verdict; stderr: string[] }> {
  let raw = "";
  let payload: unknown;
  try { raw = await readStdin(); payload = JSON.parse(raw); } catch { payload = undefined; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { verdict: failure(SELF, "stdin is not a JSON object"), stderr: [] };
  }
  if (!guards.length) return { verdict: failure(SELF, "no guard given"), stderr: [] };
  const ownDir = realDir(DIR);
  const outcomes = await Promise.all(guards.map((arg) => {
    const file = path.resolve(arg);
    const why = unrunnable(file, ownDir);
    return why ? Promise.resolve({ verdict: failure(file, why), stderr: "" }) : runGuard(file, raw);
  }));
  return { verdict: combine(outcomes.map((outcome) => outcome.verdict)), stderr: outcomes.map((outcome) => outcome.stderr) };
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

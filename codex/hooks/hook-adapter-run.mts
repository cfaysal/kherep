// Issue #533. The guard loops of the Codex hook adapter: every item of a PreToolUse phase
// within one budget, and the PostToolUse loop. The shell dispatcher reuses runAdaptedHook.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";

import { normalizeDeployApproval, normalizePayloads, type HookPayload } from "./hook-adapter-payload.mts";
import { codeOf, combine, failureFor, INTENT_PHASE, judge, labelOf, MIN_SPAWN_MS, PRE_TOOL_USE_PHASES, render, unrunnable, type Verdict }
  from "./hook-adapter-verdict.mts";

type Spawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
// guardArgs reach the guard after its path; deadline is an absolute end (ms since the epoch); spawn is a test seam.
export interface AdaptedOptions { guardArgs?: string[]; deadline?: number; spawn?: Spawn }
export interface AdaptedResult { stdout: string; stderr: string; status: number; broken?: boolean }

// The budget of one guard item: an integer, whatever the clock's fraction.
export const budgetFor = (capEnd: number, hardEnd: number, now: number): number => Math.floor(Math.min(capEnd, hardEnd) - now);

// Every item of a PreToolUse phase within one budget; the first deny ends the loop.
export function preToolUse(target: string, phase: string, payload: HookPayload, timeoutMs: number | undefined,
  options: AdaptedOptions): { verdict?: Verdict; stderr: string; broken: boolean; verdicts: Verdict[] } {
  const fail = failureFor(phase);
  const intent = phase === INTENT_PHASE;
  const why = unrunnable(target), label = labelOf(target); // reasons name the label, the spawn takes the target
  if (why) {
    const verdict = fail(label, why);
    return { verdict, stderr: "", broken: verdict.broken === true, verdicts: [verdict] };
  }
  const begin = Date.now();
  const capEnd = timeoutMs === undefined ? Infinity : begin + timeoutMs;
  const hardEnd = options.deadline ?? Infinity;
  // pre-intent: one item by construction, so the rewrite never depends on normalization.
  const items = intent ? [payload] : normalizePayloads(payload, phase);
  const verdicts: Verdict[] = [];
  let stderr = "";
  for (const [index, item] of items.entries()) {
    const normalized = phase === "pre-no-transcript" ? normalizeDeployApproval({ ...item, transcript_path: null }) : item;
    const budget = budgetFor(capEnd, hardEnd, Date.now());
    let verdict: Verdict;
    if (budget < MIN_SPAWN_MS) {
      verdict = fail(label, `budget exhausted before item ${index + 1} of ${items.length} (${Date.now() - begin} ms used)`, false);
    } else {
      try {
        // Node 22/24 print a type-stripping ExperimentalWarning for an .mts guard on stderr.
        const result = (options.spawn ?? spawnSync)(process.execPath, ["--disable-warning=ExperimentalWarning", target, ...(options.guardArgs ?? [])],
          { encoding: "utf8", input: JSON.stringify(normalized), windowsHide: true, timeout: budget, killSignal: "SIGKILL" });
        if (!intent) stderr += result.stderr ?? ""; // pre-intent forwards no raw error text (issue #538)
        verdict = judge(label, result, budget, phase, normalized.tool_input);
      } catch (error) {
        // Option validation or anything else Node throws before the child exists: no file fault.
        verdict = fail(label, `spawn threw (${codeOf(error)})`, false);
      }
    }
    verdicts.push(verdict);
    if (verdict.decision === "deny") break;
  }
  return { verdict: combine(verdicts), stderr, broken: verdicts.some((verdict) => verdict.broken), verdicts };
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

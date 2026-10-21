// Issue #533. The decisions of the Codex hook adapter: why a guard cannot run, what its
// output means for Codex (judge), and the one document for all items (combine, render).
import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Issue #538: pre-intent runs the messaging intent hook (see failureFor and intentRewrite).
export const INTENT_PHASE = "pre-intent";
export const PRE_TOOL_USE_PHASES = new Set(["pre", "pre-no-transcript", "pre-privacy", INTENT_PHASE]);
export const MIN_SPAWN_MS = 100; // a spawn costs about 85 ms; with less left none is started
// The running entry whenever Node runs a script; the fallback names this module (issue #533).
export const SELF = path.resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
// Issue #564. Files are named inside <CODEX_HOME>/hooks for the installed copy (kherep-maestro/<guard>.mts, as hook
// integrity names them), else inside this directory, else by file name. The root as given and as real (the shell
// dispatcher passes real-path guards under a symlinked home); a target is never realpath'd, so a link keeps its name.
const OWN = path.dirname(SELF), ROOT = path.basename(OWN) === "kherep-maestro" && path.basename(path.dirname(OWN)) === "hooks" ? path.dirname(OWN) : OWN;
const ROOTS = [ROOT, ...(() => { try { return [fs.realpathSync(ROOT)]; } catch { return []; } })()];
export const labelOf = (file: string): string => {
  const rel = ROOTS.map((root) => path.relative(root, file)).find((r) => r && !r.startsWith("..") && !path.isAbsolute(r));
  return rel ? rel.split(path.sep).join("/") : path.basename(file);
};
// A Node error code, else the error's class name, else "unknown"; never a message.
export const codeOf = (error: unknown): string => { const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : typeof name === "string" && /^[A-Za-z]{1,40}Error$/.test(name) ? name : "unknown"; };

const DECISIONS = ["deny", "ask", "allow"] as const;
type Decision = typeof DECISIONS[number];
// No decision: a plain allow or a notice only. `broken`: the guard file could not run (a re-check follows).
// `system`: the guard's top-level systemMessage (issue #507, part 4). `updated`: the pre-intent rewrite (issue #538).
export interface Verdict { decision?: Decision; reason: string; notice?: string; system?: string; broken?: boolean; updated?: Record<string, unknown> }

const failure = (label: string, why: string, broken = true): Verdict => ({ decision: "deny", broken,
  reason: `[hook-adapter] ${label} cannot run (${why}); the tool call is blocked until hook integrity restores it`,
});
type Failure = typeof failure;
// Issue #538. In pre-intent every reason is fixed text: the basename, a why with an error code or class name at most,
// and the installer as the repair path. The intent hook lives outside hooks/, so integrity cannot restore it: never `broken`.
const intentReason = (file: string, why: string, until: string): string =>
  `[hook-adapter] ${path.basename(file)} cannot run (${why}); the messaging call is blocked until ${until}`;
export function failureFor(phase: string): Failure {
  if (phase !== INTENT_PHASE) return failure;
  return (file, why) => ({ decision: "deny", broken: false, reason: intentReason(file, why, "the Codex installer reinstalls the messaging client") });
}
// The adapter's own failures; it is in integrity scope, so its pre-intent form keeps that repair path.
export const adapterFailure = (phase: string, why: string): Verdict => phase === INTENT_PHASE
  ? { decision: "deny", broken: false, reason: intentReason(SELF, why, "hook integrity restores it") } : failure(labelOf(SELF), why);
export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Why the file cannot be run, or undefined when it can.
export function unrunnable(file: string): string | undefined {
  if (!path.isAbsolute(file)) return "path is not absolute";
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : `stat failed: ${codeOf(error)}`;
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

// RFC 9562 versions 1-8 as the Worker's zod uuid() checks them (without its nil and max forms); the hook mints randomUUID().
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Issue #538. The pre-intent rules: a decision is required, and updatedInput passes only with an allow and only
// as the call's tool_input plus a UUID requestId; the rewrite is rebuilt from the adapter's own payload.
function intentRewrite(output: Record<string, unknown>, toolInput: unknown): Pick<Verdict, "updated"> | string {
  const { permissionDecision, updatedInput } = output;
  if (permissionDecision === undefined) return `${NOT_DECISION} (no permissionDecision)`;
  if (!DECISIONS.includes(permissionDecision as Decision)) return `${NOT_DECISION} (invalid field permissionDecision)`;
  if (updatedInput === undefined) return permissionDecision === "allow" ? `${NOT_DECISION} (allow without updatedInput)` : {};
  if (!isObject(updatedInput) || permissionDecision !== "allow") return `${NOT_DECISION} (invalid field updatedInput)`;
  const { requestId, ...rest } = updatedInput;
  if (typeof requestId !== "string" || JSON.stringify(rest) !== JSON.stringify(toolInput)) return `${NOT_DECISION} (updatedInput is not tool_input plus requestId)`;
  if (!UUID.test(requestId)) return `${NOT_DECISION} (requestId is not a UUID)`;
  return { updated: { ...(toolInput as Record<string, unknown>), requestId } };
}

// The verdict a guard printed on exit 0, or why stdout is not the accepted shape
// (claude/hooks/guard-dispatch.mts): a field that would be dropped fails.
function printed(stdout: string, phase: string, toolInput: unknown): Verdict | string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return NOT_DECISION; }
  if (!isObject(parsed) || !isObject(parsed.hookSpecificOutput)) return NOT_DECISION;
  const output = parsed.hookSpecificOutput;
  if (output.hookEventName !== "PreToolUse") return NOT_DECISION;
  const intent = phase === INTENT_PHASE;
  const fields = intent ? [...FIELDS, "updatedInput"] : FIELDS;
  const extra = Object.keys(parsed).find((key) => key !== "hookSpecificOutput" && key !== "systemMessage")
    ?? Object.keys(output).find((key) => !fields.includes(key));
  // In pre-intent the key is not echoed: every reason there is fixed text (issue #538).
  if (extra !== undefined) return intent ? `${NOT_DECISION} (unsupported field)` : `${NOT_DECISION} (unsupported field ${extra || '""'})`;
  const rewrite = intent ? intentRewrite(output, toolInput) : {};
  if (typeof rewrite === "string") return rewrite;
  // Issue #507, part 4. Codex documents a top-level systemMessage for PreToolUse: a non-empty string passes through.
  const { systemMessage } = parsed;
  if (systemMessage !== undefined && (typeof systemMessage !== "string" || !systemMessage)) return `${NOT_DECISION} (invalid field systemMessage)`;
  const invalid = invalidField(output);
  if (invalid) return `${NOT_DECISION} (invalid field ${invalid})`;
  const { permissionDecision, permissionDecisionReason, additionalContext } = output;
  if (permissionDecision === undefined && additionalContext === undefined) return NOT_DECISION;
  return { decision: permissionDecision as Decision | undefined, reason: (permissionDecisionReason as string | undefined) ?? "",
    ...(additionalContext ? { notice: additionalContext as string } : {}), ...(systemMessage ? { system: systemMessage as string } : {}), ...rewrite };
}

// error first: a grandchild that holds the pipe leaves status 0 with ETIMEDOUT. In pre-intent an exit 2,
// silence and an ask are outside the hook's contract (it always exits 0 with a decision).
export function judge(label: string, result: SpawnSyncReturns<string>, budget: number, phase: string, toolInput: unknown): Verdict {
  const fail = failureFor(phase);
  const intent = phase === INTENT_PHASE;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return fail(label, `timed out after ${(budget / 1000).toFixed(1)} s`);
    if (code === "ENOBUFS") return fail(label, "output exceeded the 1 MiB buffer");
    return fail(label, `spawn failed (${codeOf(result.error)})`);
  }
  if (result.signal) return fail(label, `killed by ${result.signal}`);
  if (result.status === 2 && !intent) {
    return { decision: "deny", reason: result.stderr.trim() || `${label} blocked this tool call without giving a reason.` };
  }
  if (result.status !== 0) return fail(label, `exit code ${result.status}`);
  if (!result.stdout.trim()) return intent ? fail(label, "printed no decision") : { reason: "" };
  const shown = printed(result.stdout, phase, toolInput);
  if (typeof shown === "string") return fail(label, shown);
  if (shown.decision !== "ask") return shown;
  return intent ? fail(label, "asked for confirmation; Codex has no ask")
    : { ...shown, decision: "deny", reason: `${label} asked for confirmation; Codex has no ask, so the call is denied` };
}

// The strongest decision with its reasons, plus every notice in order.
export function combine(verdicts: Verdict[]): Verdict | undefined {
  const decision = DECISIONS.find((candidate) => verdicts.some((verdict) => verdict.decision === candidate));
  const reason = verdicts.filter((verdict) => decision && verdict.decision === decision)
    .map((verdict) => verdict.reason).filter(Boolean).join("\n");
  const notice = verdicts.map((verdict) => verdict.notice).filter(Boolean).join("\n");
  const system = verdicts.map((verdict) => verdict.system).filter(Boolean).join("\n");
  // Issue #538: at most one pre-intent item carries a rewrite; two would be a defect of this adapter.
  const rewrites = verdicts.filter((verdict) => verdict.updated);
  if (rewrites.length > 1) return adapterFailure(INTENT_PHASE, "conflicting rewrites");
  if (!decision && !notice) return undefined;
  return { decision, reason, ...(notice ? { notice } : {}), ...(system ? { system } : {}),
    ...(decision === "allow" && rewrites[0] ? { updated: rewrites[0].updated } : {}) };
}

export const render = (verdict: Verdict | undefined, top: Record<string, string> = {}): string => verdict ? JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", ...(verdict.decision ? { permissionDecision: verdict.decision } : {}),
    ...(verdict.reason ? { permissionDecisionReason: verdict.reason } : {}), ...(verdict.notice ? { additionalContext: verdict.notice } : {}),
    ...(verdict.updated ? { updatedInput: verdict.updated } : {}) },
  ...(verdict.system ? { systemMessage: verdict.system } : {}), ...top }) : "";

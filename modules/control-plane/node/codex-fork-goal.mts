// The two thread/goal/get decisions of the Codex fork reply (issue #408, goal
// revision of 2026-10-16 to design sections 2, 3 and 4.3), pure: they read one
// RPC outcome with the raw JSON-RPC code and message, never a redacted line.
// SOURCE-READ openai/codex 092d3acd, thread_goal_processor.rs: line 258 gates
// on the helper server's own config ("goals feature is disabled"); lines
// 332-336 refuse a loaded thread without a rollout path, an ephemeral fork,
// with -32600 "ephemeral thread does not support goals: <id>", for reads too.

export type RpcOutcome = { kind: "result"; result: unknown } | { kind: "error"; code: number; message: string }
  | { kind: "timeout" } | { kind: "transport" };

// The pre-fork owner outcomes that pass; anything else already refused.
export type OwnerGoalOutcome = "null" | "complete";
export type ForkGoalProof = "ephemeral-gate";
export type ForkGoalDetail = "fork-has-goal" | "fork-goal-null-unexpected" | "fork-goal-shape" | "fork-goal-id-mismatch"
  | "fork-goal-inconsistent" | "fork-goal-error" | "fork-goal-timeout" | "fork-goal-transport";
export const FORK_GOAL_DETAILS: readonly ForkGoalDetail[] = ["fork-has-goal", "fork-goal-null-unexpected", "fork-goal-shape",
  "fork-goal-id-mismatch", "fork-goal-inconsistent", "fork-goal-error", "fork-goal-timeout", "fork-goal-transport"];

export const FORK_GOAL_EPHEMERAL_PREFIX = "ephemeral thread does not support goals: ";
const GOALS_DISABLED = "goals feature is disabled";
const INVALID_REQUEST = -32600;

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyGoalKey = (result: unknown): result is { goal: unknown } => object(result) && Object.keys(result).length === 1
  && Object.hasOwn(result, "goal");

// Before the fork, on the owner: no goal or a complete one passes; any other
// goal is owner-goal; goals switched off on the helper is goals-disabled (the
// helper cannot read the owner's goal and must not guess); anything else is goal-unknown.
export function classifyOwnerGoalOutcome(outcome: RpcOutcome):
  { ok: true; outcome: OwnerGoalOutcome } | { ok: false; reason: "owner-goal" | "goals-disabled" | "goal-unknown" } {
  if (outcome.kind === "error") {
    return { ok: false, reason: outcome.code === INVALID_REQUEST && outcome.message === GOALS_DISABLED ? "goals-disabled" : "goal-unknown" };
  }
  if (outcome.kind !== "result" || !object(outcome.result) || !Object.hasOwn(outcome.result, "goal")) return { ok: false, reason: "goal-unknown" };
  const goal = outcome.result.goal;
  if (goal === null) return { ok: true, outcome: "null" };
  if (!object(goal) || typeof goal.status !== "string") return { ok: false, reason: "goal-unknown" };
  return goal.status === "complete" ? { ok: true, outcome: "complete" } : { ok: false, reason: "owner-goal" };
}

// After the fork, on the fork: an ephemerality assertion. It passes only on
// -32600 with the message byte-equal to the prefix plus the fork id of the
// thread/fork response, after an owner read that succeeded on this server.
// The prefix test below only names the failure; the pass is the full-string
// equality. MEASURED 2026-10-16 on Codex 0.160.1, 0.162.0-alpha.17.2 and
// 0.163.0 (hypothesis H1). There is no other pass and no list of binaries: a
// binary that answers goal null for a fork fails visibly as
// fork-goal-null-unexpected, whatever its version, and one with the same
// answer as the measured ones works without any approval step.
export function classifyForkGoalOutcome(outcome: RpcOutcome, forkId: string, ownerGoal: OwnerGoalOutcome | undefined):
  { ok: true; proof: ForkGoalProof } | { ok: false; detail: ForkGoalDetail } {
  const fail = (detail: ForkGoalDetail) => ({ ok: false as const, detail });
  if (outcome.kind === "timeout") return fail("fork-goal-timeout");
  if (outcome.kind === "transport") return fail("fork-goal-transport");
  if (ownerGoal !== "null" && ownerGoal !== "complete") return fail("fork-goal-inconsistent");
  if (outcome.kind === "error") {
    if (outcome.code !== INVALID_REQUEST) return fail("fork-goal-error");
    if (outcome.message === FORK_GOAL_EPHEMERAL_PREFIX + forkId) return { ok: true, proof: "ephemeral-gate" };
    if (outcome.message.startsWith(FORK_GOAL_EPHEMERAL_PREFIX)) return fail("fork-goal-id-mismatch");
    return fail(outcome.message === GOALS_DISABLED ? "fork-goal-inconsistent" : "fork-goal-error");
  }
  if (!onlyGoalKey(outcome.result)) return fail("fork-goal-shape");
  if (outcome.result.goal === null) return fail("fork-goal-null-unexpected");
  return object(outcome.result.goal) ? fail("fork-has-goal") : fail("fork-goal-shape");
}

import assert from "node:assert/strict";
import test from "node:test";

const OWNER = "11111111-1111-7111-8111-111111111111";
const CHILD = "22222222-2222-7222-8222-222222222222";
const ROLLOUT = "33333333-3333-7333-8333-333333333333";
const modulePath = "./codex-hook-owner.mts";
const ownerModule = await import(modulePath).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return null;
  throw error;
});

function allowed(extra: Record<string, unknown> = {}): boolean {
  assert.ok(ownerModule, "original-owner metadata gate is not implemented");
  return ownerModule.postToolOriginalOwner({
    hook_event_name: "PostToolUse", session_id: OWNER,
    transcript_path: `/synthetic/rollout-2026-10-10T13-00-00-${OWNER}.jsonl`,
    ...extra,
  }, OWNER);
}

test("admits the exact original owner using POSIX and Windows metadata only", () => {
  assert.equal(allowed(), true);
  assert.equal(allowed({ transcript_path: `C:\\synthetic\\rollout-2026-10-10T13-00-00-${OWNER}.jsonl` }), true);
});

test("reverted rollouts use the first UUID as the executing thread", () => {
  assert.equal(allowed({ transcript_path: `/synthetic/rollout-2026-10-10T13-00-00-${OWNER}_${ROLLOUT}.jsonl` }), true);
  assert.equal(allowed({ transcript_path: `/synthetic/rollout-2026-10-10T13-00-00-${CHILD}_${OWNER}.jsonl` }), false);
});

test("rejects a Review-like child even when it shares the parent's session_id", () => {
  assert.equal(allowed({ transcript_path: `/synthetic/rollout-2026-10-10T13-00-00-${CHILD}.jsonl` }), false);
});

test("rejects child fields including null, empty and malformed values", () => {
  for (const value of [CHILD, null, "", 0, {}, undefined]) {
    assert.equal(allowed({ agent_id: value }), false);
    assert.equal(allowed({ agent_type: value }), false);
  }
});

test("rejects foreign session identity and unrelated hook events", () => {
  assert.equal(allowed({ session_id: CHILD }), false);
  assert.equal(allowed({ session_id: null }), false);
  assert.equal(allowed({ hook_event_name: "Stop" }), false);
});

test("rejects missing or noncanonical executing-thread metadata", () => {
  for (const value of [null, undefined, 0, "", `/synthetic/${OWNER}.jsonl`,
    `/synthetic/rollout-2026-02-30T13-00-00-${OWNER}.jsonl`,
    `/synthetic/rollout-2026-10-10T25-00-00-${OWNER}.jsonl`,
    `/synthetic/rollout-2026-10-10T13-00-00-${OWNER}.jsonl.gz`,
    `/synthetic/rollout-2026-10-10T13-00-00-${OWNER}_invalid.jsonl`,
    `/synthetic/rollout-2026-10-10T13-00-00-${OWNER}.jsonl\u0000`,
  ]) assert.equal(allowed({ transcript_path: value }), false);
});

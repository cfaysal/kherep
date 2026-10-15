import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { nodePaths } from "./config.mts";
import { onboard } from "./onboard.mts";
import {
  acceptsMessage, DEFAULT_POLICY, DEFAULT_TURN_BUDGET, messagingEnabled, readPolicy, wakeAllowed, wakeBudget, type NodePolicy,
} from "./policy.mts";

// Issue #390: a policy file without a wake section wakes every session; one
// without a messaging section still accepts nothing (fail closed). The accept
// rule for every sender lives only in DEFAULT_POLICY, the file onboarding
// writes. An explicit section is honoured as written, and a malformed one
// still fails closed.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const WAKE = { enabled: true, sessions: ["*"], codexApp: true, replies: true };
const MESSAGING = { accept: [{ session: "*", from: ["*"] }] };

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-policy-defaults-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function parse(t: test.TestContext, sections: Record<string, unknown>): NodePolicy {
  const file = path.join(tempDir(t), "policy.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: ["node.status"], ...sections }));
  const policy = readPolicy(file);
  assert.ok(policy, JSON.stringify(sections));
  return policy;
}

test("a file without a wake section wakes every session; without a messaging section it accepts nothing", (t) => {
  const policy = parse(t, {});
  assert.deepEqual(policy.wake, WAKE);
  assert.equal(wakeAllowed(policy, ["any-session"]), true);
  assert.equal(policy.messaging, undefined, "no implied accept rule");
  assert.equal(messagingEnabled(policy), false);
  assert.equal(acceptsMessage(policy, "any-session", PEER), false);
  assert.equal(acceptsMessage(policy, "any-session", "operator"), false);
  assert.deepEqual(policy.allowedCommands, ["node.status"]);
  // The wake default applies next to a written messaging section.
  const accepting = parse(t, { messaging: { accept: [{ session: "review", from: [PEER] }] } });
  assert.deepEqual(accepting.wake, WAKE);
  assert.equal(acceptsMessage(accepting, "review", PEER), true);
});

test("an explicit opt-out is honoured as written", (t) => {
  const off = parse(t, { wake: { enabled: false }, messaging: { accept: [] } });
  assert.equal(off.wake, undefined);
  assert.equal(off.messaging, undefined);
  assert.equal(messagingEnabled(off), false);
  assert.equal(acceptsMessage(off, "any-session", PEER), false);
  assert.equal(wakeAllowed(off, ["any-session"]), false);
  const narrow = parse(t, { wake: { enabled: true, sessions: ["review"] }, messaging: { accept: [{ session: "review", from: [PEER] }] } });
  assert.deepEqual(narrow.wake, { enabled: true, sessions: ["review"] });
  assert.equal(wakeAllowed(narrow, ["build"]), false);
  assert.equal(acceptsMessage(narrow, "build", PEER), false);
});

test("a malformed wake or messaging section still fails closed", (t) => {
  for (const wake of [null, false, "on", [], { enabled: "true" }, { enabled: true }, { enabled: true, sessions: [] },
    { enabled: true, sessions: ["*"], replies: "yes" }, { enabled: true, sessions: ["*"], budget: { perHour: 0 } },
    { enabled: true, sessions: ["*"], nativeQueue: "yes" }, { enabled: true, sessions: [], nativeQueue: true }]) {
    const policy = parse(t, { wake, messaging: MESSAGING });
    assert.equal(policy.wake, undefined, JSON.stringify(wake));
    assert.equal(wakeAllowed(policy, ["any-session"]), false, JSON.stringify(wake));
    assert.deepEqual(policy.messaging, MESSAGING, "the other section stays as written");
  }
  for (const messaging of [null, "yes", [], {}, { accept: "all" }, { accept: [{ session: "*", from: ["some-host"] }] }]) {
    const policy = parse(t, { messaging });
    assert.equal(policy.messaging, undefined, JSON.stringify(messaging));
    assert.equal(messagingEnabled(policy), false, JSON.stringify(messaging));
    assert.deepEqual(policy.wake, WAKE, "the other section keeps its default");
  }
});

test("DEFAULT_POLICY holds both sections, the accept rule explicitly, and is what a missing file reads as", (t) => {
  assert.deepEqual(DEFAULT_POLICY.wake, WAKE);
  assert.deepEqual(DEFAULT_POLICY.messaging, MESSAGING);
  const dir = tempDir(t);
  assert.deepEqual(readPolicy(path.join(dir, "missing.json")), DEFAULT_POLICY);
  // Written back as JSON, as onboarding does, it parses to itself.
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify(DEFAULT_POLICY));
  assert.deepEqual(readPolicy(file, true), DEFAULT_POLICY);
});

test("the default turn budget is 20 per hour and 100 per day", () => {
  assert.deepEqual(DEFAULT_TURN_BUDGET, { perHour: 20, perDay: 100, spacingMs: 30_000 });
  assert.deepEqual(wakeBudget(DEFAULT_POLICY), DEFAULT_TURN_BUDGET);
});

test("onboarding writes DEFAULT_POLICY with both sections only when the policy file is missing", async (t) => {
  const enroll = (paths: ReturnType<typeof nodePaths>) => onboard({ controlUrl: "https://control.example.com", code: "one-time-code-123456",
    paths, facts: { hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 2, memoryBytes: 1024 }, runtimes: [],
    fetch: (async () => Response.json({ nodeId: "00000000-0000-4000-8000-0000000000bb" }, { status: 201 })) as typeof fetch });
  const fresh = nodePaths(tempDir(t));
  await enroll(fresh);
  const written = JSON.parse(fs.readFileSync(fresh.policy, "utf8")) as Record<string, unknown>;
  assert.deepEqual([written.wake, written.messaging], [WAKE, MESSAGING]);
  assert.deepEqual(readPolicy(fresh.policy, true), DEFAULT_POLICY);

  const existing = nodePaths(tempDir(t));
  fs.mkdirSync(existing.dir, { recursive: true });
  const own = JSON.stringify({ version: 1, allowedCommands: [] });
  fs.writeFileSync(existing.policy, own);
  await enroll(existing);
  assert.equal(fs.readFileSync(existing.policy, "utf8"), own, "an existing file is never rewritten");
});

// Issue #429: nativeQueue opts into the native Codex Queue pointer producer. It
// is stored only when true, so false and an absent key are the same policy, and
// a change of the flag changes the busy-admission fingerprint.
test("wake.nativeQueue is stored only when true and changes the policy fingerprint", (t) => {
  const on = parse(t, { wake: { enabled: true, sessions: ["review"], nativeQueue: true } });
  const off = parse(t, { wake: { enabled: true, sessions: ["review"] } });
  const offExplicit = parse(t, { wake: { enabled: true, sessions: ["review"], nativeQueue: false } });
  assert.deepEqual(on.wake, { enabled: true, sessions: ["review"], nativeQueue: true });
  assert.deepEqual(offExplicit.wake, { enabled: true, sessions: ["review"] });
  assert.deepEqual(DEFAULT_POLICY.wake, WAKE);
  assert.notEqual(busyPolicyFingerprint(on), busyPolicyFingerprint(off));
  assert.equal(busyPolicyFingerprint(offExplicit), busyPolicyFingerprint(off));
});

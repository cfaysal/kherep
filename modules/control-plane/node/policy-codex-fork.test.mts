import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { DEFAULT_POLICY, readPolicy, type NodePolicy } from "./policy.mts";

// Issue #408, PR 2: the opt-in wake.codexFork section. Absent means off and the
// policy is the same as before; any malformed shape disables only codexFork and
// leaves the rest of the wake section as written (fail closed).

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const WAKE = { enabled: true, sessions: ["*"], codexApp: true, replies: true };

function parse(t: test.TestContext, wake: unknown): NodePolicy {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-policy-fork-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: ["node.status"], wake }));
  const policy = readPolicy(file);
  assert.ok(policy);
  return policy;
}

test("an absent codexFork section leaves the parsed policy and its fingerprint unchanged", (t) => {
  const policy = parse(t, WAKE);
  assert.deepEqual(policy.wake, WAKE);
  assert.equal(Object.hasOwn(policy.wake!, "codexFork"), false);
  assert.equal(Object.hasOwn(DEFAULT_POLICY.wake!, "codexFork"), false, "onboarding never writes it");
});

test("a valid codexFork section is kept with its defaults filled in", (t) => {
  const policy = parse(t, { ...WAKE, codexFork: { enabled: true, sessions: [OWNER, OWNER] } });
  assert.deepEqual(policy.wake?.codexFork, { enabled: true, sessions: [OWNER], platforms: ["darwin"], idleAfterSeconds: 90,
    maxAnswerBytes: 4096 });
  const explicit = parse(t, { ...WAKE, codexFork: { enabled: true, sessions: [OWNER], platforms: ["darwin"], idleAfterSeconds: 90,
    maxAnswerBytes: 4096 } });
  assert.equal(busyPolicyFingerprint(explicit), busyPolicyFingerprint(policy), "explicit defaults are the same policy");
  const bounds = parse(t, { ...WAKE, codexFork: { enabled: true, sessions: [OWNER], idleAfterSeconds: 3600, maxAnswerBytes: 256 } });
  assert.deepEqual([bounds.wake?.codexFork?.idleAfterSeconds, bounds.wake?.codexFork?.maxAnswerBytes], [3600, 256]);
  assert.notEqual(busyPolicyFingerprint(policy), busyPolicyFingerprint(parse(t, WAKE)), "a change invalidates admissions");
});

// Fable review of PR 2, L3: ids match without case and are kept in lowercase,
// so that admission's exact comparison finds an id written in uppercase.
test("an uppercase codexFork session id is kept in lowercase", (t) => {
  const lower = parse(t, { ...WAKE, codexFork: { enabled: true, sessions: [OWNER] } });
  const upper = parse(t, { ...WAKE, codexFork: { enabled: true, sessions: [OWNER.toUpperCase(), OWNER] } });
  assert.deepEqual(upper.wake?.codexFork?.sessions, [OWNER]);
  assert.equal(busyPolicyFingerprint(upper), busyPolicyFingerprint(lower), "the same policy as the lowercase id");
});

test("every malformed codexFork shape disables only codexFork", (t) => {
  const base = { enabled: true, sessions: [OWNER] };
  for (const codexFork of [
    null, true, [], "on", {}, { ...base, enabled: false }, { ...base, enabled: "true" }, { enabled: true },
    { ...base, sessions: [] }, { ...base, sessions: "*" }, { ...base, sessions: ["*"] }, { ...base, sessions: ["codex-00000001"] },
    { ...base, sessions: [OWNER, "review"] }, { ...base, sessions: [42] },
    { ...base, platforms: [] }, { ...base, platforms: ["win32"] }, { ...base, platforms: ["darwin", "linux"] }, { ...base, platforms: "darwin" },
    { ...base, idleAfterSeconds: 29 }, { ...base, idleAfterSeconds: 3601 }, { ...base, idleAfterSeconds: 90.5 }, { ...base, idleAfterSeconds: "90" },
    { ...base, maxAnswerBytes: 255 }, { ...base, maxAnswerBytes: 8193 }, { ...base, maxAnswerBytes: null },
    { ...base, budget: { perHour: 1 } }, { ...base, gate: true },
  ]) {
    const policy = parse(t, { ...WAKE, codexFork });
    assert.deepEqual(policy.wake, WAKE, JSON.stringify(codexFork));
  }
});

test("a rejected wake section still takes codexFork with it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-policy-fork-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: [], codexFork: { enabled: true,
    sessions: [OWNER] } } }));
  assert.equal(readPolicy(file)?.wake, undefined);
});

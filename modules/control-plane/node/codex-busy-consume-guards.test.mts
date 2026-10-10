import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BUSY_OWNER, busyFixture } from "./codex-busy-fixture.mts";
import { busyPolicyFingerprint } from "./codex-busy-publish.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { loadPolicy } from "./policy.mts";

test("missing enrollment, policy errors, drift and kill switch cause no targeted reads or claim", (t) => {
  for (const change of ["unenrolled", "missing", "malformed", "drift", "kill"]) {
    const node = busyFixture(t);
    if (change === "unenrolled") fs.unlinkSync(node.paths.config);
    if (change === "missing") fs.unlinkSync(node.paths.policy);
    if (change === "malformed") fs.writeFileSync(node.paths.policy, "{invalid");
    if (change === "drift") fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
    if (change === "kill") fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
    const read = fs.readFileSync;
    let reads = 0;
    const mocked = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
      if (String(args[0]).startsWith(node.paths.inbox + path.sep)) reads++;
      return Reflect.apply(read, fs, args);
    });
    assert.equal(deliverForCodex(node.input, node.hookDeps), "", change);
    assert.equal(reads, 0, change);
    mocked.mock.restore();
    assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, false, change);
  }
});

test("the current Hook permission cannot borrow an earlier recorded permission", (t) => {
  for (const mode of ["bypassPermissions", undefined]) {
    const node = busyFixture(t);
    const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
    policy.wake = { enabled: true, sessions: [], codexApp: true };
    fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
    const ticket = JSON.parse(fs.readFileSync(node.ticket, "utf8"));
    ticket.policyFingerprint = busyPolicyFingerprint(loadPolicy(node.paths.policy));
    fs.writeFileSync(node.ticket, JSON.stringify(ticket));
    assert.equal(deliverForCodex({ ...node.input, permission_mode: mode }, node.hookDeps), "");
    assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, false);
  }
  const explicit = busyFixture(t);
  assert.match(deliverForCodex({ ...explicit.input, permission_mode: undefined }, explicit.hookDeps), /New peer messages/,
    "an explicitly listed full id preserves the existing unknown-mode rule");
});

test("an absent Hook mode uses a fresh owner record, including a recorded bypass denial", (t) => {
  for (const bypass of [false, true]) {
    const node = busyFixture(t);
    const file = path.join(node.paths.codexSessions, `${BUSY_OWNER}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (bypass) fs.writeFileSync(file, JSON.stringify({ ...record, permissionMode: "bypassPermissions" }));
    const { permission_mode: _mode, ...input } = node.input;
    assert.equal(!!deliverForCodex(input, node.hookDeps), !bypass);
    assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, !bypass);
  }
});

test("future, expired, malformed and locked metadata leave the native queue fallback untouched", (t) => {
  for (const change of ["future", "expired", "malformed", "locked"]) {
    const node = busyFixture(t);
    if (change === "malformed") fs.writeFileSync(node.ticket, "{invalid");
    if (change === "locked") fs.writeFileSync(node.ticket + ".lock", "another writer");
    const before = fs.readFileSync(node.ticket, "utf8");
    const now = node.admission.admittedAt + (change === "future" ? -1 : change === "expired" ? 60_000 : 0);
    assert.equal(deliverForCodex(node.input, { ...node.hookDeps, now: () => now }), "", change);
    assert.equal(fs.readFileSync(node.ticket, "utf8"), before, change);
    if (change === "locked") assert.equal(fs.readFileSync(node.ticket + ".lock", "utf8"), "another writer");
  }
});

test("a failed targeted record read stays quiet and does not claim the generation", (t) => {
  const node = busyFixture(t);
  fs.writeFileSync(path.join(node.paths.inbox, `${node.ids[0]}.json`), "{invalid synthetic Inbox data}");
  const before = fs.readFileSync(node.ticket, "utf8");
  assert.equal(deliverForCodex(node.input, node.hookDeps), "");
  assert.equal(fs.readFileSync(node.ticket, "utf8"), before);
});

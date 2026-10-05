import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkPolicy } from "./doctor-local.mts";
import type { InboxRecord } from "./inbox.mts";
import { loadPolicy } from "./policy.mts";
import { id, ORIGINAL, PEER, SELF, sentOriginal, setup, T0 } from "./wake-fixture.mts";
import { REPLY_GRANT_MAX_AGE_MS, replyGrants } from "./wake-reply.mts";

// Reply grant (issue #253): with wake.replies a reply to a message this node
// sent from a session may wake that session without a listing. The fixture's
// session is SELF, named "review".

const OTHER = "00000000-0000-4000-8000-0000000000dd";
const REFS = [SELF, "review"];

const reply = (overrides: Partial<InboxRecord> = {}): InboxRecord => ({ messageId: id(0x501), from: { nodeId: PEER, session: "build" },
  toSession: "review", text: "answer", inReplyTo: ORIGINAL, createdAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(),
  state: "accepted", ...overrides });

test("a reply from the addressed node to this session's recent message grants", (t) => {
  const { paths } = setup(t);
  sentOriginal(paths);
  assert.equal(replyGrants(paths, REFS, reply(), T0), true);
  assert.equal(replyGrants(paths, [SELF], reply(), T0), true, "the id alone binds");
  assert.equal(replyGrants(paths, REFS, reply(), T0 - 3_600_000 + REPLY_GRANT_MAX_AGE_MS), true, "at the age bound");
  for (const state of ["queued", "delivered", "replied"] as const) {
    const fresh = setup(t).paths;
    sentOriginal(fresh, {}, state);
    assert.equal(replyGrants(fresh, REFS, reply(), T0), true, state);
  }
});

test("no grant from another node, the operator, or without a valid original", (t) => {
  const { paths } = setup(t);
  sentOriginal(paths);
  assert.equal(replyGrants(paths, REFS, reply({ from: { nodeId: OTHER, session: "build" } }), T0), false, "another node");
  assert.equal(replyGrants(paths, REFS, reply({ from: { nodeId: "operator", session: "api" } }), T0), false, "the operator");
  assert.equal(replyGrants(paths, REFS, reply({ inReplyTo: undefined }), T0), false, "not a reply");
  assert.equal(replyGrants(paths, REFS, reply({ inReplyTo: "not-a-message-id" }), T0), false, "invalid id");
  assert.equal(replyGrants(paths, REFS, reply({ inReplyTo: id(0x599) }), T0), false, "unknown original");
  assert.equal(replyGrants(paths, REFS, reply(), T0 - 3_600_000 + REPLY_GRANT_MAX_AGE_MS + 1), false, "older than 24 h");
  for (const state of ["refused", "expired", "error"] as const) {
    const ended = setup(t).paths;
    sentOriginal(ended, {}, state);
    assert.equal(replyGrants(ended, REFS, reply(), T0), false, state);
  }
  const incomplete = setup(t).paths;
  sentOriginal(incomplete, { createdAt: "yesterday" });
  assert.equal(replyGrants(incomplete, REFS, reply(), T0), false, "an unparseable createdAt");
  const future = setup(t).paths;
  sentOriginal(future, { createdAt: new Date(T0 + 60_000).toISOString() });
  assert.equal(replyGrants(future, REFS, reply(), T0), false, "an original dated after now");
  for (const missing of ["to", "fromSession"] as const) {
    const partial = setup(t).paths;
    sentOriginal(partial, { [missing]: undefined });
    assert.equal(replyGrants(partial, REFS, reply(), T0), false, `no ${missing}`);
  }
});

test("the session binds by id; the name counts only for a record without one", (t) => {
  const { paths } = setup(t);
  sentOriginal(paths, { fromSessionId: "s-other" });
  assert.equal(replyGrants(paths, REFS, reply(), T0), false, "another session id with a matching name");
  const legacy = setup(t).paths;
  sentOriginal(legacy, { fromSessionId: undefined });
  assert.equal(replyGrants(legacy, REFS, reply(), T0), true, "legacy record: the name");
  assert.equal(replyGrants(legacy, [SELF, "renamed"], reply(), T0), false, "legacy record: another name");
});

test("an unreadable sent record denies", (t) => {
  const { paths } = setup(t);
  fs.mkdirSync(paths.sent, { recursive: true });
  fs.writeFileSync(path.join(paths.sent, `${ORIGINAL}.json`), "{ half written");
  assert.equal(replyGrants(paths, REFS, reply(), T0), false);
  fs.rmSync(path.join(paths.sent, `${ORIGINAL}.json`));
  fs.mkdirSync(path.join(paths.sent, `${ORIGINAL}.json`));
  assert.equal(replyGrants(paths, REFS, reply(), T0), false, "a directory in its place");
});

test("policy: wake.replies is an optional boolean that needs no list; anything else disables waking", (t) => {
  const { paths } = setup(t);
  const load = (wake: unknown) => {
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake }));
    return loadPolicy(paths.policy).wake;
  };
  assert.deepEqual(load({ enabled: true, replies: true }), { sessions: [], replies: true }, "the switch alone needs no list");
  assert.deepEqual(load({ enabled: true, sessions: [], replies: true }), { sessions: [], replies: true });
  assert.deepEqual(load({ enabled: true, sessions: ["a"], replies: true }), { sessions: ["a"], replies: true });
  assert.deepEqual(load({ enabled: true, sessions: ["a"], replies: false }), { sessions: ["a"] });
  assert.deepEqual(load({ enabled: true, replies: true, codexApp: true }), { sessions: [], codexApp: true, replies: true });
  for (const replies of ["true", 1, null, {}, []]) assert.equal(load({ enabled: true, sessions: ["a"], replies }), undefined, JSON.stringify(replies));
  assert.equal(load({ enabled: false, replies: true }), undefined);
  assert.equal(load({ enabled: true, replies: false }), undefined, "an empty list still needs a grant");
  assert.equal(load({ enabled: true, sessions: ["a", 3], replies: true }), undefined);

  // doctor shows the switch, and a malformed one as a rejected section.
  load({ enabled: true, replies: true });
  assert.deepEqual(checkPolicy(paths.policy).check.wake, { enabled: true, sessions: [], codexApp: false, replies: true });
  load({ enabled: true, sessions: ["a"], replies: "yes" });
  const rejected = checkPolicy(paths.policy).check;
  assert.deepEqual([rejected.ok, rejected.wake], [false, { enabled: false, rejected: true }]);
});

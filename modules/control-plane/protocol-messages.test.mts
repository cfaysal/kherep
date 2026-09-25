import assert from "node:assert/strict";
import test from "node:test";

import { makeEnvelope, MESSAGE_TYPES, parseEnvelope } from "./protocol.mts";
import {
  isDirectoryBody, isDirectoryGetBody, isMessageAddress, isMessageDeliverBody, isMessageId, isMessageSendBody, isMessageState, isMessageStatusBody,
  isNodeMessageStatusBody, isNodeReportedState, isSessionRef, MAX_MESSAGE_TEXT, MAX_SESSION_REF, MAX_STATUS_REASON,
  MAX_DIRECTORY_SESSIONS, MESSAGE_STATES,
} from "./protocol-messages.mts";

const ID = "00000000-0000-4000-8000-00000000000a";
const NODE = "00000000-0000-4000-8000-000000000001";
const SEND = { messageId: ID, fromSession: "s1", to: { nodeId: NODE, session: "build" }, text: "hello" };
const DELIVER = { messageId: ID, from: { nodeId: NODE, session: "s1" }, toSession: "build", text: "hello", createdAt: new Date(0).toISOString() };

test("the message types pass the envelope parser", () => {
  for (const type of ["message.send", "message.deliver", "message.status", "directory.get", "directory"] as const) {
    assert.ok((MESSAGE_TYPES as readonly string[]).includes(type));
    assert.equal(parseEnvelope(JSON.stringify(makeEnvelope(type, {}, 1, 0))).ok, true);
  }
});

test("message ids, session references and states", () => {
  assert.equal(isMessageId(ID), true);
  for (const bad of ["", "x", ID.toUpperCase(), `${ID}0`, 7, null]) assert.equal(isMessageId(bad), false);
  assert.equal(isSessionRef("a"), true);
  assert.equal(isSessionRef("a".repeat(MAX_SESSION_REF)), true);
  for (const bad of ["", "a".repeat(MAX_SESSION_REF + 1), 3, undefined]) assert.equal(isSessionRef(bad), false);
  assert.deepEqual([...MESSAGE_STATES], ["queued", "accepted", "delivered", "replied", "expired", "refused"]);
  for (const state of MESSAGE_STATES) assert.equal(isMessageState(state), true);
  assert.equal(isMessageState("QUEUED"), false);
  for (const state of ["accepted", "delivered", "replied", "refused"]) assert.equal(isNodeReportedState(state), true);
  for (const state of ["queued", "expired", "done"]) assert.equal(isNodeReportedState(state), false);
});

test("message addresses admit operator only where allowed", () => {
  assert.equal(isMessageAddress({ nodeId: NODE, session: "s" }), true);
  assert.equal(isMessageAddress({ nodeId: "operator", session: "s" }), false);
  assert.equal(isMessageAddress({ nodeId: "operator", session: "s" }, true), true);
  for (const bad of [null, [], { nodeId: NODE }, { nodeId: "node-a", session: "s" }, { nodeId: NODE, session: "" }]) {
    assert.equal(isMessageAddress(bad, true), false);
  }
});

test("message.send bodies", () => {
  assert.equal(isMessageSendBody(SEND), true);
  assert.equal(isMessageSendBody({ ...SEND, inReplyTo: ID }), true);
  assert.equal(isMessageSendBody({ ...SEND, text: "x".repeat(MAX_MESSAGE_TEXT) }), true);
  const bad = [
    { ...SEND, messageId: "m1" }, { ...SEND, fromSession: "" }, { ...SEND, to: { nodeId: "operator", session: "s" } },
    { ...SEND, to: undefined }, { ...SEND, text: "" }, { ...SEND, text: "x".repeat(MAX_MESSAGE_TEXT + 1) },
    { ...SEND, inReplyTo: "not-a-uuid" }, [], null,
  ];
  for (const body of bad) assert.equal(isMessageSendBody(body), false);
});

test("message.deliver bodies", () => {
  assert.equal(isMessageDeliverBody(DELIVER), true);
  assert.equal(isMessageDeliverBody({ ...DELIVER, from: { nodeId: "operator", session: "operator@example.com" } }), true);
  const bad = [
    { ...DELIVER, messageId: undefined }, { ...DELIVER, from: { nodeId: "x", session: "s" } }, { ...DELIVER, toSession: "" },
    { ...DELIVER, text: 5 }, { ...DELIVER, inReplyTo: 1 }, { ...DELIVER, createdAt: "yesterday" }, { ...DELIVER, createdAt: undefined },
  ];
  for (const body of bad) assert.equal(isMessageDeliverBody(body), false);
});

test("message.status bodies, and the narrower node-reported form", () => {
  assert.equal(isMessageStatusBody({ messageId: ID, state: "expired" }), true);
  assert.equal(isMessageStatusBody({ messageId: ID, state: "refused", reason: "r".repeat(MAX_STATUS_REASON) }), true);
  for (const body of [
    { messageId: ID, state: "gone" }, { messageId: ID, state: "refused", reason: "" },
    { messageId: ID, state: "refused", reason: "r".repeat(MAX_STATUS_REASON + 1) }, { state: "accepted" }, null,
  ]) assert.equal(isMessageStatusBody(body), false);
  assert.equal(isNodeMessageStatusBody({ messageId: ID, state: "accepted" }), true);
  assert.equal(isNodeMessageStatusBody({ messageId: ID, state: "queued" }), false);
  assert.equal(isNodeMessageStatusBody({ messageId: ID, state: "expired" }), false);
});

test("directory.get and directory bodies", () => {
  assert.equal(isDirectoryGetBody({}), true);
  for (const bad of [{ all: true }, [], null]) assert.equal(isDirectoryGetBody(bad), false);
  const session = { nodeId: NODE, sessionId: "s1", name: "build", state: "idle", runtime: "claude-code", cwd: "/work", kind: "interactive" };
  const body = { nodes: [{ nodeId: NODE, name: "node-a", status: "online" }], sessions: [session], fetchedAt: new Date(0).toISOString() };
  assert.equal(isDirectoryBody(body), true);
  assert.equal(isDirectoryBody({ ...body, sessions: [], truncated: true }), true);
  const bad = [
    { ...body, nodes: undefined }, { ...body, nodes: [{ nodeId: "operator", name: "x", status: "online" }] },
    { ...body, nodes: [{ nodeId: NODE, name: "", status: "online" }] }, { ...body, sessions: [{ ...session, nodeId: "node-a" }] },
    { ...body, sessions: [{ ...session, state: "" }] }, { ...body, sessions: [{ ...session, startedAt: "2026-01-01" }] },
    { ...body, sessions: Array(MAX_DIRECTORY_SESSIONS + 1).fill(session) }, { ...body, fetchedAt: "now" }, { ...body, truncated: "yes" },
  ];
  for (const value of bad) assert.equal(isDirectoryBody(value), false, JSON.stringify(value).slice(0, 120));
});

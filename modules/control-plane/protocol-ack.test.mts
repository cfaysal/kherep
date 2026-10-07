import assert from "node:assert/strict";
import test from "node:test";

import {
  FINAL_MESSAGE_STATES, isFinalMessageState, isMessageReceiptBody, isMessageStatusAckBody, isMessageStatusBody, MESSAGE_STATES,
  MESSAGE_STATUS_ACK, MESSAGING_ACK_CAPABILITY, messageStatusAck,
} from "./protocol-messages.mts";

// Issue #308: the node -> Worker acknowledgement of a final message.status,
// carried as an event so that an older Worker ignores it.

const ID = "00000000-0000-4000-8000-00000000000a";

test("the ack names a final state only", () => {
  assert.equal(MESSAGE_STATUS_ACK, "message.status.ack");
  assert.equal(MESSAGING_ACK_CAPABILITY, "messaging.ack.v1");
  assert.deepEqual([...FINAL_MESSAGE_STATES], ["delivered", "replied", "refused", "expired"]);
  assert.deepEqual(MESSAGE_STATES.filter(isFinalMessageState), ["delivered", "replied", "expired", "refused"]);
  for (const state of FINAL_MESSAGE_STATES) {
    assert.deepEqual(messageStatusAck(ID, state), { name: "message.status.ack", messageId: ID, state });
    assert.equal(isMessageStatusAckBody(messageStatusAck(ID, state)), true, state);
  }
});

test("the ack body is key-strict and distinct from status and receipt bodies", () => {
  const ack = messageStatusAck(ID, "delivered");
  const bad: unknown[] = [
    { ...ack, state: "queued" }, { ...ack, state: "accepted" }, { ...ack, name: "message.receipt" }, { ...ack, messageId: "x" },
    { ...ack, reason: "extra" }, { name: ack.name, messageId: ID }, null, [], "message.status.ack",
  ];
  for (const body of bad) assert.equal(isMessageStatusAckBody(body), false, JSON.stringify(body));
  assert.equal(isMessageStatusBody(ack), false, "not a message.status body");
  assert.equal(isMessageReceiptBody(ack), false, "not a message.receipt body");
});

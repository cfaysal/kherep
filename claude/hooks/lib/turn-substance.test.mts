#!/usr/bin/env node
// Unit test for lastHandback() in turn-substance.mts (issue #555): the last
// SubagentHandback call of a subagent transcript and whether its result shows
// that it executed. The entry shape follows the repository's transcript
// fixtures (tool_use with id, tool_result in a user entry with tool_use_id).
import assert from "node:assert/strict";
import test from "node:test";

import { lastHandback, type TranscriptEntry } from "./turn-substance.mts";

const call = (id: unknown, message: unknown, name = "SubagentHandback"): TranscriptEntry => ({
  type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "closing" }, { type: "tool_use", id, name, input: { message } }] },
});
const result = (toolUseId: unknown, isError?: boolean): TranscriptEntry => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok", ...(isError === undefined ? {} : { is_error: isError }) }] },
});
const brief: TranscriptEntry = { type: "user", message: { role: "user", content: "brief" } };

test("no handback call is null", () => {
  assert.equal(lastHandback([]), null);
  assert.equal(lastHandback([brief, call("t1", "x", "Bash"), result("t1")]), null);
  assert.equal(lastHandback([{ message: null }, { message: { role: "assistant", content: "text only" } }]), null);
});

test("a call with its result is ok, an error result is error, no result is unknown", () => {
  assert.deepEqual(lastHandback([brief, call("t1", "OBS-RESULT: empty none"), result("t1")]),
    { id: "t1", message: "OBS-RESULT: empty none", result: "ok" });
  assert.deepEqual(lastHandback([brief, call("t1", "m"), result("t1", false)]), { id: "t1", message: "m", result: "ok" });
  assert.deepEqual(lastHandback([brief, call("t1", "m"), result("t1", true)]), { id: "t1", message: "m", result: "error" });
  assert.deepEqual(lastHandback([brief, call("t1", "m")]), { id: "t1", message: "m", result: "unknown" });
  assert.deepEqual(lastHandback([brief, call("t1", "m"), result("t2")]), { id: "t1", message: "m", result: "unknown" });
});

test("the last handback wins, and only results after it count", () => {
  assert.deepEqual(lastHandback([brief, call("t1", "first"), result("t1"), call("t2", "second")]),
    { id: "t2", message: "second", result: "unknown" });
  assert.deepEqual(lastHandback([result("t1"), call("t1", "m")]), { id: "t1", message: "m", result: "unknown" });
});

test("a non-string message or id is null, and an id-less call is never confirmed", () => {
  assert.deepEqual(lastHandback([call("t1", 42), result("t1")]), { id: "t1", message: null, result: "ok" });
  assert.deepEqual(lastHandback([call(undefined, "m"), result(undefined)]), { id: null, message: "m", result: "unknown" });
});

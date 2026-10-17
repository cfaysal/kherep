import assert from "node:assert/strict";
import test from "node:test";

import { AUTH_OK, command, deliver, flush, intakeHarness, messageId } from "./daemon-intake-fixture.mts";

// Issue #441: the daemon logged nothing during an intake stall. A lane item
// over the threshold and a delivery stored long after the control plane
// accepted it are each logged once, with kinds and ids, never content.

const SECRET_TEXT = "synthetic-confidential-body";
const SECRET_SESSION = "synthetic-confidential-session";

test("a lane item over the threshold is logged once with its kind and without content", async (t) => {
  const h = intakeHarness(t, { daemonOptions: { slowLaneMs: 10 } });
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  socket.message(command(1, "session.list"));
  await flush();
  socket.message(deliver(1, SECRET_SESSION, { text: SECRET_TEXT }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  h.release([{ runtime: "claude", sessionId: SECRET_SESSION, state: "idle" }]);
  await flush();
  assert.equal(h.logs.filter((line) => /lane chain item command:session\.list took [\d.]+ s/.test(line)).length, 1, h.logs.join("\n"));
  assert.ok(h.logs.every((line) => !line.includes(SECRET_TEXT) && !line.includes(SECRET_SESSION)), h.logs.join("\n"));
});

test("a delivery stored long after accept logs the id and the lane wait", async (t) => {
  const h = intakeHarness(t, { daemonOptions: { intakeSlowMs: 0 } });
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  socket.message(deliver(2, SECRET_SESSION, { text: SECRET_TEXT, createdAt: new Date(Date.now() - 60_000).toISOString() }));
  await flush();
  const lines = h.logs.filter((line) => line.includes(`message ${messageId(2)} stored`));
  assert.equal(lines.length, 1, h.logs.join("\n"));
  assert.match(lines[0]!, /stored [\d.]+ s after control-plane accept \(lane wait [\d.]+ s\)/);
  assert.ok(Number(/stored ([\d.]+) s/.exec(lines[0]!)![1]) >= 59);
  assert.ok(h.logs.every((line) => !line.includes(SECRET_TEXT) && !line.includes(SECRET_SESSION)));
});

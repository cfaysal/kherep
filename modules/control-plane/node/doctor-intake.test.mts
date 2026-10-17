import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { checkIntakeLatency } from "./doctor-intake.mts";

// Issue #441: how long stored messages waited between the control plane's
// accept (createdAt) and this node's store (receivedAt), over the last two
// hours. Counts and times only; no ids, text or sender names.

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-intake-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

function write(dir: string, n: number, createdAt: number, receivedAt: number): string {
  const messageId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${messageId}.json`), JSON.stringify({ messageId, from: { nodeId: "n", session: "synthetic-sender" },
    toSession: "synthetic-target", text: "synthetic text", createdAt: iso(createdAt), receivedAt: iso(receivedAt), state: "accepted", depth: 0 }));
  return messageId;
}

test("records within the window are counted and one over the threshold fails the check", (t) => {
  const paths = fixture(t);
  const ids = [
    write(paths.inbox, 1, NOW - 60_000, NOW - 58_000),
    write(paths.inbox, 2, NOW - 3_600_000, NOW - 3_600_000 + 301_000),
    write(paths.inbox, 3, NOW - 3 * 3_600_000, NOW - 3 * 3_600_000 + 900_000),
  ];
  fs.writeFileSync(path.join(paths.inbox, `.${ids[0]}.json.tmp`), "{");
  fs.mkdirSync(path.join(paths.inbox, "receipts"), { recursive: true });
  const check = checkIntakeLatency(paths, NOW);
  assert.deepEqual(check, { ok: false, observed: 2, maxLatencySeconds: 301, overThreshold: 1, lastReceivedAt: iso(NOW - 58_000) });
  const text = JSON.stringify(check);
  assert.ok(ids.every((id) => !text.includes(id)) && !text.includes("synthetic"), "no ids, names or text");
});

test("a missing inbox counts zero", (t) => {
  assert.deepEqual(checkIntakeLatency(fixture(t), NOW),
    { ok: true, observed: 0, maxLatencySeconds: 0, overThreshold: 0, lastReceivedAt: null });
});

test("an inbox replaced by a file fails with a fixed reason", (t) => {
  const paths = fixture(t);
  fs.mkdirSync(path.dirname(paths.inbox), { recursive: true });
  fs.writeFileSync(paths.inbox, "not a directory");
  assert.deepEqual(checkIntakeLatency(paths, NOW), { ok: false, detail: "the inbox directory is unreadable" });
});

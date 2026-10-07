import assert from "node:assert/strict";
import test from "node:test";

import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, reconnectDelay, retryDelay } from "./backoff.mts";

test("grows exponentially with jitter inside [ceiling/2, ceiling]", () => {
  assert.equal(reconnectDelay(0, () => 0), 500);
  assert.equal(reconnectDelay(0, () => 1), 1_000);
  assert.equal(reconnectDelay(3, () => 0), 4_000);
  assert.equal(reconnectDelay(3, () => 1), 8_000);
});

test("never exceeds 60 seconds, even for large or odd attempts", () => {
  for (const attempt of [6, 10, 50, 1e9, Number.POSITIVE_INFINITY]) {
    for (const r of [0, 0.5, 1, 2]) assert.ok(reconnectDelay(attempt, () => r) <= BACKOFF_MAX_MS);
  }
  assert.equal(reconnectDelay(100, () => 1), BACKOFF_MAX_MS);
  assert.equal(reconnectDelay(-5, () => 0), 500);
});

test("spreads delays with the default random source", () => {
  const delays = new Set(Array.from({ length: 50 }, () => reconnectDelay(8)));
  assert.ok(delays.size > 1);
});

test("retryDelay applies the same equal jitter to any base and cap", () => {
  const resend = { baseMs: 30_000, maxMs: 600_000 };
  assert.deepEqual([0, 1, 4, 5, 9].map((attempt) => retryDelay(attempt, resend, () => 0)), [15_000, 30_000, 240_000, 300_000, 300_000]);
  assert.deepEqual([0, 1, 4, 5, 9].map((attempt) => retryDelay(attempt, resend, () => 1)), [30_000, 60_000, 480_000, 600_000, 600_000]);
  assert.equal(reconnectDelay(3, () => 0.25), retryDelay(3, { baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS }, () => 0.25));
});

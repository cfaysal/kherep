import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { HOT_MESSAGE_QUERIES } from "../src/message-store.mts";
import type { Registry } from "../src/registry.mts";
import type { SqlRows } from "../src/sql-meter.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #308: one Registry request must read a bounded number of SQLite rows,
// however many final-state messages the table holds.
const M = 2000;
const SESSIONS = 500;
const BOUND = 32;
const SEED_SENDER = "00000000-0000-4000-8000-00000000c0de";
const REPLAY_NODE = "00000000-0000-4000-8000-00000000beef";

// Seeds final-state messages straight into SQLite, outside the meter.
async function seed(from: string, to: string, prefix: string, count: number): Promise<void> {
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO messages (id, from_node, from_session, to_node, to_session, text, state, created_at, updated_at, expires_at)
      SELECT ? || i, ?, 's', ?, 't', NULL, CASE i % 3 WHEN 0 THEN 'delivered' WHEN 1 THEN 'refused' ELSE 'expired' END, i, i, i
      FROM n`, count, prefix, from, to);
  });
}

// The rows one Registry request path logged.
async function measure(path: string, call: (instance: Registry) => unknown): Promise<SqlRows> {
  const log = vi.spyOn(console, "log");
  try {
    await runInDurableObject(registry(), async (instance) => { await call(instance); });
    const lines = log.mock.calls.map(([line]) => line as { event?: string; path?: string } & SqlRows)
      .filter((line) => line?.event === "registry.sql" && line.path === path);
    expect(lines).toHaveLength(1);
    return { rowsRead: lines[0]!.rowsRead, rowsWritten: lines[0]!.rowsWritten };
  } finally {
    log.mockRestore();
  }
}

async function round(sender: string, target: string, label: string) {
  const messageId = crypto.randomUUID();
  const send = await measure("sendMessage", (r) => r.sendMessage({
    messageId, from: { nodeId: sender, session: "s" }, to: { nodeId: target, session: "t" }, text: label,
  }, "test"));
  const report = await measure("reportMessageStatus", (r) => r.reportMessageStatus(target, { messageId, state: "accepted" }));
  await measure("setStatus", (r) => r.setStatus(target, "online", Date.now()));
  const directory = await measure("directory", (r) => r.directory());
  const cached = await measure("directory", (r) => r.directory());
  const replay = await measure("messageStatusPageFor", (r) => r.messageStatusPageFor(REPLAY_NODE, 0, 128));
  return { send, report, directory, cached, replay };
}

describe("Registry read budget", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads a bounded number of rows per request, independent of the message count", async () => {
    const sender = await enroll(await newKey(), "budget-sender");
    const target = await enroll(await newKey(), "budget-target");
    await registry().updateRegistration(target, FACTS, [], [MESSAGING_CAPABILITY]);
    await registry().replaceSessions(target, Array.from({ length: SESSIONS }, (_, i) => ({
      sessionId: `session-${i}`, runtime: "claude-code", state: "idle",
    })));
    await seed(REPLAY_NODE, target, "replay-", 3);
    await seed(SEED_SENDER, target, "seed-a-", M);

    const first = await round(sender, target, "first");
    await seed(SEED_SENDER, target, "seed-b-", M);
    const second = await round(sender, target, "second");

    // The meter counts in workerd: an uncached directory reads every session.
    expect(first.directory.rowsRead).toBeGreaterThanOrEqual(SESSIONS);
    for (const path of ["send", "report", "cached", "replay"] as const) {
      expect(first[path].rowsRead, path).toBeLessThanOrEqual(BOUND);
    }
    expect(first.cached.rowsRead).toBe(0);
    expect(second).toEqual(first);

    const totals = await runInDurableObject(registry(), (instance) => instance.sqlStats());
    expect(totals.rowsRead).toBeGreaterThanOrEqual(first.directory.rowsRead + second.directory.rowsRead);
  });

  it("plans the hot message queries without scanning the messages table", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const plans = Object.entries(HOT_MESSAGE_QUERIES).map(([name, { sql, args }]) => [name,
        state.storage.sql.exec(`EXPLAIN QUERY PLAN ${sql}`, ...args).toArray().map((row) => String(row.detail)).join("; ")]);
      expect(Object.fromEntries(plans)).toEqual({
        expireDue: expect.stringContaining("USING INDEX messages_queued_expiry"),
        nextExpiry: expect.stringContaining("messages_queued_expiry"),
        statusPage: expect.stringContaining("USING INDEX messages_from_node"),
      });
      for (const [name, plan] of plans) expect(plan, name).not.toMatch(/SCAN messages/);
    });
  });
});

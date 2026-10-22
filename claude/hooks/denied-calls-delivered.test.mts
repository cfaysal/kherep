// Issue #504. The delivery recorder (PostToolUse on SubagentHandback) run the way the settings
// template wires it, through kherep/hook-runtime/entry.mts reader in a temporary home: a delivered
// line for a delegated handback, nothing otherwise, never output, always exit 0, within its cap.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { denialFaultEnv, faultSpan, MARKER_SLOW_MS } from "./denial-fault.fixture.mts";
import { cleanup, entry, runtimeHome, type Home } from "./hook-runtime-fixture.mts";
import { journalPaths } from "./lib/denial-journal.mts";
import { readJournal, renderReport } from "./lib/denial-report.mts";

after(cleanup);
const RECORDER = "denied-calls-delivered.mts";

function home(): Home {
  const h = runtimeHome("denied-calls-delivered-");
  fs.copyFileSync(path.join(import.meta.dirname, RECORDER), path.join(h.hooks, RECORDER));
  for (const lib of ["denial-journal.mts", "workspace-scope.mts"]) fs.copyFileSync(path.join(import.meta.dirname, "lib", lib), path.join(h.hooks, "lib", lib));
  return h;
}
const payload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "SubagentHandback",
  tool_input: { message: "the worker's report" }, tool_response: "ok", agent_id: "agent-d1", tool_use_id: "toolu_h", cwd: "/w", ...extra });
const record = (h: Home, input: string, env: NodeJS.ProcessEnv = process.env) => entry("reader", path.join(h.hooks, RECORDER), [], input, 20_000, env);

test("a delegated handback leaves one delivered line and nothing of the report; no output, exit 0", () => {
  const h = home();
  fs.mkdirSync(journalPaths(h.root, "agent-d1").dir, { recursive: true });
  fs.writeFileSync(journalPaths(h.root, "agent-d1").journal, `${JSON.stringify({ v: 1, kind: "call", at: "2026-10-21T00:00:00.000Z", id: "t", tool: "Read", agent_type: null, decision: "none", denials: [] })}\n`);
  const run = record(h, payload());
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, "", ""]);
  const text = fs.readFileSync(journalPaths(h.root, "agent-d1").journal, "utf8");
  const last = JSON.parse(text.trim().split("\n").at(-1)!);
  assert.deepEqual([last.v, last.kind, last.id], [1, "delivered", "toolu_h"]);
  assert.ok(!text.includes("report"), "nothing of tool_input.message");
  assert.match(renderReport(readJournal(h.root, "agent-d1")).text, /^DENIED-CALLS: none\nstatus: delivered \d{4}-/);
});

test("nothing without a valid agent_id, for another tool, or for input that is no JSON object", () => {
  const h = home();
  for (const input of [payload({ agent_id: undefined }), payload({ agent_id: "x/y" }), payload({ tool_name: "Read" }), "[]", "nope", ""]) {
    const run = record(h, input);
    assert.deepEqual([run.status, run.stdout], [0, ""]);
  }
  assert.equal(fs.existsSync(journalPaths(h.root, "x").dir), false);
});

test("a write that fails leaves the marker, exit 0", () => {
  const failed = home();
  assert.equal(record(failed, payload(), denialFaultEnv("journal-enospc", RECORDER)).status, 0);
  assert.equal(fs.readFileSync(journalPaths(failed.root, "agent-d1").marker, "utf8"), "append\n");
});

// Issue #614. The recorder exits through process.exit(0), which abandons a pending fs.promises write, so the
// marker write is awaited until the recorder's deadline (5.5 s after its start, under the entry's timeout 10)
// instead of a fixed 400 ms slice. Red against the previous recorder: with the append settling after 700 ms
// the read saw ENOENT.
test("a marker append that settles late: the marker is on disk when the recorder has exited", () => {
  const slow = home();
  const run = record(slow, payload(), denialFaultEnv("marker-slow", RECORDER));
  assert.deepEqual([run.status, run.stdout], [0, ""]);
  assert.equal(fs.readFileSync(journalPaths(slow.root, "agent-d1").marker, "utf8"), "append\n");
  assert.ok(run.ms >= MARKER_SLOW_MS, `${run.ms} ms: the recorder waited for the append`);
});

// The journal write ends within its 1.5 s cap; a marker write that never settles is given up at the
// recorder's deadline, 5.5 s after its start (issue #614), before the entry's hook timeout of 10 s.
// Issue #653: measured inside the recorder from its time origin, the anchor of its DEADLINE, by the
// fault receipt; DEADLINE_MS restates denied-calls-delivered.mts HOOK_TIMEOUT_MS - SAFETY_MARGIN_MS.
const DEADLINE_MS = 5_500, LATE_MS = 500, NO_RECEIPT = "no fault receipt: the child was killed or the fault did not engage";
test("a write that never settles: exit 0 before the recorder deadline, the marker given up there", (t) => {
  const stalled = home();
  const receipt = path.join(stalled.root, "fault-receipt.json");
  const run = record(stalled, payload(), denialFaultEnv("all-hang", RECORDER, process.env, receipt));
  assert.equal(run.signal, null, `killed after ${run.ms} ms`);
  assert.deepEqual([run.status, run.stdout], [0, ""]);
  assert.equal(fs.existsSync(journalPaths(stalled.root, "agent-d1").marker), false, "nothing settled, so no marker: the named residual");
  const { ops, ms } = faultSpan(receipt, "origin");
  t.diagnostic(JSON.stringify({ childMs: run.ms, spanMs: ms, ops }));
  assert.ok(ms !== undefined, `${NO_RECEIPT} (childMs ${run.ms}, signal ${run.signal})`);
  // The journal's mkdir hangs to the cap, then the marker append directly, to the deadline.
  assert.deepEqual(ops, ["mkdir:dir", "appendFile:.failed"]);
  assert.ok(ms < DEADLINE_MS + LATE_MS, `the recorder held ${ms} ms`);
  assert.ok(ms >= DEADLINE_MS - 500, `the deadline was abandoned early: ${ms} ms`);
});

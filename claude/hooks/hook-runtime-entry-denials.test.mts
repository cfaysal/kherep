// Issue #504. kherep/hook-runtime/entry.mts journals its own PreToolUse denies of a delegated run (a
// payload with a valid agent_id, not the handback): one entry-deny line with the fixed label text,
// nothing else from the payload. The write and its fallback stay within OUTER_DEADLINE - 200 ms; a
// writer that never settles (a test preload, no environment seam in the entry) leaves the deny as is.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { denialFaultEnv, faultSpan, MARKER_SLOW_MS, type DenialFault } from "./denial-fault.fixture.mts";
import { cleanup, entry, runtimeHome, type Home, type Run } from "./hook-runtime-fixture.mts";
import { journalPaths } from "./lib/denial-journal.mts";
import { readJournal, renderReport } from "./lib/denial-report.mts";

after(cleanup);
const payload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
  tool_input: { command: "git push" }, cwd: "/w", agent_id: "agent-e1", tool_use_id: "toolu_9", ...extra });
// A main that does not exist: the entry denies (not admitted: main-missing) before any guard runs.
const denied = (home: Home, input: string, env: NodeJS.ProcessEnv = process.env) => entry("pretool", path.join(home.hooks, "absent.mts"), [], input, 40_000, env);
const journalOf = (home: Home): string => journalPaths(home.root, "agent-e1").journal;

test("a pretool deny of a delegated call is one entry-deny line with the fixed label, no path", () => {
  const home = runtimeHome("entry-denials-");
  const run = denied(home, payload());
  assert.equal(run.status, 0, run.stderr);
  const reason = JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason;
  const lines = fs.readFileSync(journalOf(home), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], at: undefined }, { v: 1, kind: "entry-deny", at: undefined, id: "toolu_9", tool: "Bash", reason });
  assert.equal(reason, "[hook-entry] absent.mts cannot run (not admitted: main-missing); the tool call is blocked until hook integrity restores it");
  assert.ok(!fs.readFileSync(journalOf(home), "utf8").includes(home.root), "no absolute path");
  assert.equal(renderReport(readJournal(home.root, "agent-e1")).text.split("\n")[0], "DENIED-CALLS: 1");
});

test("nothing is journalled without a valid agent_id, for the handback, or for a payload over 1 MiB", () => {
  const home = runtimeHome("entry-denials-");
  for (const input of [payload({ agent_id: undefined }), payload({ agent_id: "a/b" }), payload({ tool_name: "SubagentHandback" }),
    payload({ tool_input: { command: "x".repeat(1_100_000) } }), "not json"]) {
    const run = denied(home, input);
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal(fs.existsSync(journalPaths(home.root, "x").dir), false);
});

interface Faulted { home: Home; run: Run; reference: Run; receipt: string }
function faulted(fault: DenialFault): Faulted {
  const home = runtimeHome("entry-denials-");
  const reference = denied(runtimeHome("entry-denials-"), payload());
  const receipt = path.join(home.root, "fault-receipt.json");
  const run = denied(home, payload(), denialFaultEnv(fault, "entry.mts", process.env, receipt));
  assert.equal(run.signal, null, `killed by ${run.signal} after ${run.ms} ms`);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, reference.stdout, "the deny is unchanged");
  return { home, run, reference, receipt };
}

test("ENOSPC on the journal: a marker, the renderer reads unknown (capture-failed)", () => {
  const { home } = faulted("journal-enospc");
  assert.equal(fs.readFileSync(journalPaths(home.root, "agent-e1").marker, "utf8"), "append\n");
  assert.equal(renderReport(readJournal(home.root, "agent-e1")).text.split("\n")[0], "DENIED-CALLS: unknown (capture-failed)");
});

// Issue #614. finish() exits through process.exit, which abandons a pending fs.promises write, so the marker
// write is awaited until OUTER_DEADLINE - 2_000 instead of a fixed 400 ms slice. Red against the previous entry:
// with the append settling after 700 ms the read saw ENOENT.
test("a marker append that settles late: the marker is on disk when the entry has exited", () => {
  const { home, run } = faulted("marker-slow");
  assert.equal(fs.readFileSync(journalPaths(home.root, "agent-e1").marker, "utf8"), "append\n");
  assert.equal(renderReport(readJournal(home.root, "agent-e1")).text.split("\n")[0], "DENIED-CALLS: unknown (capture-failed)");
  assert.ok(run.ms >= MARKER_SLOW_MS, `${run.ms} ms: the entry waited for the append`);
});

// Issue #661: both windows are read inside the entry from the fault receipt, never as its wall clock against a
// reference run. The cap runs from the mkdir stamp (one microtask after settled() armed its timer) to the marker
// append (microtasks after that timer fired); the deadline from the entry's START itself, the first Date.now() of
// the entry process, whose caller the receipt names and this test checks. Restated from entry.mts, never read:
// the cap is capBefore(500, end) at :197; the deadline is OUTER_DEADLINE (:30, START + 28_000) less 2_000 (:199).
const JOURNAL_CAP_MS = 500, CAP_EARLY_MS = 200, CAP_LATE_MS = 500;
const DEADLINE_MS = 26_000, DEADLINE_EARLY_MS = 500, DEADLINE_LATE_MS = 1_000;
const NO_RECEIPT = "no fault receipt: the entry was killed or the fault did not engage";
const START_LINE = /^const START = Date\.now\(\);$/m;
function windows(t: TestContext, { home, run, reference, receipt }: Faulted, ops: string[]): { capMs: number; deadlineMs: number } {
  const { doc, ops: seen, ms: deadlineMs } = faultSpan(receipt, "main-start");
  const marker = doc?.calls.find((call) => call.tail === ".failed"), first = doc?.calls[0];
  const capMs = marker && first ? marker.at - first.at : undefined;
  t.diagnostic(JSON.stringify({ referenceMs: reference.ms, childMs: run.ms, startDeltaMs: doc?.firstNow ? doc.firstNow.at - doc.startAt : undefined,
    capMs, deadlineMs, firstCallMs: faultSpan(receipt, "first-call").ms, from: doc?.firstNow?.from, ops: seen }));
  assert.ok(doc, `${NO_RECEIPT} (childMs ${run.ms}, signal ${run.signal})`);
  const source = fs.readFileSync(path.join(home.runtime, "entry.mts"), "utf8");
  const line = source.slice(0, START_LINE.exec(source)?.index ?? -1).split("\n").length;
  assert.equal(doc.firstNow?.from, `entry.mts:${line}:20`, "the deadline anchor is the entry's START");
  assert.deepEqual(seen, ops);
  assert.ok(capMs !== undefined && deadlineMs !== undefined);
  assert.ok(capMs < JOURNAL_CAP_MS + CAP_LATE_MS, `capture held ${capMs} ms`);
  assert.ok(capMs >= JOURNAL_CAP_MS - CAP_EARLY_MS, `capture window abandoned early: ${capMs} ms`);
  return { capMs, deadlineMs };
}

test("a journal append that never settles (journal-hang): the deny within the journal cap, a marker", (t) => {
  const f = faulted("journal-hang");
  assert.equal(fs.readFileSync(journalPaths(f.home.root, "agent-e1").marker, "utf8"), "append\n");
  windows(t, f, ["mkdir:dir", "appendFile:.jsonl", "appendFile:.failed"]);
});

// The journal write ends within its 500 ms cap; a marker write that never settles is given up at
// OUTER_DEADLINE - 2_000, 26 s after the entry's start (issue #614): the deny arrives late but before the 30 s cancel.
test("a writer that never settles (all-hang): the deny after OUTER_DEADLINE - 2_000, the marker given up there", (t) => {
  const f = faulted("all-hang");
  assert.equal(fs.existsSync(journalPaths(f.home.root, "agent-e1").marker), false, "nothing settled, so no marker: the named residual");
  const { deadlineMs } = windows(t, f, ["mkdir:dir", "appendFile:.failed"]);
  assert.ok(deadlineMs < DEADLINE_MS + DEADLINE_LATE_MS, `the entry held ${deadlineMs} ms`);
  assert.ok(deadlineMs >= DEADLINE_MS - DEADLINE_EARLY_MS, `the deadline was abandoned early: ${deadlineMs} ms`);
});

// Review P3-10 and issue #614: the journal cap of journalDeny is capBefore(500, end) with end = OUTER_DEADLINE - 200
// and the marker write is awaited until OUTER_DEADLINE - 2_000, so a deny reached late never writes past either bound.
// Issue #661: START is the entry's first Date.now() (the all-hang anchor) and OUTER_DEADLINE is START + 28_000.
test("the entry's journal cap ends at OUTER_DEADLINE - 200 ms, its marker wait at OUTER_DEADLINE - 2_000 ms", async () => {
  const file = path.join(import.meta.dirname, "..", "kherep", "hook-runtime", "entry.mts");
  const { capBefore } = await import(pathToFileURL(file).href) as { capBefore: (limit: number, end: number, now?: number) => number };
  assert.deepEqual([capBefore(500, 10_000, 9_000), capBefore(500, 10_000, 9_700), capBefore(400, 10_000, 10_050)], [500, 300, 0]);
  const source = fs.readFileSync(file, "utf8");
  assert.ok(START_LINE.test(source), "START is the entry's first Date.now(), the all-hang anchor");
  assert.ok(/^const OUTER_DEADLINE = START \+ 28_000;$/m.test(source), "OUTER_DEADLINE is START + 28_000");
  const body = /async function journalDeny[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
  assert.match(body, /end = OUTER_DEADLINE - 200\b/);
  assert.equal(body.match(/\bsettled\(/g)?.length ?? 0, 2);
  assert.equal(body.match(/, capBefore\(500, end\)\)/g)?.length ?? 0, 1, "the journal write is capped at 500 ms before end");
  assert.equal(body.match(/, OUTER_DEADLINE - 2_000 - Date\.now\(\)\)/g)?.length ?? 0, 1, "the marker write is awaited until OUTER_DEADLINE - 2_000 (issue #614)");
});

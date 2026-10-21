// Issue #504. The read side of the denied-call journal: every state and its code, `none` only on
// positive evidence, dedupe across the dispatcher processes of one call, order and cap of the
// rendered list, the status line, the operator list and prune.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { journalPaths } from "./denial-journal.mts";
import { LIST_CAP, listRows, prune, readJournal, renderReport } from "./denial-report.mts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "denial-report-"));
  roots.push(root);
  fs.mkdirSync(journalPaths(root, "a1").dir, { recursive: true });
  return root;
}
const at = (n: number): string => new Date(Date.UTC(2026, 9, 21, 0, 0, n)).toISOString();
const call = (n: number, id: string | null, tool: string, denials: object[] = [], extra = {}) =>
  JSON.stringify({ v: 1, kind: "call", at: at(n), id, tool, agent_type: "general-purpose", decision: denials.length ? "deny" : "none", denials, ...extra });
const denial = (guard: string, target = "-", reason = `[${guard}] no`) => ({ guard, target, reason, broken: false });
const write = (root: string, lines: string[], id = "a1"): void => fs.writeFileSync(journalPaths(root, id).journal, lines.map((l) => `${l}\n`).join(""));
const render = (root: string, id = "a1") => renderReport(readJournal(root, id));
const first = (root: string, id = "a1") => render(root, id).text.split("\n")[0];

test("none needs a parsed journal with a call line, no marker, no denial and no entry-deny", () => {
  const root = home();
  write(root, [call(1, "t1", "Read"), call(2, "t2", "Bash")]);
  assert.deepEqual(render(root), { text: "DENIED-CALLS: none\nstatus: no delivery recorded (worker still running, no handback, or not an auto-mode subagent)\n", exit: 0 });
});

test("every state without positive evidence is unknown with one code and exit 3", () => {
  const root = home();
  assert.equal(first(root, "../x"), "DENIED-CALLS: unknown (no-agent-id)");
  assert.equal(first(root, ""), "DENIED-CALLS: unknown (no-agent-id)");
  assert.equal(first(root), "DENIED-CALLS: unknown (journal-missing)");
  assert.equal(render(root).exit, 3);
  write(root, [JSON.stringify({ v: 1, kind: "delivered", at: at(1), id: "h" })]);
  assert.equal(first(root), "DENIED-CALLS: unknown (no-calls)");
  write(root, [call(1, "t1", "Read"), "{not json"]);
  assert.equal(first(root), "DENIED-CALLS: unknown (journal-corrupt)");
  fs.writeFileSync(journalPaths(root, "a1").journal, `${call(1, "t1", "Read")}\n{"v":1,"kind":"ca`);
  assert.equal(first(root), "DENIED-CALLS: unknown (journal-corrupt)", "a partial last line");
  write(root, [JSON.stringify({ v: 2, kind: "call", at: at(1), tool: "Read", denials: [] })]);
  assert.equal(first(root), "DENIED-CALLS: unknown (journal-corrupt)", "another version");
  write(root, [call(1, "t1", "Read", [{ guard: 1 }])]);
  assert.equal(first(root), "DENIED-CALLS: unknown (journal-corrupt)", "a denial of another shape");
  fs.rmSync(journalPaths(root, "a1").journal);
  fs.mkdirSync(journalPaths(root, "a1").journal);
  assert.equal(first(root), "DENIED-CALLS: unknown (journal-unreadable)");
});

test("a marker wins over every other state, whatever its content, also a renamed journal", () => {
  const root = home();
  write(root, [call(1, "t1", "Read")]);
  fs.writeFileSync(journalPaths(root, "a1").marker, "");
  assert.deepEqual([first(root), render(root).exit], ["DENIED-CALLS: unknown (capture-failed)", 3]);
  fs.rmSync(journalPaths(root, "a1").journal);
  fs.writeFileSync(journalPaths(root, "a1").marker, `${call(1, "t1", "Read")}\n${JSON.stringify({ v: 1, kind: "delivered", at: at(9), id: "h" })}\n`);
  assert.equal(render(root).text, `DENIED-CALLS: unknown (capture-failed)\nstatus: delivered ${at(9)}\n`);
});

test("denials: deduplicated by (id, guard) across dispatcher processes, id null never merged, entry-deny listed", () => {
  const root = home();
  write(root, [
    call(1, "t1", "Bash", [denial("commit-guard", "git")]),
    call(1, "t1", "Bash", [denial("commit-guard", "git")]),
    call(1, "t1", "Bash", [denial("main-checkout-guard", "git")]),
    call(2, null, "Read", [denial("secret-output")]),
    call(3, null, "Read", [denial("secret-output")]),
    JSON.stringify({ v: 1, kind: "entry-deny", at: at(4), id: "t4", tool: "Bash", reason: "[hook-entry] guard-dispatch.mts cannot run (exit code 1)" }),
  ]);
  const { text, exit } = render(root);
  assert.equal(exit, 0);
  assert.deepEqual(text.split("\n").slice(0, 6), [
    "DENIED-CALLS: 5",
    "- Bash git [commit-guard] no",
    "- Bash git [main-checkout-guard] no",
    "- Read - [secret-output] no",
    "- Read - [secret-output] no",
    "- Bash - [hook-entry] guard-dispatch.mts cannot run (exit code 1)",
  ]);
});

test("an entry-deny alone counts; a call line with denials is never none", () => {
  const root = home();
  write(root, [JSON.stringify({ v: 1, kind: "entry-deny", at: at(1), id: null, tool: null, reason: "r" })]);
  assert.equal(first(root), "DENIED-CALLS: 1");
});

test("write tools first, then by time; at most LIST_CAP lines and the rest on the count line", () => {
  const root = home();
  const lines = Array.from({ length: LIST_CAP + 5 }, (_, i) => call(10 + (i % 50), `t${i}`, "Bash", [denial("g")]));
  write(root, [call(99, "w1", "Edit", [denial("privacy-boundary", "<withheld>")]), ...lines]);
  const out = render(root).text.split("\n");
  assert.equal(out[0], `DENIED-CALLS: ${LIST_CAP + 6} (+6 more)`);
  assert.equal(out[1], "- Edit <withheld> [privacy-boundary] no");
  assert.equal(out.filter((line) => line.startsWith("- ")).length, LIST_CAP);
  assert.ok(out[2]!.startsWith("- Bash"));
});

test("the status line names the last delivered line", () => {
  const root = home();
  write(root, [call(1, "t1", "Read"), JSON.stringify({ v: 1, kind: "delivered", at: at(5), id: "h1" })]);
  assert.equal(render(root).text, `DENIED-CALLS: none\nstatus: delivered ${at(5)}\n`);
});

test("render never produces list rows; list is a labelled diagnostic, newest first, within its window", () => {
  const root = home();
  write(root, [call(1, "t1", "Read", [], { agent_type: "Explore" })], "e1");
  write(root, [call(1, "t1", "Read", [denial("g")])], "b1");
  const now = Date.now();
  fs.utimesSync(journalPaths(root, "e1").journal, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
  fs.writeFileSync(journalPaths(root, "m1").marker, "append\n");
  fs.utimesSync(journalPaths(root, "m1").marker, new Date(now - 90 * 60_000), new Date(now - 90 * 60_000));
  const rows = listRows(root, 60 * 60_000, now);
  assert.equal(rows[0], "# operator diagnostic only, never acceptance evidence");
  assert.deepEqual(rows.slice(1).map((row) => row.split(" ").slice(0, 2).join(" ")), ["b1 general-purpose", "e1 Explore"]);
  assert.match(rows[1]!, / 1 denied not delivered$/);
  assert.match(listRows(root, 120 * 60_000, now).at(-1)!, /^m1 - .* unknown \(capture-failed\) not delivered$/);
  for (const id of ["e1", "b1", "m1", "zz"]) assert.ok(!render(root, id).text.includes("operator diagnostic"));
  assert.deepEqual(listRows(home(), 60_000), ["# operator diagnostic only, never acceptance evidence", "(no journal in the window)"]);
});

test("prune removes a pair only when its newest file is older than 24 h, never a marker beside a young journal", () => {
  const root = home();
  const now = Date.now();
  const old = new Date(now - 25 * 3_600_000);
  write(root, [call(1, "t1", "Read")], "o1");
  fs.writeFileSync(journalPaths(root, "o1").marker, "append\n");
  for (const file of [journalPaths(root, "o1").journal, journalPaths(root, "o1").marker]) fs.utimesSync(file, old, old);
  write(root, [call(1, "t1", "Read")], "y1");
  fs.writeFileSync(journalPaths(root, "y1").marker, "append\n");
  fs.utimesSync(journalPaths(root, "y1").marker, old, old);
  fs.writeFileSync(path.join(journalPaths(root, "x").dir, "README"), "kept");
  assert.equal(prune(root, now), 1);
  assert.deepEqual(fs.readdirSync(journalPaths(root, "x").dir).sort(), ["README", "y1.failed", "y1.jsonl"]);
  assert.equal(prune(path.join(root, "absent"), now), 0);
});

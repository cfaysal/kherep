import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const OWNER = "11111111-1111-7111-8111-111111111111";
const CHILD = "22222222-2222-7222-8222-222222222222";
const entry = path.join(import.meta.dirname, "fixtures", "busy-owner-probe.mts");

function probe(t: test.TestContext, extra: Record<string, unknown> = {}) {
  assert.ok(fs.existsSync(entry), "native metadata probe entry point is not implemented");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-busy-owner-"));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "booleans.jsonl");
  const marker = path.join(dir, "synthetic-marker.txt");
  fs.writeFileSync(marker, "PROBE374-SYNTHETIC");
  const payload = {
    hook_event_name: "PostToolUse", session_id: OWNER,
    transcript_path: `/synthetic/rollout-2026-10-10T13-00-00-${OWNER}.jsonl`,
    ...extra,
  };
  const result = spawnSync(process.execPath, [entry, "--owner", OWNER, "--out", output, "--marker-file", marker], {
    input: JSON.stringify(payload), encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const records = fs.existsSync(output)
    ? fs.readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { result, records };
}

test("diagnostic owner receives structured additional context and boolean evidence only", (t) => {
  const { result, records } = probe(t);
  const context = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, "PostToolUse");
  assert.match(context.additionalContext, /PROBE374-SYNTHETIC/);
  assert.deepEqual(records, [{ eventMatches: true, sessionMatches: true,
    threadMatches: true, childFieldsPresent: false, ownerGateAllows: true }]);
});

test("Review-like child records boolean rejection without receiving context", (t) => {
  const { result, records } = probe(t, {
    transcript_path: `/synthetic/rollout-2026-10-10T13-00-00-${CHILD}.jsonl`,
  });
  assert.equal(result.stdout, "");
  assert.equal(records[0].ownerGateAllows, false);
  assert.equal(records[0].threadMatches, false);
  assert.ok(Object.values(records[0]).every((value) => typeof value === "boolean"));
});

test("regular child receives no marker", (t) => {
  const { result, records } = probe(t, { agent_id: CHILD, agent_type: "explorer" });
  assert.equal(result.stdout, "");
  assert.equal(records[0].childFieldsPresent, true);
  assert.equal(records[0].ownerGateAllows, false);
});

test("unrelated sessions produce neither context nor diagnostic output", (t) => {
  const { result, records } = probe(t, { session_id: CHILD });
  assert.equal(result.stdout, "");
  assert.deepEqual(records, []);
});

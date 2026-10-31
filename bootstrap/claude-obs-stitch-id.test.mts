// Issue #710. On 2026-10-31 an observation run passed an empty --id to stitch,
// the broker fell through to the full-space sweep and wrote to 127 unrelated
// pages. The broker now refuses that id; this pins the agent's half: the id
// comes only from create's own id: line, and without it no stitch runs. Its own
// file because observation-agent-contract.test.mts is at its size cap.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "..");
const CLAUDE_OBS = fs.readFileSync(path.join(REPO, "claude", "agents", "claude-obs.md"), "utf8");

test("the Claude text stitches only with the id create printed", () => {
  assert.match(CLAUDE_OBS, /^ +<confluence\.json broker> stitch --space <spaceKey> --id <the new page id> /m);
  assert.match(CLAUDE_OBS, /digits of the `id:` line this run's `create` printed/);
  assert.match(CLAUDE_OBS, /never through a shell variable/);
  assert.match(CLAUDE_OBS, /do NOT run `stitch` and report\s+`OBS-RESULT: failed stitch without page id`/);
  assert.match(CLAUDE_OBS, /`stitch` without\s+`--id` is a sweep[\s\S]{0,80}never yours to run/);
});

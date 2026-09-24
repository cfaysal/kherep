import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { safeId, writeFallback } from "./precompact-checkpoint.mts";

test("writes a metadata-only fallback next to the transcript", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-precompact-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const transcript = path.join(root, "session.jsonl");
  fs.writeFileSync(transcript, "fixture\n");
  const target = writeFallback({ cwd: root, session_id: "session/1", transcript_path: transcript });
  assert.ok(target);
  const checkpoint = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(path.basename(target), "session_1.json");
  assert.equal(checkpoint.session_id, "session/1");
  assert.equal(Object.hasOwn(checkpoint, "content"), false);
  assert.equal(safeId("a/b"), "a_b");
  assert.equal(writeFallback({ transcript_path: path.join(root, ".claude", "session.jsonl") }), null);
});

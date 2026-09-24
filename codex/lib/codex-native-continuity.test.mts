import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const codexRoot = path.resolve(import.meta.dirname, "..");
const continuityFiles = [
  "commands/memo-checkpoint.md",
  "commands/memo-eod.md",
  "commands/memo-resume.md",
  "commands/memo-retro.md",
  "hooks/precompact-checkpoint.mts",
  "parity/capabilities.json",
];

test("Codex continuity does not depend on claude-baton", () => {
  for (const relativePath of continuityFiles) {
    const source = fs.readFileSync(path.join(codexRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /claude-baton|\bbaton\b/i,
      `${relativePath} still contains a Baton dependency`,
    );
  }
});

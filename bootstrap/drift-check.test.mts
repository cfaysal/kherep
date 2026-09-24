import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const driftCheck = path.join(import.meta.dirname, "drift-check.sh").replace(/\\/g, "/");

test("drift normalization compares real output and fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-drift-normalize-"));
  const harness = path.join(root, "harness.sh");
  fs.writeFileSync(harness, `#!/usr/bin/env bash
set -euo pipefail
SOURCE_SCRIPT="$1"
FUNCTIONS_FILE="$(mktemp)"
sed -n '/^normalize_file() {/,/^}/p' "$SOURCE_SCRIPT" > "$FUNCTIONS_FILE"
sed -n '/^cmp_file() {/,/^}/p' "$SOURCE_SCRIPT" >> "$FUNCTIONS_FILE"
source "$FUNCTIONS_FILE"
rm -f "$FUNCTIONS_FILE"
EXPECTED_DIR="$(mktemp -d)"
trap 'rm -rf "$EXPECTED_DIR"' EXIT
CLAUDE_HOME='C:/Users/ExampleUser/.claude'
repo="$EXPECTED_DIR/repo.txt"
live="$EXPECTED_DIR/live.txt"
out="$EXPECTED_DIR/out.txt"

printf '%s\\n' 'node C:/Users/ExampleUser/.claude/hooks/a.js' > "$repo"
printf '%s\\n\\n' 'node ~/.claude/hooks/a.js' > "$live"
drift=0
cmp_file portable "$repo" "$live" > "$out"
grep -q '^ok' "$out"
[ "$drift" -eq 0 ]

printf '%s\\n' 'different' > "$live"
drift=0
cmp_file changed "$repo" "$live" > "$out"
grep -q '^DRIFT' "$out"
[ "$drift" -eq 1 ]

normalize_file() { return 1; }
drift=0
cmp_file failure "$repo" "$live" > "$out"
grep -q '^NORMALIZE-FAIL' "$out"
[ "$drift" -eq 1 ]

drift=0
cmp_file missing "$EXPECTED_DIR/missing.txt" "$live" > "$out"
grep -q '^MISSING-REPO' "$out"
[ "$drift" -eq 1 ]
`);

  try {
    const result = spawnSync("bash", [harness.replace(/\\/g, "/"), driftCheck], {
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

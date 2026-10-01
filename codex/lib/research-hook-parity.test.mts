import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertResearchHookParity } from "./research-hook-parity.mts";

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-hook-parity-"));
  for (const runtime of ["claude", "codex"]) for (const name of ["research-first.mts", "research-stop.mts"]) {
    const file = path.join(root, runtime, "hooks", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${runtime} ${name}\n`);
  }
  return root;
}

test("passes when the two named research counterparts exist", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertResearchHookParity(root));
});

test("fails when a Claude research counterpart is deliberately removed", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(path.join(root, "claude", "hooks", "research-stop.mts"));
  assert.throws(() => assertResearchHookParity(root), /claude\/hooks\/research-stop\.mts/);
});

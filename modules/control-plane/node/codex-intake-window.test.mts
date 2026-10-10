import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import { DEFAULT_POLICY, readPolicy } from "./policy.mts";

for (const scenario of ["progress", "refresh", "excluded", "drift", "missing", "malformed", "close", "stop", "drain", "admitted-drift", "publication"]) {
  test(`held Codex intake: ${scenario}`, () => {
    const result = execFileSync(process.execPath, ["--experimental-test-module-mocks",
      path.join(import.meta.dirname, "codex-intake-window-fixture.mts"), scenario], { encoding: "utf8", timeout: 15_000 });
    assert.match(result, /INTAKE_WINDOW_PASS/);
  });
}

test("required policy reads distinguish missing/error from the existing default", () => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".intake-policy-"));
  const file = path.join(root, "policy.json");
  try {
    assert.deepEqual(readPolicy(file), DEFAULT_POLICY);
    assert.equal(readPolicy(file, true), null);
    assert.equal(readPolicy(root, true), null);
    fs.writeFileSync(file, "{");
    assert.equal(readPolicy(file, true), null);
    fs.writeFileSync(file, JSON.stringify(DEFAULT_POLICY));
    assert.deepEqual(readPolicy(file, true), DEFAULT_POLICY);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

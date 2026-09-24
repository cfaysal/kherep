import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const script = path.join(import.meta.dirname, "mpac.ps1");

function resolve(env: NodeJS.ProcessEnv) {
  return spawnSync("pwsh", ["-NoProfile", "-Command", `. '${script}'; Resolve-MpacCredPath`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

test("MPAC path uses only the canonical product variable", () => {
  const canonical = resolve({ KHEREP_MPAC_CRED_FILE: "canonical.txt", OTHER_VENDOR_MPAC_CRED_FILE: "other.txt" });
  assert.equal(canonical.status, 0);
  assert.match(canonical.stdout, /canonical\.txt/);

  const unrelated = resolve({ OTHER_VENDOR_MPAC_CRED_FILE: "other.txt" });
  assert.notEqual(unrelated.status, 0);
  assert.doesNotMatch(unrelated.stdout, /other\.txt/);
});

test("empty canonical MPAC path fails closed", () => {
  const result = resolve({ KHEREP_MPAC_CRED_FILE: "", OTHER_VENDOR_MPAC_CRED_FILE: "other.txt" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KHEREP_MPAC_CRED_FILE must not be empty/);
  assert.doesNotMatch(result.stdout, /other\.txt/);
});

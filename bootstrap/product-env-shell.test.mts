import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const profile = path.join(import.meta.dirname, "profile.sh").replace(/\\/g, "/");

function run(env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", `. '${profile}' || exit $?; printf '%s|%s' "$KHEREP_PROFILE" "$(kherep_env WORKSPACE fallback)"`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/tmp/kherep-home", ...env },
  });
}

test("shell product variables use only canonical values", () => {
  assert.equal(run({ KHEREP_PROFILE: "mac", KHEREP_WORKSPACE: "/configured" }).stdout, "mac|/configured");
  const retiredPrefix = ["CF", "CON"].join("");
  assert.equal(run({ KHEREP_PROFILE: "mac", [`${retiredPrefix}_PROFILE`]: "win", [`${retiredPrefix}_WORKSPACE`]: "/ignored" }).stdout, "mac|fallback");
  assert.equal(run({ KHEREP_PROFILE: "mac", KHEREP_WORKSPACE: "" }).stdout, "mac|");
});

test("empty canonical required profile fails closed", () => {
  const result = run({ KHEREP_PROFILE: "" });
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /KHEREP_PROFILE must be win or mac/);
});

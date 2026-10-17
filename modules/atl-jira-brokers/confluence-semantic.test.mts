// Tests for how the semantic search finds the twg CLI. The interesting
// assertions are the ones about what it REFUSES: a relative override is never
// spawned, and a CLI that cannot be found still ends as "did not run", not zero.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { semanticProposals, type SemanticDeps } from "./confluence-semantic.mts";

type Call = { file: string; args: string[]; options: { timeout: number; env: NodeJS.ProcessEnv } };

async function run(deps: SemanticDeps) {
  const calls: Call[] = [];
  const result = await semanticProposals("needle", 25, {
    exec: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "", stderr: "" };
    },
    read: async () => '{"results":[]}',
    remove: async () => {},
    outFile: "/tmp/kherep-related-test.json",
    ...deps,
  });
  return { result, calls };
}

const darwin: SemanticDeps = {
  platform: "darwin",
  homedir: "/Users/test",
  pathApi: path.posix,
  env: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
};

test("spawns twg by name with the documented install locations after the inherited PATH", async () => {
  const { result, calls } = await run(darwin);
  assert.equal(calls[0].file, "twg");
  assert.equal(
    calls[0].options.env.PATH,
    "/usr/bin:/bin:/Users/test/.local/bin:/opt/homebrew/bin:/usr/local/bin",
  );
  assert.equal(calls[0].options.env.HOME, "/Users/test");
  assert.equal(calls[0].options.timeout, 90_000);
  assert.equal(result.error, undefined);
});

test("KHEREP_TWG_BIN wins over PATH and the fallbacks", async () => {
  const { calls } = await run({ ...darwin, env: { ...darwin.env, KHEREP_TWG_BIN: "/opt/twg/bin/twg" } });
  assert.equal(calls[0].file, "/opt/twg/bin/twg");
});

test("deps.cli wins over KHEREP_TWG_BIN", async () => {
  const { calls } = await run({
    ...darwin,
    cli: "/injected/twg",
    env: { ...darwin.env, KHEREP_TWG_BIN: "/opt/twg/bin/twg" },
  });
  assert.equal(calls[0].file, "/injected/twg");
});

test("refuses a relative or empty KHEREP_TWG_BIN without spawning", async () => {
  for (const value of ["twg", "bin/twg", ""]) {
    const { result, calls } = await run({ ...darwin, env: { ...darwin.env, KHEREP_TWG_BIN: value } });
    assert.equal(calls.length, 0, value);
    assert.deepEqual(result.titles, []);
    assert.equal(result.error, "semantic search did not run: KHEREP_TWG_BIN must be an absolute path");
  }
});

test("appends the Windows install locations under the existing Path key", async () => {
  const win: SemanticDeps = { platform: "win32", homedir: "C:\\Users\\test", pathApi: path.win32 };
  const { calls } = await run({
    ...win,
    env: { Path: "C:\\first;C:\\second", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
  });
  assert.equal(calls[0].file, "twg");
  assert.equal(
    calls[0].options.env.Path,
    "C:\\first;C:\\second;C:\\Users\\test\\AppData\\Local\\Programs\\twg\\bin;C:\\Program Files\\twg",
  );
  assert.equal("PATH" in calls[0].options.env, false);

  const defaults = await run({ ...win, env: { PATH: "" } });
  assert.equal(
    defaults.calls[0].options.env.PATH,
    "C:\\Users\\test\\AppData\\Local\\Programs\\twg\\bin;C:\\Program Files\\twg",
  );
});

test("a missing CLI still ends in the search-did-not-run result", async () => {
  const { result } = await run({
    ...darwin,
    exec: async () => { throw new Error("spawn twg ENOENT"); },
  });
  assert.deepEqual(result, { titles: [], error: "semantic search did not run: spawn twg ENOENT" });
});

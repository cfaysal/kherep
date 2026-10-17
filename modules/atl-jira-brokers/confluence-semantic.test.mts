// Issue #478: the semantic search spawned `twg` by bare name, so a process
// whose PATH lacks ~/.local/bin (a macOS background job) never found an
// installed CLI. The lookup is injected here: no real binary, no real PATH.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveTwg, semanticProposals, type ExecLike } from "./confluence-semantic.mts";

function existing(...entries: string[]): (candidate: string) => boolean {
  const values = new Set(entries);
  return (candidate) => values.has(candidate);
}

const MAC = { platform: "darwin", homedir: "/Users/test" };
const WIN = { platform: "win32", homedir: "C:\\Users\\test" };

test("an explicit KHEREP_TWG_BIN wins over PATH and the install locations", () => {
  assert.equal(resolveTwg({
    ...MAC,
    env: { KHEREP_TWG_BIN: "/opt/tools/twg", PATH: "/usr/bin" },
    exists: existing("/opt/tools/twg", "/usr/bin/twg", "/Users/test/.local/bin/twg"),
  }), "/opt/tools/twg");
});

test("an unusable KHEREP_TWG_BIN fails closed instead of falling back", () => {
  for (const explicit of ["", "twg", "/missing/twg"]) {
    assert.throws(() => resolveTwg({
      ...MAC,
      env: { KHEREP_TWG_BIN: explicit, PATH: "/usr/bin" },
      exists: existing("/usr/bin/twg", "/Users/test/.local/bin/twg"),
    }), /KHEREP_TWG_BIN/);
  }
});

test("PATH comes before the install locations", () => {
  assert.equal(resolveTwg({
    ...MAC,
    env: { PATH: "/usr/bin:/custom/bin" },
    exists: existing("/custom/bin/twg", "/Users/test/.local/bin/twg"),
  }), "/custom/bin/twg");
});

test("~/.local/bin/twg is found when PATH does not contain it", () => {
  assert.equal(resolveTwg({
    ...MAC,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    exists: existing("/Users/test/.local/bin/twg", "/opt/homebrew/bin/twg"),
  }), "/Users/test/.local/bin/twg");
  assert.equal(resolveTwg({
    ...MAC, env: {}, exists: existing("/opt/homebrew/bin/twg"),
  }), "/opt/homebrew/bin/twg");
});

test("Windows looks for twg.exe on PATH, then in the documented install locations", () => {
  assert.equal(resolveTwg({
    ...WIN,
    env: { PATH: "C:\\first;C:\\second", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    exists: existing("C:\\second\\twg.exe", "C:\\Users\\test\\AppData\\Local\\Programs\\twg\\bin\\twg.exe"),
  }), "C:\\second\\twg.exe");
  assert.equal(resolveTwg({
    ...WIN,
    env: { PATH: "C:\\first", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    exists: existing("C:\\Users\\test\\AppData\\Local\\Programs\\twg\\bin\\twg.exe"),
  }), "C:\\Users\\test\\AppData\\Local\\Programs\\twg\\bin\\twg.exe");
  assert.equal(resolveTwg({
    ...WIN, env: { PATH: "C:\\first" }, exists: existing("C:\\Program Files\\twg\\twg.exe"),
  }), "C:\\Program Files\\twg\\twg.exe");
  // A .cmd shim needs a shell to run, so it is never a candidate.
  assert.throws(() => resolveTwg({
    ...WIN, env: { PATH: "C:\\first", PATHEXT: ".CMD" }, exists: existing("C:\\first\\twg.cmd"),
  }), /not found/);
});

test("the resolved path is what gets spawned", async () => {
  const calls: string[] = [];
  const exec: ExecLike = async (file) => { calls.push(file); return { stdout: "", stderr: "" }; };
  const result = await semanticProposals("Orphan", 25, {
    ...MAC,
    env: { PATH: "/usr/bin" },
    exists: existing("/Users/test/.local/bin/twg"),
    exec,
    read: async () => JSON.stringify({ results: [{ title: "A" }] }),
    remove: async () => {},
    outFile: "/tmp/out.json",
  });
  assert.deepEqual(calls, ["/Users/test/.local/bin/twg"]);
  assert.deepEqual(result, { titles: ["A"] });
});

test("a missing CLI is a search that did not run, never an empty result", async () => {
  let calls = 0;
  const result = await semanticProposals("Orphan", 25, {
    ...MAC,
    env: { PATH: "/usr/bin" },
    exists: existing(),
    exec: async () => { calls += 1; return { stdout: "", stderr: "" }; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.titles, []);
  assert.match(String(result.error), /^semantic search did not run: twg not found/);
});

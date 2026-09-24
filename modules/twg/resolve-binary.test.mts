import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createTwgClient, TwgError } from "./runtime/client.mts";
import { resolveTwgBinary } from "./runtime/resolve-binary.mts";

const win = path.win32;
const posix = path.posix;

function existing(...entries: string[]): (candidate: string) => boolean {
  const values = new Set(entries);
  return (candidate) => values.has(candidate);
}

test("resolves an explicit absolute binary before every discovered candidate", () => {
  const explicit = "C:\\tools\\twg.exe";
  assert.equal(resolveTwgBinary({
    env: { KHEREP_TWG_BIN: explicit, PATH: "C:\\other" },
    platform: "win32",
    homedir: "C:\\Users\\test",
    pathApi: win,
    exists: existing(explicit, "C:\\other\\twg.exe"),
  }), explicit);
});

test("canonical binary override ignores another vendor variable and empty canonical fails closed", () => {
  const canonical = "C:\\tools\\kherep-twg.exe";
  const legacy = "C:\\tools\\legacy-twg.exe";
  assert.equal(resolveTwgBinary({
    env: { KHEREP_TWG_BIN: canonical, OTHER_VENDOR_TWG_BIN: legacy }, platform: "win32",
    homedir: "C:\\Users\\test", pathApi: win, exists: existing(canonical, legacy),
  }), canonical);
  assert.throws(() => resolveTwgBinary({
    env: { KHEREP_TWG_BIN: "", OTHER_VENDOR_TWG_BIN: legacy }, platform: "win32",
    homedir: "C:\\Users\\test", pathApi: win, exists: existing(legacy),
  }), (error) => error instanceof TwgError && error.code === "TWG_BINARY_INVALID");
});

test("fails closed when an explicit binary path is relative or missing", () => {
  for (const explicit of ["twg.exe", "C:\\missing\\twg.exe"]) {
    assert.throws(() => resolveTwgBinary({
      env: { KHEREP_TWG_BIN: explicit, PATH: "C:\\found" },
      platform: "win32",
      homedir: "C:\\Users\\test",
      pathApi: win,
      exists: existing("C:\\found\\twg.exe"),
    }), (error) => error instanceof TwgError && error.code === "TWG_BINARY_INVALID");
  }
});

test("client preserves binary resolution errors without invoking a process", () => {
  let calls = 0;
  const client = createTwgClient({
    resolveBinary() { throw new TwgError("TWG_BINARY_MISSING", "TWG is not installed in a supported location."); },
    execFileImpl() { calls += 1; },
  });
  assert.throws(
    () => client.status(),
    (error) => error instanceof TwgError && error.code === "TWG_BINARY_MISSING",
  );
  assert.equal(calls, 0);
});

test("resolves PATH and documented fallback locations on Windows and macOS", () => {
  assert.equal(resolveTwgBinary({
    env: { PATH: "C:\\first;C:\\second", PATHEXT: ".EXE;.CMD" },
    platform: "win32", homedir: "C:\\Users\\test", pathApi: win,
    exists: existing("C:\\second\\twg.exe"),
  }), "C:\\second\\twg.exe");
  assert.equal(resolveTwgBinary({
    env: { PATH: "/usr/bin", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    platform: "win32", homedir: "C:\\Users\\test", pathApi: win,
    exists: existing("C:\\Users\\test\\AppData\\Local\\Programs\\twg\\bin\\twg.exe"),
  }), "C:\\Users\\test\\AppData\\Local\\Programs\\twg\\bin\\twg.exe");
  assert.equal(resolveTwgBinary({
    env: { PATH: "/usr/bin:/opt/homebrew/bin" }, platform: "darwin",
    homedir: "/Users/test", pathApi: posix, exists: existing("/opt/homebrew/bin/twg"),
  }), "/opt/homebrew/bin/twg");
  assert.equal(resolveTwgBinary({
    env: { PATH: "/usr/bin" }, platform: "darwin", homedir: "/Users/test",
    pathApi: posix, exists: existing("/Users/test/.local/bin/twg"),
  }), "/Users/test/.local/bin/twg");
  assert.equal(resolveTwgBinary({
    env: { PATH: "C:\\none", ProgramFiles: "C:\\Program Files" },
    platform: "win32", homedir: "C:\\Users\\test", pathApi: win,
    exists: existing("C:\\Program Files\\twg\\twg.exe"),
  }), "C:\\Program Files\\twg\\twg.exe");
});

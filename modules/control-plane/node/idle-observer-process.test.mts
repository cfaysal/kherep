import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { observerCodeSha256 } from "./idle-observer.mts";
import { readNativeAncestry } from "./idle-observer-process.mts";

test("the code identity changes when the native ancestry helper changes", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-code-test-"));
  const observer = path.join(root, "idle-observer.mts");
  const helper = path.join(root, "idle-observer-process.mts");
  try {
    fs.writeFileSync(observer, "observer-v1\n", { mode: 0o600 });
    fs.writeFileSync(helper, "process-v1\n", { mode: 0o600 });
    const before = observerCodeSha256(observer);
    fs.writeFileSync(helper, "process-v2\n", { mode: 0o600 });
    assert.notEqual(observerCodeSha256(observer), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native ancestry probes are bounded and preserve the exact owner generation", () => {
  const macCalls: string[][] = [];
  const mac = readNativeAncestry(4242, "darwin", (_file, args) => {
    macCalls.push(args);
    return "  1 Thu Jan 01 00:00:00 2026  ";
  });
  assert.deepEqual(mac, [{ pid: 4242, startedAt: "Thu Jan 01 00:00:00 2026" }]);
  assert.deepEqual(macCalls, [["-o", "ppid=", "-o", "lstart=", "-p", "4242"]]);

  const win = readNativeAncestry(4242, "win32", (_file, args, env) => {
    assert.equal(args.some((arg) => arg.includes("Get-CimInstance Win32_Process")), true);
    assert.equal(env.KHEREP_IDLE_PID, "4242");
    return JSON.stringify({ ParentProcessId: 1, StartedAt: "638900000000000000" });
  });
  assert.deepEqual(win, [{ pid: 4242, startedAt: "638900000000000000" }]);
  assert.equal(readNativeAncestry(4242, "linux", () => "unparseable"), null);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { serviceRoot, writeServiceReceipt, type ServiceReceipt } from "./service-records.mts";

// Issue #540: the receipt is written through writeJsonAtomic, so on Windows a
// transient hold on receipt.json is retried and no temp file is left behind.
test("win32: a transient EPERM on the receipt rename still writes the receipt and leaves no temp file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-records-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const receipt = { version: 1, activatedAt: new Date(0).toISOString() } as ServiceReceipt;
  const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (calls++ === 0) throw Object.assign(new Error("synthetic hold"), { code: "EPERM" });
    return rename(from, to);
  });
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    writeServiceReceipt(paths, receipt);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  assert.equal(calls, 2);
  assert.deepEqual(fs.readdirSync(serviceRoot(paths)), ["receipt.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(serviceRoot(paths), "receipt.json"), "utf8")), receipt);
});

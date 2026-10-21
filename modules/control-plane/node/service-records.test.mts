import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { readServiceReceipt, serviceRoot, writeServiceReceipt, type ServiceReceipt } from "./service-records.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";

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

// PR #599 P3-5: the receipt's own pattern checks accept a string only, as the candidate record's do.
test("a receipt field that is a one-element array instead of a string makes the receipt invalid", (t) => {
  for (const field of ["definitionDigest", "securityDigest", "previousBackup", "supervisorGeneration"]) {
    const h = setup(t);
    seedManaged(h);
    const file = path.join(serviceRoot(h.paths), "receipt.json");
    const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    if (field === "previousBackup") receipt.previousBackup = ["20261014110000-00000000-0000-4000-8000-000000000000"];
    else if (field === "supervisorGeneration") receipt.binding.supervisorGeneration = [receipt.binding.supervisorGeneration];
    else receipt[field] = [receipt[field]];
    fs.writeFileSync(file, JSON.stringify(receipt));
    assert.throws(() => readServiceReceipt(h.paths), /^Error: managed service receipt is invalid$/, field);
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Capabilities } from "../lib/contracts.mts";
import { normalizeTextTree, snapshot } from "./snapshot-plugin-sources.mts";

test("normalizes UTF-8 text to LF without changing binary files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-snapshot-normalize-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.writeFileSync(path.join(root, "text.md"), "one\r\ntwo\r\n");
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 13, 10, 255]));
  normalizeTextTree(root);
  assert.equal(fs.readFileSync(path.join(root, "text.md"), "utf8"), "one\ntwo\n");
  assert.deepEqual(fs.readFileSync(path.join(root, "binary.bin")), Buffer.from([0, 13, 10, 255]));
});

test("failed snapshot generation leaves no final or staging directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-snapshot-atomic-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const destination = path.join(root, "plugin-sources");
  assert.throws(() => snapshot({}, destination), /Installed Claude plugin source missing/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("rejects a malformed installed plugin path without leaving state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-snapshot-invalid-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const destination = path.join(root, "plugin-sources");
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const capabilities = JSON.parse(fs.readFileSync(path.join(repoRoot, "codex", "parity", "capabilities.json"), "utf8")) as Capabilities;
  const first = capabilities.plugins.find((entry) => ["agent", "project"].includes(entry.mode));
  assert.ok(first, "the manifest declares at least one projected plugin");
  assert.throws(() => snapshot({ [first.id]: [{ installPath: "", version: "fixture" }] }, destination),
    /Installed Claude plugin path is invalid/);
  assert.deepEqual(fs.readdirSync(root), []);
});

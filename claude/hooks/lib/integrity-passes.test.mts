#!/usr/bin/env node
// Unit test for integrity-passes.mts (issue #507, part 3): the repair passes that
// both integrity hooks share, and the final read-only pass of the Codex hook.
// Synthetic walks and checks only; no file is read or written.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { InventoryEntry } from "./hook-inventory.mts";
import { NOT_SETTLED, finalPass, repairPasses, type Outcome } from "./integrity-passes.mts";

const entry = (rel: string): InventoryEntry => ({ file: `/h/${rel}`, rel, wired: rel === "a", importedBy: rel === "a" ? [] : ["a"] });
const OK: Outcome = { unproven: "", restored: false };

test("T6.1 a restore that reveals an import gets one more pass; each file is checked once", async () => {
  const calls: string[] = [];
  let restoredA = false;
  const walk = (): InventoryEntry[] => (restoredA ? [entry("a"), entry("b")] : [entry("a")]);
  const result = await repairPasses({
    walk,
    checkOne: async (e) => {
      calls.push(e.rel);
      if (e.rel === "a") { restoredA = true; return { unproven: "", restored: true }; }
      return OK;
    },
  });
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(result.restored, 1);
  assert.equal(result.unproven, "");
  assert.deepEqual(result.inventory.map((e) => e.rel), ["a", "b"]);
});

test("T6.1 the first text that is not empty wins, in the order the files were checked", async () => {
  const walk = (): InventoryEntry[] => [entry("a"), entry("b")];
  const one = await repairPasses({ walk, checkOne: async (e) => (e.rel === "b" ? { unproven: "b is unchecked", restored: false } : OK) });
  assert.equal(one.unproven, "b is unchecked");
  const both = await repairPasses({ walk, checkOne: async (e) => ({ unproven: e.rel === "a" ? "x" : "y", restored: false }) });
  assert.equal(both.unproven, "x");
});

test("T6.2 a closure that brings a new file in every pass ends after three passes as not settled", async () => {
  let walks = 0;
  const calls: string[] = [];
  const walk = (): InventoryEntry[] => {
    walks++;
    return Array.from({ length: walks }, (_, i) => entry(`f${i}`));
  };
  const result = await repairPasses({ walk, checkOne: async (e) => { calls.push(e.rel); return { unproven: "", restored: true }; } });
  assert.equal(result.unproven, NOT_SETTLED);
  assert.equal(NOT_SETTLED, "the import closure did not settle");
  assert.deepEqual(calls, ["f0", "f1", "f2"]);
  assert.equal(walks, 4);
  assert.deepEqual(result.inventory.map((e) => e.rel), ["f0", "f1", "f2", "f3"], "the fourth walk is the inventory");
});

test("T6.3 finalPass: all OK over the same files is empty; a file not OK, or another file set, is named", async () => {
  const expected = [entry("a"), entry("b")];
  const allOk = async (): Promise<{ state: string }> => ({ state: "OK" });
  assert.equal(await finalPass({ walk: () => [entry("a"), entry("b")], classify: allOk, expected }), "");
  assert.equal(await finalPass({ walk: () => [entry("a"), entry("b")],
    classify: async (e) => ({ state: e.rel === "b" ? "DEFEKT" : "OK" }), expected }), "b is not OK in the final check");
  assert.equal(await finalPass({ walk: () => [entry("a"), entry("b"), entry("c")], classify: allOk, expected }), NOT_SETTLED);
  assert.equal(await finalPass({ walk: () => [entry("a")], classify: allOk, expected }), NOT_SETTLED);
});

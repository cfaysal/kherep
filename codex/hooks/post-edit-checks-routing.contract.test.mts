import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import type { HookPayload } from "./hook-adapter.mts";

const DISPATCHER = path.join(import.meta.dirname, "post-edit-checks.mts");

type DispatcherModule = {
  planPostEditPayloads(payload: HookPayload): HookPayload[];
};

async function dispatcher(): Promise<DispatcherModule> {
  assert.ok(fs.existsSync(DISPATCHER), "the fixed post-edit dispatcher must exist");
  const loaded = await import(pathToFileURL(DISPATCHER).href) as Partial<DispatcherModule>;
  assert.equal(typeof loaded.planPostEditPayloads, "function");
  return loaded as DispatcherModule;
}

test("plans no watcher children for an explicitly supported read-only wrapper", async () => {
  const { planPostEditPayloads } = await dispatcher();
  const payloads = planPostEditPayloads({
    cwd: "/synthetic/work",
    tool_name: "functions.exec",
    tool_input: 'await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"});',
  });
  assert.deepEqual(payloads, []);
});

test("keeps direct edits and every currently recognized apply_patch source target as data", async () => {
  const { planPostEditPayloads } = await dispatcher();
  const direct = planPostEditPayloads({
    tool_name: "Edit",
    tool_input: { file_path: "/synthetic/work/direct.mts", new_string: "next" },
  });
  assert.equal(direct.length, 1);
  assert.equal(direct[0]?.tool_name, "Edit");

  const cwd = path.resolve("/synthetic/work");
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/one $(touch never).mts",
    "*** Move to: src/moved ; still-data.mts",
    "*** Add File: docs/two | data.md",
    "*** Update File: manifest.yml",
    "*** End Patch",
  ].join("\n");
  const planned = planPostEditPayloads({ cwd, tool_name: "apply_patch", tool_input: patch });
  assert.deepEqual(planned.map((item) => (item.tool_input as { file_path: string }).file_path), [
    path.resolve(cwd, "src/one $(touch never).mts"),
    path.resolve(cwd, "docs/two | data.md"),
    path.resolve(cwd, "manifest.yml"),
  ]);
  assert.doesNotMatch(JSON.stringify(planned), /moved ; still-data/, "Move to is not a baseline patchPaths target");
});

test("keeps a recognized patch wrapper covered and unknown wrappers conservative", async () => {
  const { planPostEditPayloads } = await dispatcher();
  const patch = "*** Begin Patch\\n*** Update File: src/a.mts\\n*** End Patch";
  const recognized = planPostEditPayloads({
    cwd: "/synthetic/work",
    tool_name: "functions.exec",
    tool_input: [
      'await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"});',
      `await tools.apply_patch("${patch}");`,
    ].join("\n"),
  });
  assert.equal(recognized.length, 1);
  assert.equal(recognized[0]?.tool_name, "Edit");

  for (const source of [
    'await tools.future_read({query:"hooks"});',
    'const name = "mcp__codebase_memory_mcp__search_graph"; await tools[name]({query:"hooks"});',
    'await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"}); await tools.future_read({});',
  ]) {
    const fallback = planPostEditPayloads({
      cwd: "/synthetic/work", tool_name: "functions.exec", tool_input: source,
    });
    assert.equal(fallback.length, 1, source);
  }
});

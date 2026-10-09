import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { normalizePayloads, type HookPayload } from "./hook-adapter.mts";

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

function filePaths(payloads: HookPayload[]): string[] {
  return payloads.map((item) => String((item.tool_input as { file_path?: unknown })?.file_path || ""));
}

const THREE_TARGET_PATCH = [
  "*** Begin Patch",
  "*** Update File: src/one $(touch never).mts",
  "*** Move to: src/moved ; still-data.mts",
  "*** Add File: docs/two | data.md",
  "*** Update File: manifest.yml",
  "*** End Patch",
].join("\n");

test("locks the existing post normalization for Write, MultiEdit, patch sources and move text", () => {
  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "/work/a.mts", content: "next" } },
    { tool_name: "MultiEdit", tool_input: { file_path: "/work/b.mts", edits: [{ new_string: "next" }] } },
  ]) {
    const normalized = normalizePayloads(payload, "post");
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0]?.tool_name, payload.tool_name);
  }

  const cwd = path.resolve("/synthetic/work");
  const normalized = normalizePayloads({
    cwd, tool_name: "apply_patch", tool_input: THREE_TARGET_PATCH,
  }, "post");
  assert.deepEqual(filePaths(normalized), [
    path.resolve(cwd, "src/one $(touch never).mts"),
    path.resolve(cwd, "docs/two | data.md"),
    path.resolve(cwd, "manifest.yml"),
  ]);
  assert.match(
    String((normalized[0]?.tool_input as { new_string?: unknown }).new_string),
    /Move to: src\/moved ; still-data\.mts/,
    "Move to stays in watcher text but is not a baseline patchPaths target",
  );
});

test("locks every recognized patch payload for mixed or unknown functions.exec wrappers", () => {
  const cwd = path.resolve("/synthetic/work");
  for (const source of [
    `await tools.future_tool({}); await tools.apply_patch(${JSON.stringify(THREE_TARGET_PATCH)});`,
    `await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"}); await tools.future_tool({}); ${THREE_TARGET_PATCH}`,
  ]) {
    const normalized = normalizePayloads({
      cwd, tool_name: "functions.exec", tool_input: source,
    }, "post");
    assert.equal(normalized.length, 3, source);
    assert.deepEqual(filePaths(normalized), [
      path.resolve(cwd, "src/one $(touch never).mts"),
      path.resolve(cwd, "docs/two | data.md"),
      path.resolve(cwd, "manifest.yml"),
    ]);
  }
});

test("plans no watcher children for an explicitly supported read-only wrapper", async () => {
  const { planPostEditPayloads } = await dispatcher();
  assert.deepEqual(planPostEditPayloads({
    cwd: "/synthetic/work",
    tool_name: "functions.exec",
    tool_input: 'await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"});',
  }), []);
});

test("plans four watcher children per direct edit or currently recognized patch source", async () => {
  const { planPostEditPayloads } = await dispatcher();
  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "/work/a.mts", content: "next" } },
    { tool_name: "MultiEdit", tool_input: { file_path: "/work/b.mts", edits: [{ new_string: "next" }] } },
  ]) assert.equal(planPostEditPayloads(payload).length, 1);

  const cwd = path.resolve("/synthetic/work");
  const planned = planPostEditPayloads({
    cwd, tool_name: "apply_patch", tool_input: THREE_TARGET_PATCH,
  });
  assert.deepEqual(filePaths(planned), [
    path.resolve(cwd, "src/one $(touch never).mts"),
    path.resolve(cwd, "docs/two | data.md"),
    path.resolve(cwd, "manifest.yml"),
  ]);
  assert.match(String((planned[0]?.tool_input as { new_string?: unknown }).new_string), /Move to:/);
});

test("keeps mixed and unknown wrappers conservative without dropping patch targets", async () => {
  const { planPostEditPayloads } = await dispatcher();
  const cwd = path.resolve("/synthetic/work");
  const patchSource = `await tools.future_tool({}); await tools.apply_patch(${JSON.stringify(THREE_TARGET_PATCH)});`;
  assert.equal(planPostEditPayloads({
    cwd, tool_name: "functions.exec", tool_input: patchSource,
  }).length, 3);

  for (const source of [
    'await tools.future_read({query:"hooks"});',
    'const name = "mcp__codebase_memory_mcp__search_graph"; await tools[name]({query:"hooks"});',
    'await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"}); await tools.future_read({});',
  ]) assert.equal(planPostEditPayloads({
    cwd, tool_name: "functions.exec", tool_input: source,
  }).length, 1, source);
});

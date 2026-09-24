import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { canonicalHookArtifact, historicalManagedFragments } from "./historical-managed-artifacts.mts";
import { command } from "./parity-config.mts";

const roots = { node: "C:/Fixture/node.exe", contextHook: "C:/Fixture/context.mts", hookDir: "C:/Fixture/hooks" };
function neutralFragment(value: typeof roots): string {
  return `command = ${JSON.stringify(command(value.node, value.contextHook, path.join(value.hookDir, "neutral.mts")))}`;
}

test("canonicalizes only exact trusted installer arguments across Windows roots and quotes", () => {
  const other = { node: String.raw`D:\Other Space\node.exe`, contextHook: String.raw`D:\Other Space\context.mts`, hookDir: String.raw`D:\Other Space\hooks` };
  assert.equal(canonicalHookArtifact(neutralFragment(roots), roots), canonicalHookArtifact(neutralFragment(other), other));
  const quoted = { ...roots, node: 'C:/Fixture/quote"node.exe' };
  assert.equal(canonicalHookArtifact(neutralFragment(roots), roots), canonicalHookArtifact(neutralFragment(quoted), quoted));
  assert.notEqual(canonicalHookArtifact(neutralFragment(other), roots), canonicalHookArtifact(neutralFragment(roots), roots));
  assert.notEqual(canonicalHookArtifact(neutralFragment(roots).replace("neutral.mts", "custom.mts"), roots), canonicalHookArtifact(neutralFragment(roots), roots));
  assert.notEqual(canonicalHookArtifact(neutralFragment(roots).replace("context.mts", "context.js"), roots), canonicalHookArtifact(neutralFragment(roots), roots));
});

test("refuses literal normalization markers and unknown complete artifacts", () => {
  assert.throws(() => canonicalHookArtifact('command = "@INSTALL_NODE@"', roots), /Reserved artifact/);
  const unknown = '# Managed Kherep Codex Maestro parity projection.\n\n' + neutralFragment(roots);
  assert.deepEqual(historicalManagedFragments(unknown, roots, { baseline: [""], "previous-nudges": [""], javascript: [""] }), []);
});

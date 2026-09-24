import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { historicalManagedFragments } from "./historical-managed-artifacts.mts";

// The preserved renderer is an external, immutable upgrade fixture. Keep legacy
// installation code outside the active product and verify its identity before import.
const fixture = process.env.KHEREP_HISTORICAL_RENDERER_FILE;
test("recognizes complete preserved upgrade artifacts while rejecting modified guards", {
  skip: fixture ? false : "External preserved upgrade fixture not supplied",
}, async () => {
  assert.ok(fixture);
  assert.equal(createHash("sha256").update(fs.readFileSync(fixture)).digest("hex"),
    "fbd1c136a835d9c8c3971107e1a5570eff585763a71ddcdb31e1ca4d4e70695d");
  const renderer = await import(pathToFileURL(fixture).href) as {
    render(options: object): string;
    renderPreviousNudges(options: object): string;
    renderLegacyJavaScript(options: object): string;
  };
  const root = path.join(os.tmpdir(), "Kherep upgrade fixture");
  const hookDir = path.join(root, "hooks");
  const options = { node: path.join(root, "node"), contextHook: path.join(root, "kherep-maestro-context.mts"),
    hookDir, memoryPromptHook: path.join(hookDir, "codex-memory-prompt.js"), mcpServers: [] };
  const suffixes = { baseline: [""], "previous-nudges": [""], javascript: [""] };
  for (const render of [renderer.render, renderer.renderPreviousNudges, renderer.renderLegacyJavaScript]) {
    const artifact = render(options).trim();
    assert.equal(historicalManagedFragments(artifact, options, suffixes).length, 1,
      "Complete preserved artifact must be recognized");
    assert.deepEqual(historicalManagedFragments(
      artifact.replace("commit-guard.js", "custom-guard.js"), options, suffixes), []);
    assert.deepEqual(historicalManagedFragments(
      artifact.replace("timeout = 10", "timeout = 99"), options, suffixes), []);
  }
});

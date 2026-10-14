import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { claimServiceLaunchPermit, issueServiceLaunchPermit } from "./service-launch-permit.mts";
import type { ServiceBinding } from "./service-types.mts";

const binding = (root: string, generation: string): ServiceBinding => ({
  serviceName: "KherepNode", taskPath: "\\Kherep\\", platform: "win32", workspace: path.join(root, "workspace"),
  configRoot: root, nodeExecutable: process.execPath, logFile: path.join(root, "daemon.log"), supervisorGeneration: generation,
  source: { root: path.join(root, "pin"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
});

test("launch permit is atomic, one-use, and bound to the complete supervisor generation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-launch-permit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const old = binding(root, "11111111-1111-4111-8111-111111111111");
  const candidate = binding(root, "22222222-2222-4222-8222-222222222222");
  const cleanup = issueServiceLaunchPermit(paths, candidate);
  assert.equal(claimServiceLaunchPermit(paths, old), false);
  assert.equal(claimServiceLaunchPermit(paths, { ...candidate, logFile: path.join(root, "other.log") }), false);
  assert.equal(claimServiceLaunchPermit(paths, candidate), true);
  assert.equal(claimServiceLaunchPermit(paths, candidate), false);
  cleanup();

  issueServiceLaunchPermit(paths, old);
  const cleanupReplacement = issueServiceLaunchPermit(paths, candidate);
  assert.equal(claimServiceLaunchPermit(paths, old), false, "a stale generation cannot survive the next proven transaction boundary");
  assert.equal(claimServiceLaunchPermit(paths, candidate), true);
  cleanupReplacement();
});

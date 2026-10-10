import assert from "node:assert/strict";
import test from "node:test";

import { isDirectNativeQueueIdentity, localQueueRoute } from "./codex-queue-context.mts";

const HOME = "/synthetic/codex-home";
const missing = () => { const error = new Error("missing") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; };

test("local queue route requires no remote, executor, workload or environments marker", () => {
  assert.equal(localQueueRoute(HOME, {}, missing), "local");
  assert.equal(localQueueRoute(HOME, { OPENAI_WORKLOAD_IDENTITY_CONTEXT: "present alone" }, missing), "local");
  for (const key of [
    "CODEX_EXEC_SERVER_URL", "CODEX_EXEC_SERVER_NOISE_REGISTRY_URL", "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN", "CODEX_SQLITE_HOME",
    "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE",
  ]) assert.equal(localQueueRoute(HOME, { [key]: "" }, missing), "unknown", key);
  assert.equal(localQueueRoute(HOME, {}, () => ({}) as never), "unknown", "environments.toml present");
  assert.equal(localQueueRoute(HOME, {}, () => { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EACCES"; throw error; }),
    "unknown", "unreadable route configuration");
});

test("cleanup admits only a directly launched native executable", () => {
  const direct = {
    codexExecutable: "/opt/codex", launchFile: "/opt/codex", launchPrefix: [],
    approvedFiles: [{ path: "/opt/codex", realpath: "/opt/codex", sha256: "a".repeat(64) }],
    resolvedCodexHome: "/home/test/.codex", route: "local" as const,
  };
  assert.equal(isDirectNativeQueueIdentity(direct, () => Buffer.from([0x7f, 0x45, 0x4c, 0x46])), true);
  assert.equal(isDirectNativeQueueIdentity({ ...direct, launchFile: "/usr/bin/node", launchPrefix: ["/opt/codex.js"],
    approvedFiles: [...direct.approvedFiles, { path: "/usr/bin/node", realpath: "/usr/bin/node", sha256: "b".repeat(64) }] },
  () => Buffer.from([0x7f, 0x45, 0x4c, 0x46])), false);
  assert.equal(isDirectNativeQueueIdentity(direct, () => Buffer.from("#! /")), false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { readRegistryServer } from "./registry-http-wrapper.mts";

function registryFixture(t: TestContext, server: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { fixture_service: server } }), { mode: 0o600 });
  return file;
}

test("reads a private HTTP registry entry without rewriting credentials", (t) => {
  const authorization = `Bearer ${"x".repeat(24)}`;
  const file = registryFixture(t, {
    type: "http",
    url: "http://localhost:37891/mcp",
    headers: { Authorization: authorization },
  });
  assert.deepEqual(readRegistryServer(file, "fixture_service"), {
    authorization,
    endpoint: "http://localhost:37891/mcp",
  });
});

test("rejects unsafe registry entries", (t) => {
  const file = registryFixture(t, {
    type: "http",
    url: "http://user:password@fixture_service.example/mcp",
    headers: { Authorization: `Bearer ${"x".repeat(40)}` },
  });
  assert.throws(() => readRegistryServer(file, "fixture_service"), /endpoint is invalid/);
  assert.throws(() => readRegistryServer(file, "../fixture_service"), /server name is invalid/);

  const cleartext = registryFixture(t, {
    type: "http",
    url: "http://fixture_service.example/mcp",
    headers: { Authorization: `Bearer ${"x".repeat(40)}` },
  });
  assert.throws(() => readRegistryServer(cleartext, "fixture_service"), /endpoint is invalid/);
  assert.equal(
    readRegistryServer(cleartext, "fixture_service", true).endpoint,
    "http://fixture_service.example/mcp",
  );
});

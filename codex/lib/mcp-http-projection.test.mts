import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { projectRegistry } from "./mcp-registry-projection.mts";

function registryFixture(t: TestContext, mcpServers: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-http-projection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "registry.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return file;
}

test("separates native HTTP auth from registry bearer auth without copying credentials", (t) => {
  const authorization = `Bearer ${"x".repeat(32)}`;
  const file = registryFixture(t, {
    anonymous: { type: "http", url: "https://anonymous.example.invalid/mcp" },
    oauth: { type: "http", url: "https://oauth.example.invalid/mcp", headers: {} },
    bearer: {
      type: "http", url: "https://bearer.example.invalid/mcp",
      headers: { Authorization: authorization },
    },
  });

  const result = projectRegistry(file, ["anonymous", "oauth", "bearer", "absent"]);

  assert.deepEqual(result, [
    {
      name: "anonymous", transport: "http", authentication: "native",
      url: "https://anonymous.example.invalid/mcp",
    },
    {
      name: "oauth", transport: "http", authentication: "native",
      url: "https://oauth.example.invalid/mcp",
    },
    {
      name: "bearer", transport: "http", authentication: "registry-bearer", sourceName: "bearer",
    },
    { name: "absent", transport: "missing" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /Authorization|Bearer|bearer\.example/);
});

test("preserves remote HTTP only through the existing registry bearer bridge", (t) => {
  const file = registryFixture(t, {
    bearer: {
      type: "http",
      url: "http://bearer.example.invalid/mcp",
      headers: { Authorization: `Bearer ${"x".repeat(32)}` },
    },
  });

  assert.deepEqual(projectRegistry(file, ["bearer"]), [{
    name: "bearer", transport: "http", authentication: "registry-bearer", sourceName: "bearer",
  }]);
});

test("rejects HTTP credentials outside the owned bearer bridge contract", (t) => {
  const secret = "never-project-http-secret";
  for (const server of [
    { type: "http", url: `https://user:${secret}@example.invalid/mcp` },
    { type: "http", url: `https://example.invalid/mcp?token=${secret}` },
    { type: "http", url: "https://example.invalid/mcp", headers: { "X-Api-Key": secret } },
    { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: `Basic ${secret}` } },
  ]) {
    const file = registryFixture(t, { remote: server });
    assert.throws(() => projectRegistry(file, ["remote"]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MCP server remote: HTTP/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
});

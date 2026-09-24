import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { projectOperatorBinding } from "./mcp-operator-binding.mts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authFile = path.join(root, "auth.token");
  const caFile = path.join(root, "operator-ca.pem");
  fs.writeFileSync(authFile, "synthetic-auth-file\n", { mode: 0o600 });
  fs.writeFileSync(caFile, "synthetic-ca\n", { mode: 0o600 });
  return {
    authFile, caFile,
    node: path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    runtime: path.join(root, "orchestra", "supergateway-secret-wrapper.mts"),
  };
}

test("projects the narrow secret-file bearer adapter without reading its secret", (t) => {
  const target = fixture(t);
  assert.deepEqual(projectOperatorBinding("n8n", {
    authentication: "secret-file-bearer",
    authFile: target.authFile,
    endpoint: "https://automation.example.invalid/mcp",
    caFile: target.caFile,
  }, target), {
    name: "n8n",
    transport: "stdio",
    authentication: "secret-file-bearer",
    command: target.node,
    args: [target.runtime],
    env: {
      KHEREP_MCP_AUTH_FILE: target.authFile,
      KHEREP_MCP_ENDPOINT: "https://automation.example.invalid/mcp",
      NODE_EXTRA_CA_CERTS: target.caFile,
    },
  });
});

test("rejects unsupported bindings and value-bearing errors", (t) => {
  const target = fixture(t);
  const secret = "never-echo-binding-value";
  for (const [name, binding] of [
    ["other", { authentication: "secret-file-bearer", authFile: target.authFile, endpoint: "https://example.invalid/mcp" }],
    ["n8n", { authentication: "secret-file-bearer", authFile: "relative.token", endpoint: "https://example.invalid/mcp" }],
    ["n8n", { authentication: "secret-file-bearer", authFile: target.authFile, endpoint: `https://user:${secret}@example.invalid/mcp` }],
    ["n8n", { authentication: "secret-file-bearer", authFile: target.authFile, endpoint: "https://example.invalid/mcp", extra: secret }],
  ] as const) {
    assert.throws(() => projectOperatorBinding(name, binding, target), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
});

test("preserves explicit legacy TLS compatibility without making it the default", (t) => {
  const target = fixture(t);
  const legacy = projectOperatorBinding("n8n", {
    authentication: "secret-file-bearer",
    authFile: target.authFile,
    endpoint: "https://automation.example.invalid/mcp",
    tlsMode: "legacy-disabled",
  }, target);
  assert.equal(legacy.transport, "stdio");
  if (legacy.transport !== "stdio") throw new Error("expected stdio projection");
  assert.equal(legacy.env?.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  assert.equal(legacy.env?.NODE_EXTRA_CA_CERTS, undefined);
  assert.throws(() => projectOperatorBinding("n8n", {
    authentication: "secret-file-bearer",
    authFile: target.authFile,
    endpoint: "https://automation.example.invalid/mcp",
    caFile: target.caFile,
    tlsMode: "legacy-disabled",
  }, target), /invalid/);
});

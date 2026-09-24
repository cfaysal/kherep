import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  SUPERGATEWAY_VERSION,
  npmRootInvocation,
  readToken,
  resolveSupergatewayEntry,
  validateTlsTrust,
  validateEndpoint,
} from "./supergateway-secret-wrapper.mts";

const TEMP_ROOT = process.platform === "win32" ? os.tmpdir() : fs.realpathSync(os.tmpdir());

test("uses a shell-free platform-native npm invocation", () => {
  assert.deepEqual(npmRootInvocation("win32", "C:\\Program Files\\nodejs\\node.exe"), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "root", "-g"],
  });
  assert.deepEqual(npmRootInvocation("darwin", "/opt/homebrew/bin/node"), {
    command: "npm", args: ["root", "-g"],
  });
});

test("reads only a private regular token file", () => {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "mcp-wrapper-token-"));
  try {
    const file = path.join(root, "token");
    fs.writeFileSync(file, `${"x".repeat(48)}\n`, { mode: 0o600 });
    assert.equal(readToken(file), "x".repeat(48));
    if (process.platform !== "win32") {
      fs.chmodSync(file, 0o644);
      assert.throws(() => readToken(file), /not private/);
      fs.chmodSync(file, 0o600);
      const link = path.join(root, "token-link");
      fs.symlinkSync(file, link);
      assert.throws(() => readToken(link), /symbolic links/);
    }
    fs.writeFileSync(file, "short token", { mode: 0o600 });
    assert.throws(() => readToken(file), /invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepts only credential-free HTTPS endpoints", () => {
  assert.equal(validateEndpoint("https://n8n.invalid/mcp-server/http"), "https://n8n.invalid/mcp-server/http");
  for (const value of [
    "http://n8n.invalid/mcp-server/http",
    "https://user:secret@n8n.invalid/mcp-server/http",
    "https://n8n.invalid/mcp-server/http?token=secret",
    "https://n8n.invalid/mcp-server/http#secret",
  ]) assert.throws(() => validateEndpoint(value));
});

test("uses system trust by default and accepts an explicit operator CA", () => {
  assert.deepEqual(validateTlsTrust({}), { mode: "system" });
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "mcp-wrapper-ca-"));
  try {
    const ca = path.join(root, "operator-ca.pem");
    fs.writeFileSync(ca, "synthetic fixture CA\n", { mode: 0o600 });
    assert.deepEqual(validateTlsTrust({ NODE_EXTRA_CA_CERTS: ca }), { mode: "operator-ca" });
    assert.throws(() => validateTlsTrust({ NODE_EXTRA_CA_CERTS: path.join(root, "missing.pem") }), /CA file is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retains only an explicitly configured legacy TLS compatibility mode", () => {
  assert.deepEqual(validateTlsTrust({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }), { mode: "legacy-disabled" });
  assert.deepEqual(validateTlsTrust({ NODE_TLS_REJECT_UNAUTHORIZED: "1" }), { mode: "system" });
  assert.throws(() => validateTlsTrust({
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_EXTRA_CA_CERTS: path.join(TEMP_ROOT, "operator-ca.pem"),
  }), /TLS trust settings are mutually exclusive/);
});

test("resolves only the pinned global supergateway package entry", () => {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "mcp-wrapper-package-"));
  try {
    const packageRoot = path.join(root, "supergateway");
    const entry = path.join(packageRoot, "dist", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// fixture\n");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "supergateway",
      version: SUPERGATEWAY_VERSION,
      bin: { supergateway: "dist/index.js" },
    }));
    assert.equal(resolveSupergatewayEntry(root), entry);

    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
    manifest.version = "0.0.0";
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
    assert.throws(() => resolveSupergatewayEntry(root), /pinned supergateway/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

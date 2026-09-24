import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { migrateRegistry, readRegistry, writeFresh } from "./migrate-mcp-http-auth.mts";

const TOKEN = `header.${"x".repeat(40)}.${"y".repeat(40)}`;
const TEMP_ROOT = process.platform === "win32" ? os.tmpdir() : fs.realpathSync(os.tmpdir());
const SUBJECT = path.join(import.meta.dirname, "migrate-mcp-http-auth.mts");

interface Bridge {
  command: string;
  args: string[];
  env?: unknown;
}

function fixture() {
  return {
    preserved: { value: true },
    mcpServers: {
      other: { command: "other", args: [] as string[] },
      n8n: {
        command: "npx",
        args: ["-y", "supergateway", "--streamableHttp", "https://service.example.invalid/mcp-server/http", "--header", `authorization:Bearer ${TOKEN}`],
        env: {},
      } as Bridge,
    },
  };
}

test("converts an exact supergateway bearer bridge to native HTTP", () => {
  const original = fixture();
  const migrated = migrateRegistry(original, "n8n");
  assert.deepEqual(migrated.mcpServers?.n8n, {
    type: "http",
    url: "https://service.example.invalid/mcp-server/http",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.deepEqual(migrated.mcpServers?.other, original.mcpServers.other);
  assert.deepEqual(migrated.preserved, original.preserved);
  assert.equal(original.mcpServers.n8n.command, "npx");
});

test("rejects an inexact bridge instead of dropping unknown behavior", () => {
  const value = fixture();
  value.mcpServers.n8n.args.push("--logLevel", "none");
  assert.throws(() => migrateRegistry(value, "n8n"), /supported contract/);
});

test("rejects every environment except absent or an empty plain object", () => {
  const withEnv = fixture();
  withEnv.mcpServers.n8n.env = { SECRET: "value" };
  assert.throws(() => migrateRegistry(withEnv, "n8n"), /environment must be absent or an empty object/);
  for (const invalid of [null, false, 0, "", []]) {
    const value = fixture();
    value.mcpServers.n8n.env = invalid;
    assert.throws(() => migrateRegistry(value, "n8n"), /environment must be absent or an empty object/);
  }
  const absent = fixture();
  delete absent.mcpServers.n8n.env;
  assert.doesNotThrow(() => migrateRegistry(absent, "n8n"));
});

test("rejects endpoints that can carry credentials outside the header", () => {
  const http = fixture();
  http.mcpServers.n8n.args[3] = "http://service.example.invalid/mcp-server/http";
  assert.throws(() => migrateRegistry(http, "n8n"), /credential-free HTTPS/);
  for (const endpoint of [
    "https://user:password@service.example.invalid/mcp-server/http",
    "https://service.example.invalid/mcp-server/http?access_token=secret",
    "https://service.example.invalid/mcp-server/http#secret",
  ]) {
    const value = fixture();
    value.mcpServers.n8n.args[3] = endpoint;
    assert.throws(() => migrateRegistry(value, "n8n"), /credential-free HTTPS/);
  }
});

test("fresh output is private on POSIX and existing output is never overwritten", () => {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "mcp-migrate-"));
  try {
    const input = path.join(root, "input.json");
    const output = path.join(root, "output.json");
    fs.writeFileSync(input, JSON.stringify(fixture()), { mode: 0o600 });
    const migrated = migrateRegistry(readRegistry(input), "n8n");
    writeFresh(output, migrated);
    if (process.platform !== "win32") assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), migrated);
    assert.throws(() => writeFresh(output, fixture()), /EEXIST/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI output and JSON parse failures never echo the bearer token", () => {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "mcp-migrate-cli-"));
  try {
    const input = path.join(root, "input.json");
    const output = path.join(root, "output.json");
    fs.writeFileSync(input, JSON.stringify(fixture()), { mode: 0o600 });
    const success = spawnSync(process.execPath, [SUBJECT, input, output, "n8n"], {
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    assert.doesNotMatch(`${success.stdout}${success.stderr}`, new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const malformed = path.join(root, "malformed.json");
    fs.writeFileSync(malformed, `{"secret":"${TOKEN}"`, { mode: 0o600 });
    const failure = spawnSync(process.execPath, [SUBJECT, malformed, path.join(root, "unused.json"), "n8n"], {
      encoding: "utf8",
    });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /input registry is not valid JSON/);
    assert.doesNotMatch(`${failure.stdout}${failure.stderr}`, new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX input and output paths reject symbolic-link traversal", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, "mcp-migrate-link-"));
  try {
    const realInput = path.join(root, "input.json");
    const linkedInput = path.join(root, "linked-input.json");
    fs.writeFileSync(realInput, JSON.stringify(fixture()), { mode: 0o600 });
    fs.symlinkSync(realInput, linkedInput);
    assert.throws(() => readRegistry(linkedInput), /symbolic links/);

    const realParent = path.join(root, "real-parent");
    const linkedParent = path.join(root, "linked-parent");
    fs.mkdirSync(realParent);
    fs.symlinkSync(realParent, linkedParent, "dir");
    assert.throws(() => writeFresh(path.join(linkedParent, "output.json"), fixture()), /real directory|symbolic links/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

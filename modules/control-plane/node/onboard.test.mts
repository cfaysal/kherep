import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configRoot, connectUrl, nodePaths, normalizeControlUrl } from "./config.mts";
import { fallbackDirs, findOnPath } from "./discovery.mts";
import { readPrivateKey } from "./identity.mts";
import { nodeStatus, onboard, unenroll } from "./onboard.mts";

const NODE_ID = "00000000-0000-4000-8000-0000000000bb";
const FACTS = { hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 2, memoryBytes: 1024 };

function tempPaths(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-onboard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

function fakeEnroll(status: number, body: unknown, seen: { url?: string; body?: Record<string, unknown> } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(body, { status });
  }) as typeof fetch;
}

test("onboard enrolls, writes a config without secrets and a 0600 key", async (t) => {
  const paths = tempPaths(t);
  const seen: { url?: string; body?: Record<string, unknown> } = {};
  const config = await onboard({
    controlUrl: "https://control.example.com", code: "one-time-code-123456", paths, facts: FACTS, runtimes: [],
    fetch: fakeEnroll(201, { nodeId: NODE_ID }, seen),
  });
  assert.equal(seen.url, "https://control.example.com/node/enroll");
  assert.equal(seen.body?.name, "node-a");
  assert.equal(config.nodeId, NODE_ID);

  const text = fs.readFileSync(paths.config, "utf8");
  const key = readPrivateKey(paths.privateKey);
  const jwk = key.privateKey.export({ format: "jwk" });
  assert.equal(key.publicKey, config.publicKey);
  assert.ok(!text.includes(String(jwk.d)), "config must not contain the private scalar");
  assert.ok(!/PRIVATE KEY/.test(text), "config must not contain PEM key material");
  assert.ok(!text.includes("one-time-code-123456"), "config must not keep the enrollment code");
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(),
    ["controlUrl", "enrolledAt", "name", "nodeId", "policyFile", "privateKeyFile", "publicKey", "version"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(paths.privateKey).mode & 0o777, 0o600);
  assert.equal(nodeStatus(paths).privateKeyPresent, true);

  await assert.rejects(onboard({ controlUrl: "https://control.example.com", code: "x".repeat(20), paths, facts: FACTS, runtimes: [],
    fetch: fakeEnroll(201, { nodeId: NODE_ID }) }), /already enrolled/);
});

test("a refused enrollment leaves no key behind", async (t) => {
  const paths = tempPaths(t);
  await assert.rejects(onboard({
    controlUrl: "https://control.example.com", code: "used-code-used-code", paths, facts: FACTS, runtimes: [],
    fetch: fakeEnroll(403, { error: "used-code" }),
  }), /enrollment refused \(403: used-code\)/);
  assert.equal(fs.existsSync(paths.privateKey), false);
  assert.equal(fs.existsSync(paths.config), false);
});

test("unenroll removes the local identity and names the node to revoke", async (t) => {
  const paths = tempPaths(t);
  await onboard({ controlUrl: "https://control.example.com", code: "c".repeat(20), paths, facts: FACTS, runtimes: [],
    fetch: fakeEnroll(201, { nodeId: NODE_ID }) });
  assert.deepEqual(unenroll(paths), { nodeId: NODE_ID });
  assert.equal(fs.existsSync(paths.privateKey), false);
  assert.deepEqual(nodeStatus(paths), { enrolled: false });
});

test("control URLs must be https origins; the connect URL uses wss", () => {
  assert.equal(normalizeControlUrl("https://control.example.com/"), "https://control.example.com");
  assert.equal(normalizeControlUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeControlUrl("http://control.example.com"), /https/);
  assert.throws(() => normalizeControlUrl("https://control.example.com/api"), /origin/);
  assert.equal(connectUrl("https://control.example.com", NODE_ID), `wss://control.example.com/node/connect?nodeId=${NODE_ID}`);
});

test("config location honours KHEREP_CONFIG_DIR and per-OS defaults", () => {
  assert.equal(configRoot({ KHEREP_CONFIG_DIR: path.resolve("x") }, "linux"), path.resolve("x"));
  assert.equal(configRoot({ APPDATA: path.join("C:", "Users", "u", "AppData", "Roaming") }, "win32"),
    path.join("C:", "Users", "u", "AppData", "Roaming", "kherep"));
  assert.equal(configRoot({ XDG_CONFIG_HOME: "/cfg" }, "linux"), path.join("/cfg", "kherep"));
});

test("runtime discovery finds executables on PATH without running them", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-path-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const win = process.platform === "win32";
  fs.writeFileSync(path.join(dir, win ? "claude.cmd" : "claude"), "", { mode: 0o755 });
  const deps = { pathEnv: dir, pathExt: ".CMD", fallback: [] };
  assert.ok(findOnPath("claude", deps));
  assert.equal(findOnPath("codex", deps), null);
});

test("the fallback directories cover per-user and package-manager installs", () => {
  assert.deepEqual(fallbackDirs({ platform: "darwin", home: "/Users/u" }),
    ["/Users/u/.local/bin", "/Users/u/.claude/local", "/Users/u/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  assert.deepEqual(fallbackDirs({ platform: "win32", home: "C:\\Users\\u", appData: "D:\\Roaming" }), ["D:\\Roaming\\npm"]);
});

test("an executable missing from a minimal PATH is found in a fallback directory, PATH first", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const win = process.platform === "win32";
  const onPath = path.join(root, "path");
  const home = path.join(root, "home");
  const userBin = win ? path.join(root, "appdata", "npm") : path.join(home, ".local", "bin");
  for (const dir of [onPath, userBin]) fs.mkdirSync(dir, { recursive: true });
  const file = (dir: string) => path.join(dir, win ? "claude.cmd" : "claude");
  fs.writeFileSync(file(userBin), "", { mode: 0o755 });
  const deps = { pathEnv: onPath, pathExt: ".CMD", home, appData: path.join(root, "appdata") };
  assert.equal(findOnPath("claude", deps), file(userBin));
  fs.writeFileSync(file(onPath), "", { mode: 0o755 });
  assert.equal(findOnPath("claude", deps), file(onPath));
});

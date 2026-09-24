import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { nativeCommand, parseCentralBrainBinding } from "./memory-provider.mts";
import { renderHooks } from "./parity-config.mts";

const root = path.resolve("synthetic/native-ca");
const nativeHooks = { contextCli: path.join(root, "context.js"),
  captureCli: path.join(root, "capture.mjs"), extraCaCertificates: path.join(root, "private-ca.pem") };
const selection = { provider: "central-brain", mcpCli: path.join(root, "mcp.mjs"),
  profile: path.join(root, "profile.json"), nativeHooks };

test("a retired native CA binding is read back as an explicit absolute reference without reading it", () => {
  assert.deepEqual(parseCentralBrainBinding(selection), { mcpCli: selection.mcpCli, profile: selection.profile, nativeHooks });
  for (const invalid of ["relative.pem", "", null, true, `${root}\ncommand`]) {
    assert.throws(() => parseCentralBrainBinding({ ...selection,
      nativeHooks: { ...nativeHooks, extraCaCertificates: invalid } }));
  }
});

test("native certificate scope is local to the command and shell arguments remain literal", () => {
  const render = nativeCommand;
  assert.equal(render(["node", "entry"], "win32", "C:\\Synthetic\\space & ca.pem"),
    'set "NODE_EXTRA_CA_CERTS=C:\\Synthetic\\space & ca.pem" && "node" "entry"');
  assert.equal(render(["node", "entry"], "linux", "/synthetic/apostrophe' ca.pem"),
    `NODE_EXTRA_CA_CERTS='/synthetic/apostrophe'"'"' ca.pem' 'node' 'entry'`);
  for (const bad of ['C:\\bad%VAR%.pem', 'C:\\bad!.pem', 'C:\\bad".pem', "C:\\bad\n.pem"]) {
    assert.throws(() => render(["node"], "win32", bad));
  }
});

test("only the four selected native hook commands receive the certificate binding", () => {
  const rendered = renderHooks({ memoryProvider: "central-brain", contextHook: path.join(root, "maestro.mts"),
    hookDir: root, node: process.execPath, mcpServers: [],
    nativeHooks: { ...nativeHooks, profile: selection.profile } });
  const commands = [...rendered.matchAll(/^command = (.+)$/gm)].map(match => JSON.parse(match[1]) as string);
  const scoped = commands.filter(command => command.includes("NODE_EXTRA_CA_CERTS="));
  assert.equal(scoped.length, 4);
  assert.ok(scoped.every(command => command.includes(nativeHooks.contextCli)
    || command.includes(nativeHooks.captureCli)));
});

test("native CA path survives the actual Windows command shell", { skip: process.platform !== "win32" }, () => {
  const ca = "C:\\Synthetic\\space & parentheses (ca).pem";
  const render = nativeCommand;
  const command = render([process.execPath, "-e", "process.stdout.write(process.env.NODE_EXTRA_CA_CERTS||'')"],
    "win32", ca);
  const child = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command],
    { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.equal(child.stdout, ca);
});

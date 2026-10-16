// Issue #436. install.sh renders this host's intercom command and node name
// into CLAUDE.md and teams/kherep/ROUTING.md; capture.sh copies both back into
// the shared source. Its portable_intercom step (lib.sh) must restore the
// placeholders, so a capture after an install gives the sources back byte for
// byte and the public repository never receives a config root or a node name.
// capture.sh itself writes into the repository's claude/ directory, so its
// step runs here on copies, against a throwaway home and config root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { launcherCommand } from "../modules/control-plane/node/launcher.mts";
import { captureIntercom, renderIntercom } from "./render-intercom.mts";

const HERE = import.meta.dirname;
const CLAUDE_SRC = path.join(HERE, "..", "claude");
const NODE_NAME = "synthetic-node-436";
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const FILES: [live: string, source: string][] = [
  ["CLAUDE.md", "CLAUDE.user.md"], [path.join("teams", "kherep", "ROUTING.md"), path.join("teams", "kherep", "ROUTING.md")],
];

function enroll(config: string): void {
  fs.mkdirSync(path.join(config, "control-plane"), { recursive: true });
  fs.writeFileSync(path.join(config, "control-plane", "node.json"), JSON.stringify({
    version: 1, controlUrl: "https://control.example.com", nodeId: "11111111-1111-4111-8111-111111111111", name: NODE_NAME,
    publicKey: "synthetic", privateKeyFile: "node-ed25519.pem", policyFile: "policy.json", enrolledAt: "2026-10-16T00:00:00.000Z",
  }));
}

test("capture after install gives CLAUDE.md and ROUTING.md back byte-identical to their sources", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-436-capture-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const claude = path.join(home, ".claude");
  const ws = path.join(root, "workspace");
  const creds = path.join(root, "credentials");
  const config = path.join(root, "kherep config");
  for (const dir of [claude, path.join(ws, ".claude"), creds]) fs.mkdirSync(dir, { recursive: true });
  enroll(config);
  fs.writeFileSync(path.join(claude, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(ws, ".claude", "settings.local.json"), "{}\n");
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
  const env = { ...base, HOME: slash(home), CLAUDE_HOME: slash(claude), KHEREP_PROFILE: "win", KHEREP_CONFIG_DIR: config,
    KHEREP_WORKSPACE: slash(ws), KHEREP_CREDENTIALS_ROOT: slash(creds), KHEREP_INSTALL_SKIP_GITCONFIG: "1",
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1", SKIP_SECRETS: "1", SKIP_DEPS: "1" };
  const install = spawnSync("bash", [slash(path.join(HERE, "install.sh"))], { encoding: "utf8", timeout: 240_000, env });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);

  const command = launcherCommand(config);
  assert.ok(fs.readFileSync(path.join(claude, "CLAUDE.md"), "utf8").includes(`${command} msg send ${NODE_NAME}/maestro`));
  for (const [live, source] of FILES) {
    const copy = path.join(root, `captured-${path.basename(live)}`);
    fs.copyFileSync(path.join(claude, live), copy);
    const capture = spawnSync("bash", ["-c", `. "${slash(path.join(HERE, "lib.sh"))}" && portable_intercom "${slash(copy)}"`],
      { encoding: "utf8", timeout: 60_000, env });
    assert.equal(capture.status, 0, capture.stderr);
    const captured = fs.readFileSync(copy, "utf8");
    assert.equal(captured, fs.readFileSync(path.join(CLAUDE_SRC, source), "utf8"), live);
    for (const leak of [config, config.replace(/\\/g, "/"), NODE_NAME]) assert.equal(captured.includes(leak), false, `${live}: ${leak}`);
  }
});

test("capture.sh restores the placeholders in both rendered files", () => {
  const script = fs.readFileSync(path.join(HERE, "capture.sh"), "utf8");
  assert.match(script, /^portable_intercom "\$CLAUDE_SRC\/CLAUDE\.user\.md"$/m);
  assert.match(script, /^portable_intercom "\$CLAUDE_SRC\/teams\/kherep\/ROUTING\.md"$/m);
  // After the copies it reverses, never before.
  assert.ok(script.indexOf('portable_intercom "$CLAUDE_SRC/CLAUDE.user.md"') > script.indexOf('"$CLAUDE_SRC/CLAUDE.user.md"'));
});

test("captureIntercom reverses renderIntercom and leaves other text alone", () => {
  const values = { command: 'node "/cfg/kherep config/bin/kherep-node.mjs"', exampleTarget: "peer/session" };
  for (const rel of ["CLAUDE.user.md", path.join("teams", "kherep", "ROUTING.md")]) {
    const source = fs.readFileSync(path.join(CLAUDE_SRC, rel), "utf8");
    assert.equal(captureIntercom(renderIntercom(source, values), values), source, rel);
    assert.equal(captureIntercom(source, values), source, rel);
  }
  // A target named outside the example is operator text, not the placeholder.
  assert.equal(captureIntercom("see peer/session\n", values), "see peer/session\n");
});

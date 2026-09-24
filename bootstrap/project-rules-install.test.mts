// OP-1425. The real install.sh and drift-check.sh against throwaway homes: the
// workspace rule files keep the operator's bytes, the block is installed inside
// the transaction (backup, rollback, idempotence), a broken block is refused
// before any mutation, and drift looks at the block only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { blockBody, PROJECT_RULES_END, PROJECT_RULES_START } from "./project-rules-block.mts";

const HERE = import.meta.dirname;
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const sha = (file: string, length?: number): string => {
  const bytes = fs.readFileSync(file);
  return createHash("sha256").update(length === undefined ? bytes : bytes.subarray(0, length)).digest("hex");
};
const template = (name: string): string => fs.readFileSync(path.join(HERE, "..", "claude", `${name}.project.md`), "utf8");
const OPERATOR = {
  CLAUDE: "# Example Org rules\n\n- synthetic operator rule for example.org\n",
  AGENTS: "# Example Org agents\r\n\r\n- synthetic CRLF operator rule\r\n",
};

interface Fixture { root: string; home: string; claude: string; ws: string; creds: string }

function fixture(t: { after: (fn: () => void) => void }): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-op1425-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, home: path.join(root, "home"), claude: path.join(root, "home", ".claude"),
    ws: path.join(root, "workspace"), creds: path.join(root, "credentials") };
  for (const dir of [f.claude, path.join(f.ws, ".claude"), f.creds]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.claude, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(f.ws, ".claude", "settings.local.json"), "{}\n");
  return f;
}

function env(f: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = { ...process.env };
  delete base.KHEREP_INSTALL_ATLASSIAN_TOOLS;
  return { ...base, HOME: slash(f.home), CLAUDE_HOME: slash(f.claude), KHEREP_PROFILE: "win",
    KHEREP_WORKSPACE: slash(f.ws), KHEREP_CREDENTIALS_ROOT: slash(f.creds), KHEREP_INSTALL_SKIP_GITCONFIG: "1",
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1", SKIP_SECRETS: "1",
    SKIP_DEPS: "1", ...extra };
}

function run(script: string, f: Fixture, extra?: Record<string, string>): { status: number | null; out: string } {
  const result = spawnSync("bash", [slash(path.join(HERE, script))], { encoding: "utf8", env: env(f, extra), timeout: 240_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const backups = (f: Fixture): string[] => {
  const dir = path.join(f.claude, "backups", "bootstrap");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith("install-")).sort() : [];
};

test("operator files keep their bytes, the block lands once and drift sees only the block", (t) => {
  const f = fixture(t);
  for (const [name, text] of Object.entries(OPERATOR)) fs.writeFileSync(path.join(f.ws, `${name}.md`), text);
  const first = run("install.sh", f);
  assert.equal(first.status, 0, first.out);
  for (const [name, text] of Object.entries(OPERATOR)) {
    const live = path.join(f.ws, `${name}.md`);
    assert.equal(sha(live, Buffer.byteLength(text)), createHash("sha256").update(text).digest("hex"), `${name} prefix`);
    assert.equal(blockBody(fs.readFileSync(live, "utf8"))?.replace(/\r\n/g, "\n"), template(name).trim());
    const [backup] = backups(f);
    assert.equal(fs.readFileSync(path.join(f.claude, "backups", "bootstrap", backup, "project", `${name}.md`), "utf8"), text);
  }
  const installed = Object.keys(OPERATOR).map((name) => sha(path.join(f.ws, `${name}.md`)));

  const second = run("install.sh", f);
  assert.equal(second.status, 0, second.out);
  assert.deepEqual(Object.keys(OPERATOR).map((name) => sha(path.join(f.ws, `${name}.md`))), installed, "second install moved bytes");
  const latest = backups(f).at(-1) ?? "";
  assert.ok(!fs.existsSync(path.join(f.claude, "backups", "bootstrap", latest, "project", "CLAUDE.md")), "second install swapped");

  const claudeMd = path.join(f.ws, "CLAUDE.md");
  fs.appendFileSync(claudeMd, "\n## operator addition after the block\n");
  let drift = run("drift-check.sh", f);
  assert.equal(drift.status, 0, drift.out);
  assert.match(drift.out, /ok\s+project\/CLAUDE\.md/);

  const text = fs.readFileSync(claudeMd, "utf8");
  fs.writeFileSync(claudeMd, text.replace(/(kherep-project-rules:start -->\n)/, "$1- stale rule\n"));
  drift = run("drift-check.sh", f);
  assert.equal(drift.status, 1, drift.out);
  assert.match(drift.out, /DRIFT\s+project\/CLAUDE\.md/);

  fs.writeFileSync(claudeMd, OPERATOR.CLAUDE);
  drift = run("drift-check.sh", f);
  assert.match(drift.out, /MISSING-BLOCK project\/CLAUDE\.md/);
});

test("a rollback restores the pre-install bytes of both rule files", (t) => {
  const f = fixture(t);
  for (const [name, text] of Object.entries(OPERATOR)) fs.writeFileSync(path.join(f.ws, `${name}.md`), text);
  const failed = run("install.sh", f, { KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL: "project/AGENTS.md" });
  assert.notEqual(failed.status, 0, failed.out);
  for (const [name, text] of Object.entries(OPERATOR)) {
    assert.equal(fs.readFileSync(path.join(f.ws, `${name}.md`), "utf8"), text, `${name} not restored`);
  }
  assert.ok(fs.existsSync(path.join(f.claude, "backups", "bootstrap", backups(f)[0], "ROLLED-BACK")));
});

test("a lone marker is refused before the first live mutation", (t) => {
  const f = fixture(t);
  const broken = `${OPERATOR.CLAUDE}${PROJECT_RULES_START}\nhalf a block\n`;
  fs.writeFileSync(path.join(f.ws, "CLAUDE.md"), broken);
  const refused = run("install.sh", f);
  assert.notEqual(refused.status, 0, refused.out);
  assert.match(refused.out, /incomplete managed block/);
  assert.equal(fs.readFileSync(path.join(f.ws, "CLAUDE.md"), "utf8"), broken);
  assert.ok(!fs.existsSync(path.join(f.ws, "AGENTS.md")), "AGENTS.md was created by a refused run");
  assert.deepEqual(backups(f), [], "a refused run opened a transaction");
  assert.ok(!fs.existsSync(path.join(f.claude, "hooks")), "a refused run installed hooks");
});

test("a missing file and an unedited old template both become the block alone", (t) => {
  const f = fixture(t);
  const old = spawnSync("git", ["show", "6aa222a:claude/AGENTS.project.md"], { cwd: path.join(HERE, ".."), encoding: "utf8" });
  if (old.status === 0) fs.writeFileSync(path.join(f.ws, "AGENTS.md"), old.stdout);
  const result = run("install.sh", f);
  assert.equal(result.status, 0, result.out);
  for (const name of old.status === 0 ? ["CLAUDE", "AGENTS"] : ["CLAUDE"]) {
    const live = fs.readFileSync(path.join(f.ws, `${name}.md`), "utf8");
    assert.equal(live, `${PROJECT_RULES_START}\n${template(name).trim()}\n${PROJECT_RULES_END}\n`, name);
  }
  const drift = run("drift-check.sh", f);
  assert.match(drift.out, /ok\s+project\/CLAUDE\.md/);
  assert.match(drift.out, /ok\s+project\/AGENTS\.md/);
});

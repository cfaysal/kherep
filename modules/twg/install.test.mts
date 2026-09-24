import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { adaptSkillText } from "./component-render-bridge.mts";
import { installFocused } from "./install.mts";

function fixture(t: TestContext): { root: string; repoRoot: string } {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kherep-twg-install-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(path.join(repoRoot, "modules", "twg", "runtime"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "claude", "skills", "kherep-twg"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "modules", "twg", "runtime", "cli.mts"), "console.log('twg');\n");
  fs.writeFileSync(path.join(repoRoot, "claude", "skills", "kherep-twg", "SKILL.md"), [
    "---", "name: kherep-twg", "description: Safe TWG reads", "---", "",
    "Run `node ~/.claude/kherep/twg/cli.mts status`.", "",
  ].join("\n"));
  return { root, repoRoot };
}

test("focused installer installs only the module and canonical skill", (t) => {
  const { root, repoRoot } = fixture(t);
  const homeDir = path.join(root, "claude-home");
  const receipt = installFocused({ runtime: "claude", homeDir, repoRoot, now: "20260906T120000Z" });
  assert.deepEqual(receipt.components, [
    { name: "runtime", status: "installed" }, { name: "skill", status: "installed" },
  ]);
  assert.equal(receipt.backupRoot, null);
  assert.equal(fs.readFileSync(path.join(homeDir, "kherep", "twg", "cli.mts"), "utf8"), "console.log('twg');\n");
  assert.match(fs.readFileSync(path.join(homeDir, "skills", "kherep-twg", "SKILL.md"), "utf8"), /~\/\.claude\/kherep\/twg/);
  assert.deepEqual(fs.readdirSync(homeDir).sort(), ["kherep", "skills"]);
});

test("focused installer is content-idempotent and backs up drift before replacement", (t) => {
  const { root, repoRoot } = fixture(t);
  const homeDir = path.join(root, "claude-home");
  installFocused({ runtime: "claude", homeDir, repoRoot, now: "20260906T120000Z" });
  const unchanged = installFocused({ runtime: "claude", homeDir, repoRoot, now: "20260906T120100Z" });
  assert.deepEqual(unchanged.components, [
    { name: "runtime", status: "unchanged" }, { name: "skill", status: "unchanged" },
  ]);
  assert.equal(unchanged.backupRoot, null);

  fs.writeFileSync(path.join(homeDir, "kherep", "twg", "cli.mts"), "local drift\n");
  const repaired = installFocused({ runtime: "claude", homeDir, repoRoot, now: "20260906T120200Z" });
  assert.deepEqual(repaired.components, [
    { name: "runtime", status: "replaced-with-backup" }, { name: "skill", status: "unchanged" },
  ]);
  assert.equal(
    fs.readFileSync(path.join(repaired.backupRoot!, "kherep", "twg", "cli.mts"), "utf8"),
    "local drift\n",
  );
  assert.equal(fs.readFileSync(path.join(homeDir, "kherep", "twg", "cli.mts"), "utf8"), "console.log('twg');\n");
});

test("focused Codex install projects the skill path and projection safety block", (t) => {
  const { root, repoRoot } = fixture(t);
  const homeDir = path.join(root, "codex-home");
  installFocused({ runtime: "codex", homeDir, repoRoot, now: "20260906T120000Z" });
  const skill = fs.readFileSync(path.join(homeDir, "skills", "kherep-twg", "SKILL.md"), "utf8");
  assert.match(skill, /~\/\.codex\/kherep\/twg\/cli\.mts/);
  assert.match(skill, /kherep-codex-projection/);
  assert.doesNotMatch(skill, /~\/\.claude\/kherep\/twg/);
  assert.equal(skill, adaptSkillText(fs.readFileSync(path.join(repoRoot, "claude", "skills", "kherep-twg", "SKILL.md"), "utf8")));
});

test("focused installer restores the current component when staged activation fails", (t) => {
  const { root, repoRoot } = fixture(t);
  const homeDir = path.join(root, "claude-home");
  installFocused({ runtime: "claude", homeDir, repoRoot, now: "20260906T120000Z" });
  const target = path.join(homeDir, "kherep", "twg", "cli.mts");
  fs.writeFileSync(target, "preserve this drift\n");
  const realRename = fs.renameSync;
  assert.throws(() => installFocused({
    runtime: "claude", homeDir, repoRoot, now: "20260906T120100Z",
    renameSync(from, to) {
      if (path.basename(from).startsWith(".kherep-twg-stage-") && to === path.dirname(target)) {
        throw new Error("fixture activation failure");
      }
      realRename(from, to);
    },
  }), /fixture activation failure/);
  assert.equal(fs.readFileSync(target, "utf8"), "preserve this drift\n");
});

test("focused installer rejects unknown runtimes and relative homes before writing", (t) => {
  const { repoRoot } = fixture(t);
  assert.throws(() => installFocused({ runtime: "other", homeDir: "relative", repoRoot }), /runtime must be claude or codex/);
  assert.throws(() => installFocused({ runtime: "claude", homeDir: "relative", repoRoot }), /home must be absolute/);
});

test("focused installer rejects a symlink or junction in the target ancestry", (t) => {
  const { root, repoRoot } = fixture(t);
  const homeDir = path.join(root, "claude-home");
  const outside = path.join(root, "outside");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(homeDir, "kherep"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => installFocused({ runtime: "claude", homeDir, repoRoot, now: "20260906T120000Z" }),
    /symbolic link or junction/,
  );
  assert.equal(fs.existsSync(path.join(outside, "twg")), false);
});

test("focused installer validates first-install rollback ancestry before applying", (t) => {
  const { root, repoRoot } = fixture(t);
  const homeDir = path.join(root, "claude-home");
  const outside = path.join(root, "outside");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(homeDir, "backups"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => installFocused({
      runtime: "claude", homeDir, repoRoot, now: "20260906T120000Z",
      renameSync(from, to) {
        if (path.basename(from).startsWith(".kherep-twg-stage-") && to.endsWith(path.join("skills", "kherep-twg"))) {
          throw new Error("fixture second activation failure");
        }
        fs.renameSync(from, to);
      },
    }),
    /symbolic link or junction/,
  );
  assert.equal(fs.existsSync(path.join(homeDir, "kherep", "twg")), false);
  assert.equal(fs.readdirSync(outside).length, 0);
});

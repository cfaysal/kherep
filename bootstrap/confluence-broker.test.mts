// Issue #13. claude-obs takes its broker command from confluence.json and never
// composes one. The installer writes that command through the substitution that
// renders the permission rules, so the stored command and the allow rules
// cannot drift apart. These tests render both for the same profile and
// workspace and compare them byte for byte, then pin the re-install behaviour.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { parseArgs } from "./confluence-space.mts";
import { renderSettings } from "./render-profile.mts";

const HERE = import.meta.dirname;
const REPO = path.join(HERE, "..");
// The verbs claude/agents/claude-obs.md runs through the stored command.
const OBS_VERBS = ["related", "create", "stitch", "children"];
const HOSTS = [
  { profile: "win", workspace: "C:\\Users\\example\\Kherep" },
  { profile: "mac", workspace: "/Users/example/Kherep" },
];

function tempRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-broker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// The Claude allow rules that name the broker, rendered as install.sh renders them.
function renderedBrokerRules(root: string, profile: string, workspace: string): string[] {
  const user = path.join(root, `settings-${profile}.json`);
  renderSettings([profile, workspace, path.join(root, "credentials"), path.join(root, "claude-home"),
    path.join(REPO, "claude", "settings.user.json"), path.join(REPO, "claude", "settings.project.json"),
    "-", "-", user, path.join(root, `settings-${profile}.local.json`)]);
  const allow = (JSON.parse(fs.readFileSync(user, "utf8")) as { permissions?: { allow?: string[] } })
    .permissions?.allow ?? [];
  return allow.filter((rule) => rule.includes("atl-confluence-ccoder.mts"));
}

// confluence-space.mts with the arguments install.sh passes, against a stub
// broker and a stub placement resolver: nothing leaves the host.
function spaceFixture(root: string): { run: (profile: string, workspace: string) => void; target: string } {
  const bootstrap = path.join(root, "repo", "bootstrap");
  const brokers = path.join(root, "repo", "modules", "atl-jira-brokers");
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(brokers, { recursive: true });
  for (const file of ["confluence-space.mts", "render-profile-paths.mts", "shape.mts"]) {
    fs.copyFileSync(path.join(HERE, file), path.join(bootstrap, file));
  }
  fs.writeFileSync(path.join(bootstrap, "confluence-nodes.mts"), [
    'export const PLACEMENT_NODES = ["Kherep"];',
    "export async function readSpacePages() { return []; }",
    'export function resolvePlacement() { return { nodes: { Kherep: "parent-1" }, missing: [] }; }',
  ].join("\n"));
  fs.writeFileSync(path.join(brokers, "atl-confluence-ccoder.mts"),
    'process.stdout.write("id: space-1\\nkey: KB\\nname: Knowledge\\n");\n');
  const target = path.join(root, "claude-home", "kherep", "confluence.json");
  const run = (profile: string, workspace: string): void => {
    const result = spawnSync(process.execPath, [path.join(bootstrap, "confluence-space.mts"),
      "--out", target, "--runtime", "claude", "--profile", profile, "--workspace", workspace], {
      encoding: "utf8",
      env: { ...process.env, KHEREP_CONFLUENCE_SPACE_KEY: "KB" },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  return { run, target };
}

const stored = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8"));

test("the stored broker command is the prefix of every rendered broker allow rule", (t) => {
  for (const { profile, workspace } of HOSTS) {
    const root = tempRoot(t);
    const space = spaceFixture(root);
    space.run(profile, workspace);
    const broker = stored(space.target).broker;
    assert.equal(typeof broker, "string", profile);
    assert.match(String(broker), /^node \S.*\/tools\/atl-confluence-ccoder\.mts$/, profile);
    assert.doesNotMatch(String(broker), /<workspace>|__KHEREP_/, profile);

    const rules = renderedBrokerRules(root, profile, workspace);
    assert.ok(rules.length >= OBS_VERBS.length, `${profile}: no rendered broker rules`);
    for (const rule of rules) assert.ok(rule.startsWith(`Bash(${broker} `), `${profile}: ${rule}`);
    for (const verb of OBS_VERBS) assert.ok(rules.includes(`Bash(${broker} ${verb}:*)`), `${profile}: ${verb}`);
  }
});

test("a re-install keeps the space and its nodes, refreshes the broker, and is idempotent", (t) => {
  const root = tempRoot(t);
  const space = spaceFixture(root);
  fs.mkdirSync(path.dirname(space.target), { recursive: true });
  // A host configured before the broker field existed.
  fs.writeFileSync(space.target, JSON.stringify({
    spaceKey: "KB", spaceId: "space-1", spaceName: "Knowledge", nodes: { Kherep: "parent-1" },
  }));

  space.run("mac", "/Users/example/Kherep");
  const first = fs.readFileSync(space.target, "utf8");
  assert.deepEqual(stored(space.target), {
    spaceKey: "KB", spaceId: "space-1", spaceName: "Knowledge",
    broker: "node /Users/example/Kherep/tools/atl-confluence-ccoder.mts", nodes: { Kherep: "parent-1" },
  });

  space.run("mac", "/Users/example/Kherep");
  assert.equal(fs.readFileSync(space.target, "utf8"), first, "a second run changes nothing");

  space.run("mac", "/Users/example/Moved");
  assert.equal(stored(space.target).broker, "node /Users/example/Moved/tools/atl-confluence-ccoder.mts");
});

test("the Claude runtime cannot be configured without the broker inputs", () => {
  const base = ["--out", "target.json", "--runtime", "claude"];
  assert.throws(() => parseArgs(base), /--profile <win\|mac> and --workspace/);
  assert.throws(() => parseArgs([...base, "--profile", "mac"]), /--workspace/);
  assert.throws(() => parseArgs([...base, "--profile", "linux", "--workspace", "/w"]), /--profile <win\|mac>/);
  assert.equal(parseArgs(["--out", "target.json", "--runtime", "codex"]).broker, undefined);
});

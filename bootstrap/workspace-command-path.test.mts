// Issue #30. The workspace is the one install path Kherep renders UNQUOTED into
// commands: the `Bash(node <workspace>/tools/...)` allow rules and the stored
// claude-obs `broker`. A path that is not a single shell word can never work
// there, so the installer refuses it before its first write. CLAUDE_HOME and the
// credentials root are rendered quoted and keep accepting a space.
//
// Every run here builds its environment without the host's KHEREP_* variables
// and points GIT_CONFIG_SYSTEM and GIT_CONFIG_GLOBAL at fixture files, so no
// run can read host configuration or touch the host's git config.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { renderClaudeBroker } from "./render-profile-paths.mts";

const HERE = import.meta.dirname;
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const profileSh = slash(path.join(HERE, "profile.sh"));

function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
}

// The value travels in the environment, not in argv, so Windows command-line
// quoting cannot alter a quote, backslash or newline before bash sees it.
function check(value: string): { status: number | null; stderr: string } {
  return spawnSync("bash", ["-c", `. '${profileSh}' || exit $?; kherep_validate_workspace_command_path "$WS_UNDER_TEST"`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/fixture/home", KHEREP_PROFILE: "win", WS_UNDER_TEST: value },
  });
}

// What an agent does with the stored broker: hand the string to bash as is.
function wordsAsStored(command: string): string[] {
  const run = spawnSync("bash", ["-c", `set -- ${command}\nprintf '%s\\n' "$@"`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.replace(/\n$/, "").split("\n");
}

const REFUSED = [" ", "\t", "\n", "|", "&", ";", "<", ">", "(", ")", "$", "`", "\\", "\"", "'", "*", "?", "[", "]", "{", "}"];

test("the workspace check refuses whitespace and every shell metacharacter, naming the path", () => {
  for (const character of REFUSED) {
    const value = `/fixture/a${character}b/Kherep`;
    const result = check(value);
    assert.equal(result.status, 2, `accepted ${JSON.stringify(value)}`);
    assert.ok(result.stderr.includes("FATAL: KHEREP_WORKSPACE"), result.stderr);
    assert.ok(result.stderr.includes(value), `message does not name ${JSON.stringify(value)}: ${result.stderr}`);
    assert.match(result.stderr, /set it with KHEREP_WORKSPACE/);
  }
});

// Characters POSIX calls only sometimes special are special at the start of a
// word or in an interactive shell. The workspace never starts the word: it
// begins with / (a drive letter once rendered on Windows). ~ in particular must
// pass, for 8.3 names such as the RUNNER~1 in a Windows CI temp directory.
const ACCEPTED = [
  "/fixture/Kherep",
  "/c/Users/RUNNER~1/AppData/Local/Temp/Kherep",
  "/Users/jürgen/Kherep",
  "/fixture/a#b/c=d/e%f/g!h/i^j/k,l/m-n_o.p+q@r:s/Kherep",
];

test("the workspace check accepts a path that stays one shell word when run as stored", () => {
  for (const value of ACCEPTED) {
    const result = check(value);
    assert.equal(result.status, 0, `refused ${JSON.stringify(value)}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    // The claim behind the accepted set: bash leaves the stored broker as the
    // exact words node and <workspace>/tools/..., however the path is spelled.
    const broker = renderClaudeBroker("mac", value);
    assert.deepEqual(wordsAsStored(`${broker} get`), ["node", `${value}/tools/atl-confluence-ccoder.mts`, "get"]);
  }
});

interface Fixture { root: string; home: string; claude: string; ws: string }

function fixture(t: TestContext, home: string, ws: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-issue30-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, home: path.join(root, home), claude: path.join(root, home, ".claude"), ws: path.join(root, ws) };
  for (const dir of [f.claude, f.ws]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.claude, "settings.json"), "{}\n");
  return f;
}

function runScript(script: string, f: Fixture, extra: Record<string, string>) {
  const env = {
    ...hostEnv(), HOME: slash(f.home), CLAUDE_HOME: slash(f.claude), KHEREP_PROFILE: "win",
    GIT_CONFIG_SYSTEM: path.join(f.root, "gitconfig-system"), GIT_CONFIG_GLOBAL: path.join(f.root, "gitconfig-global"),
    KHEREP_INSTALL_SKIP_GITCONFIG: "1", KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1",
    SKIP_SECRETS: "1", SKIP_DEPS: "1", ...extra,
  };
  return spawnSync("bash", [slash(path.join(HERE, script))], { encoding: "utf8", env, timeout: 240_000 });
}

// Every path below the fixture root with its size, so a created directory, a
// lock, a backup or a changed file all show up as a difference.
function tree(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return `${path.relative(root, full)}:${entry.isDirectory() ? "dir" : fs.statSync(full).size}`;
    })
    .sort();
}

for (const script of ["install.sh", "drift-check.sh"]) {
  test(`${script} refuses a workspace with a space before any write`, (t) => {
    const f = fixture(t, "home", "Jane Doe/Kherep");
    const before = tree(f.root);
    const run = runScript(script, f, { KHEREP_WORKSPACE: slash(f.ws) });
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.ok(run.stderr.includes(slash(f.ws)), run.stderr);
    assert.match(run.stderr, /set it with KHEREP_WORKSPACE/);
    assert.deepEqual(tree(f.root), before);
  });
}

// The default workspace is $HOME/Kherep, so a home folder with a space is
// enough to hit this without any variable set.
test("install.sh refuses the default workspace under a home with a space", (t) => {
  const f = fixture(t, "Jane Doe", "unused");
  const before = tree(f.root);
  const run = runScript("install.sh", f, {});
  assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.stderr.includes(`${slash(f.home)}/Kherep`), run.stderr);
  assert.deepEqual(tree(f.root), before);
});

// The accepted side, end to end: a home with a space holds CLAUDE_HOME and the
// default credentials root, the workspace sits outside it. The install
// completes, each hook command names CLAUDE_HOME inside double quotes and parses
// as exactly node plus that path, and the unquoted workspace forms are
// unchanged.
test("install.sh accepts CLAUDE_HOME with a space, where hook commands quote it", (t) => {
  const f = fixture(t, "Jane Doe", "Kherep");
  const run = runScript("install.sh", f, { KHEREP_WORKSPACE: slash(f.ws) });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const settings = JSON.parse(fs.readFileSync(path.join(f.claude, "settings.json"), "utf8"));
  const hookCommands: string[] = Object.values(settings.hooks as Record<string, { hooks: { command: string }[] }[]>)
    .flat().flatMap((group) => group.hooks.map((hook) => hook.command))
    .filter((command) => command.includes("/hooks/"));
  assert.ok(hookCommands.length > 0, "no managed hook command rendered");
  for (const command of hookCommands) {
    const quoted = command.match(/^node "([^"]*Jane Doe[^"]*\/hooks\/[\w.-]+)"$/);
    assert.ok(quoted, `hook command not quoted around CLAUDE_HOME: ${command}`);
    assert.deepEqual(wordsAsStored(command), ["node", quoted[1]]);
  }
  assert.match(settings.env.KHEREP_CREDENTIALS_ROOT, /Jane Doe\/\.kherep\/credentials$/);

  const tool = `${f.ws.replace(/\\/g, "/")}/tools/atl-confluence-ccoder.mts`;
  const broker = `node ${tool}`;
  assert.ok(settings.permissions.allow.includes(`Bash(${broker} get:*)`), JSON.stringify(settings.permissions.allow));
  const stored = JSON.parse(fs.readFileSync(path.join(f.claude, "kherep", "confluence.json"), "utf8"));
  assert.equal(stored.broker, broker);
  assert.deepEqual(wordsAsStored(`${stored.broker} get`), ["node", tool, "get"]);
});

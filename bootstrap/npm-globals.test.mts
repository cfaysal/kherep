import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const subject = path.join(import.meta.dirname, "npm-globals.mts");

// Fake npm: answers the three read/write calls the subject makes and records
// every argv, so a test can assert that no install ran at all. Plain
// JavaScript on purpose: a runtime fixture written into a throwaway directory,
// not a versioned source file.
const fakeNpmSource = String.raw`
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\n");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_STATE, "utf8"));
const signature = args.join(" ");
if (signature === "ls -g --depth=0 --json") {
  const dependencies = {};
  for (const [name, version] of Object.entries(state.installed)) dependencies[name] = { version };
  process.stdout.write(JSON.stringify({ name: "npm", dependencies }));
  process.exit(Number.isInteger(state.lsExit) ? state.lsExit : 0);
}
if (signature === "prefix -g") {
  process.stdout.write(state.prefix + "\n");
  process.exit(0);
}
if (args.slice(0, 2).join(" ") === "i -g") {
  const outcome = (state.outcomes && state.outcomes[args[2]]) || { exit: 0 };
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exit(Number.isInteger(outcome.exit) ? outcome.exit : 0);
}
process.stderr.write("unexpected fake npm command");
process.exit(64);
`;

interface Outcome {
  exit: number;
  stderr?: string;
}

interface FakeState {
  installed: Record<string, string>;
  prefix: string;
  outcomes: Record<string, Outcome>;
  lsExit?: number;
}

interface Fixture {
  files: { root: string; fake: string; log: string; manifest: string; state: string };
  foreign: string;
  prefix: string;
  manifest: string[];
  state: FakeState;
  save: () => void;
}

function fixture(t: TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-npm-globals-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "npm-prefix");
  const foreign = path.join(root, "foreign");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(foreign, { recursive: true });
  const files = {
    root,
    fake: path.join(root, "fake-npm.js"),
    log: path.join(root, "commands.log"),
    manifest: path.join(root, "npm-globals.txt"),
    state: path.join(root, "state.json"),
  };
  fs.writeFileSync(files.fake, fakeNpmSource);
  const ctx: Fixture = {
    files,
    foreign,
    prefix,
    manifest: ["# comment", "", "alpha"],
    state: { installed: { alpha: "1.0.0" }, prefix, outcomes: {} },
    save: () => {
      fs.writeFileSync(files.manifest, ctx.manifest.join("\n") + "\n");
      fs.writeFileSync(files.state, JSON.stringify(ctx.state, null, 2));
    },
  };
  ctx.save();
  return ctx;
}

function invoke(ctx: Fixture, { args = [], env = {} }: { args?: string[]; env?: Record<string, string> } = {}) {
  const base: Record<string, string> = {};
  // Windows env keys are case-insensitive; a leftover `Path` next to `PATH`
  // would make the searched directories ambiguous.
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(path|kherep_install_upgrade_globals)$/i.test(key) && value !== undefined) base[key] = value;
  }
  return spawnSync(process.execPath, [subject, ctx.files.manifest, ...args], {
    encoding: "utf8",
    env: {
      ...base,
      PATH: [ctx.prefix, ctx.foreign].join(path.delimiter),
      KHEREP_NPM_BIN: process.execPath,
      KHEREP_NPM_BIN_ARGS_JSON: JSON.stringify([ctx.files.fake]),
      FAKE_NPM_LOG: ctx.files.log,
      FAKE_NPM_STATE: ctx.files.state,
      ...env,
    },
  });
}

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function commands(ctx: Fixture): string[][] {
  if (!fs.existsSync(ctx.files.log)) return [];
  return fs.readFileSync(ctx.files.log, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

function installs(ctx: Fixture): string[] {
  return commands(ctx).filter((args) => args.slice(0, 2).join(" ") === "i -g").map((args) => args[2]);
}

// Second manifest next to the base one, in the same throwaway root: this is what
// install.sh passes as the per-host override (OP-1087).
function overrideFile(ctx: Fixture, name: string, lines: string[]): string {
  const file = path.join(ctx.files.root, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("unpinned entry that is installed is skipped without any install", (t) => {
  const ctx = fixture(t);
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /npm-globals: alpha skip \(unpinned, 1\.0\.0 installed/);
  assert.deepEqual(installs(ctx), []);
});

test("unpinned entry that is missing is installed without a version", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["beta"];
  ctx.state.installed = {};
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /npm-globals: beta install \(not installed\)/);
  assert.deepEqual(installs(ctx), ["beta"]);
});

test("pinned entry at the pinned version is skipped", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["fixture-tool@13.21.2"];
  ctx.state.installed = { "fixture-tool": "13.21.2" };
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /fixture-tool skip \(pinned 13\.21\.2 already installed\)/);
  assert.deepEqual(installs(ctx), []);
});

test("pinned entry at another version installs exactly the pin, both directions", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["fixture-tool@13.21.2", "gamma@1.0.0"];
  ctx.state.installed = { "fixture-tool": "13.20.0", gamma: "2.0.0" };
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(installs(ctx), ["fixture-tool@13.21.2", "gamma@1.0.0"]);
  assert.match(output(result), /fixture-tool install \(pinned 13\.21\.2, found 13\.20\.0 \(upgrade to pin\)\)/);
  assert.match(output(result), /gamma install \(pinned 1\.0\.0, found 2\.0\.0 \(downgrade to pin\)\)/);
});

test("scoped package keeps its scope and takes the last @ as the pin", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["@openai/codex@1.2.3"];
  ctx.state.installed = { "@openai/codex": "0.9.0" };
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(installs(ctx), ["@openai/codex@1.2.3"]);
  assert.match(output(result), /npm-globals: @openai\/codex install \(pinned 1\.2\.3, found 0\.9\.0/);
});

test("binary present outside the npm prefix is skipped without calling npm i", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["bun"];
  ctx.state.installed = {};
  ctx.save();
  fs.writeFileSync(path.join(ctx.foreign, "bun"), "#!/bin/sh\n");
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /bun skip \(present outside npm \(.*bun\)\)/);
  assert.deepEqual(installs(ctx), []);
});

test("a binary in npm's own prefix dir that npm does not track is still foreign (Homebrew layout)", (t) => {
  // With Homebrew Node, `npm prefix -g` is /opt/homebrew and Homebrew links its
  // own bun into the same bin dir. Excluding that dir would reproduce OP-1085.
  const ctx = fixture(t);
  ctx.manifest = ["bun"];
  ctx.state.installed = {};
  ctx.save();
  fs.writeFileSync(path.join(ctx.prefix, "bun"), "#!/bin/sh\n");
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(installs(ctx), []);
  assert.match(output(result), /bun skip \(present outside npm/);
});

test("KHEREP_INSTALL_UPGRADE_GLOBALS=1 turns an unpinned skip into an install", (t) => {
  const ctx = fixture(t);
  const result = invoke(ctx, { env: { KHEREP_INSTALL_UPGRADE_GLOBALS: "1" } });
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(installs(ctx), ["alpha"]);
  assert.match(output(result), /alpha install \(upgrade requested \(latest\)\)/);
});

test("one failing package neither stops the others nor hides the nonzero exit", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["beta", "delta"];
  ctx.state.installed = {};
  ctx.state.outcomes = { beta: { exit: 17, stderr: "EEXIST" } };
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 1, output(result));
  assert.deepEqual(installs(ctx), ["beta", "delta"]);
  assert.match(output(result), /npm-globals: beta FAILED \(npm i -g beta\): EEXIST/);
  assert.match(output(result), /npm-globals: 2 entries, 1 installed, 0 skipped, 1 failed/);
});

test("--plan-only reports the plan and never installs", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["beta", "gamma@1.0.0"];
  ctx.state.installed = { gamma: "2.0.0" };
  ctx.save();
  const result = invoke(ctx, { args: ["--plan-only"] });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /plan-only 2 entries, 2 would install/);
  assert.deepEqual(installs(ctx), []);
});

test("npm ls exiting nonzero with a valid tree is still read", (t) => {
  const ctx = fixture(t);
  ctx.state.lsExit = 1;
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /alpha skip \(unpinned, 1\.0\.0 installed/);
  assert.deepEqual(installs(ctx), []);
});

test("a later manifest overrides the pin of an earlier one and names its source", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["gamma@1.0.0", "delta@1.0.0"];
  ctx.state.installed = { gamma: "1.0.0", delta: "1.0.0" };
  ctx.save();
  const file = overrideFile(ctx, "npm-globals.win.txt", ["# host override", "gamma@2.0.0"]);
  const result = invoke(ctx, { args: [file] });
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(installs(ctx), ["gamma@2.0.0"]);
  assert.match(output(result),
    /gamma install \(pinned 2\.0\.0, found 1\.0\.0 \(upgrade to pin\)\) \(override from npm-globals\.win\.txt\)/);
  // The untouched base entry keeps its plan line AND stays free of the suffix.
  assert.match(output(result), /delta skip \(pinned 1\.0\.0 already installed\)\r?\n/);
});

test("an optional override that does not exist is ignored, not an error", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["gamma@1.0.0"];
  ctx.state.installed = { gamma: "1.0.0" };
  ctx.save();
  const absent = path.join(ctx.files.root, "npm-globals.mac.txt");
  assert.equal(fs.existsSync(absent), false, "fixture is only meaningful while the file is absent");
  const result = invoke(ctx, { args: [`?${absent}`] });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /gamma skip \(pinned 1\.0\.0 already installed\)/);
  assert.doesNotMatch(output(result), /override from/);
});

test("a required manifest that does not exist fails closed, before npm is called at all", (t) => {
  const ctx = fixture(t);
  const absent = path.join(ctx.files.root, "npm-globals.win.txt");
  const result = invoke(ctx, { args: [absent] });
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /FATAL: cannot read npm-globals manifest/);
  // Not "no install" but "no npm call": the manifests are read before npm runs.
  assert.deepEqual(commands(ctx), []);
});

test("an override file with only comments changes nothing", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["gamma@1.0.0", "beta"];
  ctx.state.installed = { gamma: "2.0.0" };
  ctx.save();
  const file = overrideFile(ctx, "npm-globals.win.txt", ["# this box overrides nothing", ""]);
  const result = invoke(ctx, { args: [file] });
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(installs(ctx), ["gamma@1.0.0", "beta"]);
  assert.doesNotMatch(output(result), /override from/);
});

test("an optional override path that exists but is not a file fails closed instead of counting as absent", (t) => {
  const ctx = fixture(t);
  ctx.manifest = ["gamma@1.0.0"];
  ctx.state.installed = { gamma: "1.0.0" };
  ctx.save();
  const dir = path.join(ctx.files.root, "npm-globals.win.txt");
  fs.mkdirSync(dir);
  const result = invoke(ctx, { args: [`?${dir}`] });
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /optional manifest .*npm-globals\.win\.txt is not-a-file/);
  assert.deepEqual(commands(ctx), []);
});

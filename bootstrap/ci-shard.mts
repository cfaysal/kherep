#!/usr/bin/env node
// Windows CI shards for the bootstrap suites (issue #424).
//
// On a windows-latest runner the install tests drive install.sh under Git Bash
// for 80 to 330 seconds each, and the whole bootstrap glob took about 15
// minutes. The unit-windows matrix in ci.yml runs one shard per job: each heavy
// file named below alone, and bootstrap-rest with every other
// bootstrap/*.test.mts file, computed at run time, so a new test file runs
// there without an edit here. A new install test as slow as the named ones
// gets its own shard in NAMED and in the suite list in ci.yml;
// ci-shard.test.mts fails until both agree. Node's --test-shard splits by file
// index, not by duration, so the heavy files would pair up differently
// whenever a file is added before them.
//
//   node bootstrap/ci-shard.mts list | files <shard> | run <shard>
//
// `run` passes the file paths to node itself, so no shell expands a glob and
// pwsh and bash behave alike. Locally, `npm run test:bootstrap` stays the
// command that runs every bootstrap suite.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { errorMessage } from "./shape.mts";

const BOOTSTRAP = import.meta.dirname;
const REPO = path.dirname(BOOTSTRAP);

export const REST = "bootstrap-rest";

// File names under bootstrap/, one heavy file per shard.
export const NAMED: Record<string, string[]> = {
  "install-preview-safety": ["install-preview-safety.test.mts"],
  "project-rules-install": ["project-rules-install.test.mts"],
  "commit-policy-install": ["commit-policy-install.test.mts"],
  "drift-check-optional-tools": ["drift-check-optional-tools.test.mts"],
  "control-plane-hook-install": ["control-plane-hook-install.test.mts"],
  "control-plane-stable-install": ["control-plane-stable-install.test.mts"],
};

export const SHARDS: string[] = [...Object.keys(NAMED), REST];

// The population of the glob bootstrap/*.test.mts: files only, not recursive.
export function allTestFiles(): string[] {
  return fs.readdirSync(BOOTSTRAP, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mts"))
    .map((entry) => entry.name)
    .sort();
}

export function filesFor(name: string): string[] {
  if (Object.hasOwn(NAMED, name)) return [...NAMED[name]];
  if (name === REST) {
    const named = new Set(Object.values(NAMED).flat());
    return allTestFiles().filter((file) => !named.has(file));
  }
  throw new Error(`unknown shard "${name}"; known: ${SHARDS.join(", ")}`);
}

function main(args: string[]): number {
  const [command, name] = args;
  if (command === "list" && args.length === 1) {
    for (const shard of SHARDS) console.log(shard);
    return 0;
  }
  if ((command === "files" || command === "run") && args.length === 2) {
    const files = filesFor(name).map((file) => `bootstrap/${file}`);
    if (command === "files") {
      for (const file of files) console.log(file);
      return 0;
    }
    // A missing named file is not filtered out: node --test reports it and fails.
    const child = spawnSync(process.execPath, ["--test", ...files], { cwd: REPO, stdio: "inherit" });
    if (child.error) throw child.error;
    return child.status ?? 1;
  }
  console.error("usage: ci-shard.mts list | files <shard> | run <shard>");
  return 2;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`FATAL: ${errorMessage(error)}`); process.exitCode = 2; }
}

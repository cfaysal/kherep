#!/usr/bin/env node
/**
 * record-install-source.mts  -  called by bootstrap/install.sh
 *
 * Leaves a note under CLAUDE_HOME saying which checkout this install came from,
 * so claude/hooks/live-hook-integrity.js can restore a wiped hook from the
 * versioned source in ANY session, not only in one started inside the workspace.
 * The hooks are global; a 0-byte guard is broken everywhere.
 *
 * Advisory: the reader re-validates the path before using it, so a stale note
 * costs nothing, and a failure to write one must never fail an install.
 *
 * Usage: node record-install-source.mts <claudeHome> <repoRoot>
 * Git Bash converts both POSIX-looking arguments to native Windows paths on the
 * way in, which is exactly the form node can read back later - a raw /d/... from
 * `pwd` would resolve against the wrong drive root.
 */
import fs from "node:fs";
import path from "node:path";

import { errorCode } from "./shape.mts";

const [claudeHome, repoRoot] = process.argv.slice(2);

function fail(message: string): never {
  console.error(`record-install-source: ${message}`);
  process.exit(2);
}

if (!claudeHome || !repoRoot) fail("usage: <claudeHome> <repoRoot>");

// Recording a path that is not a checkout would hand the reader a note it can
// only reject later. Refuse at the source instead.
const resolved = path.resolve(repoRoot);
try {
  if (!fs.statSync(path.join(resolved, "claude", "hooks")).isDirectory()) throw new Error("not a directory");
} catch {
  fail(`${resolved} has no claude/hooks, nothing recorded`);
}

const dir = path.join(claudeHome, ".cache", "hook-integrity");
const file = path.join(dir, "source.json");
try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ repoRoot: resolved.replace(/\\/g, "/"), writtenAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
} catch (error) {
  fail(`could not write ${file} (${errorCode(error) || "unknown"})`);
}
console.log(`install: source checkout recorded -> ${file}`);

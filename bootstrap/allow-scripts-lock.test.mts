// Guards the npm allowScripts pins against the sibling lockfile (issue #559).
//
// npm 11 reads the package.json `allowScripts` field as the project's
// install-script policy. A pinned entry `name@version` matches a dependency
// only by its resolved identity, so a pin the lockfile no longer resolves
// allows nothing and `npm ci` warns about the unapproved install script. This
// test fails when any tracked package.json pins a version that its
// package-lock.json does not resolve. Unpinned keys (a bare name) match any
// version and are not checked here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");

type Lock = { packages?: Record<string, { version?: string }> };

// Tracked package.json files only, so node_modules and nested worktrees of a
// checkout are never read.
function trackedManifests(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "package.json", "**/package.json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.error ?? listed.stderr}`);
  return listed.stdout.split("\0").filter((file) => file !== "" && !file.split("/").includes("node_modules"));
}

// "name@version" -> [name, version]; a scoped name keeps its leading "@".
function splitPin(key: string): [string, string] | null {
  const at = key.lastIndexOf("@");
  return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : null;
}

function resolves(lock: Lock, name: string, version: string): boolean {
  return Object.entries(lock.packages ?? {}).some(
    ([key, entry]) => (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) && entry.version === version,
  );
}

test("every pinned allowScripts entry names a version the sibling lockfile resolves", () => {
  const manifests = trackedManifests().filter((file) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, file), "utf8"));
    return manifest.allowScripts !== undefined;
  });
  assert.ok(manifests.length > 0, "no tracked package.json declares allowScripts");

  const unresolved: string[] = [];
  for (const file of manifests) {
    const dir = path.dirname(path.join(repo, file));
    const lockFile = path.join(dir, "package-lock.json");
    assert.ok(fs.existsSync(lockFile), `${file} declares allowScripts but has no sibling package-lock.json`);
    const lock: Lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const allow: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(repo, file), "utf8")).allowScripts;
    for (const [key, value] of Object.entries(allow)) {
      if (value !== true) continue;
      const pin = splitPin(key);
      if (pin === null) continue;
      if (!resolves(lock, pin[0], pin[1])) unresolved.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(unresolved, [], "allowScripts pins not resolved by the sibling package-lock.json");
});

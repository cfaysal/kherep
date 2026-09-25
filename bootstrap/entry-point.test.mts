import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");

// GRUND (#16): confluence-space.mts compared import.meta.url with
// pathToFileURL(process.argv[1]). Reached through a symlinked directory, as
// under the macOS default TMPDIR (/var -> /private/var), the two never match:
// the CLI silently did nothing and exited 0. import.meta.main is symlink-safe.
test("CLI entry detection survives a linked script directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-entry-point-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, "bootstrap");
  // "junction" needs no symlink privilege on Windows; POSIX ignores the type.
  fs.symlinkSync(import.meta.dirname, link, "junction");
  const result = spawnSync(process.execPath, [path.join(link, "confluence-space.mts")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stderr, /FATAL: --out <file> is required\./);
});

test("no entry point compares import.meta.url with process.argv", () => {
  const fragile = /import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]/;
  const offenders: string[] = [];
  const skip = new Set(["node_modules", ".git", ".worktrees"]);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mts|ts|mjs|js)$/.test(entry.name) && fragile.test(fs.readFileSync(full, "utf8"))) {
        offenders.push(path.relative(repoRoot, full));
      }
    }
  };
  walk(repoRoot);
  assert.deepEqual(offenders, [], "use import.meta.main instead");
});

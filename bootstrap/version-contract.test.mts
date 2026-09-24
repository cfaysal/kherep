// Kherep has one product version. It is stated in several places, and this
// test keeps them equal. The release procedure is in docs/PUBLIC-RELEASE.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repo, relative), "utf8")) as Record<string, unknown>;
}

// SemVer 2.0.0 without build metadata: build metadata never orders releases.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const pkg = readJson("package.json");
const version = String(pkg.version ?? "");

test("package.json declares a SemVer version and stays unpublishable to npm", () => {
  assert.match(version, SEMVER);
  assert.equal(pkg.private, true);
});

test("package-lock.json records the same version", () => {
  const lock = readJson("package-lock.json") as { version?: unknown; packages?: Record<string, { version?: unknown }> };
  assert.equal(lock.version, version);
  assert.equal(lock.packages?.[""]?.version, version);
});

test("the Codex plugin manifests carry the product version and license", () => {
  const plugin = readJson("codex/marketplace/plugins/kherep-maestro/.codex-plugin/plugin.json");
  const marketplace = readJson("codex/marketplace/.agents/plugins/marketplace.json") as
    { plugins?: Array<{ name?: unknown; version?: unknown }> };
  assert.equal(plugin.version, version);
  assert.equal(marketplace.plugins?.find((entry) => entry.name === "kherep-maestro")?.version, version);
  assert.equal(plugin.license, pkg.license);
});

test("the newest CHANGELOG.md release section is this version", () => {
  const changelog = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^## \[Unreleased\]$/m);
  const newest = /^## \[(\d[^\]]*)\] - (\d{4}-\d{2}-\d{2})$/m.exec(changelog);
  assert.equal(newest?.[1], version);
  assert.match(changelog, new RegExp(`^\\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]: https://`, "m"));
});

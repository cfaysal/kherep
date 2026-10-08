// Issue #325, PR-A. `kherep-node attribution [--branch] [--pr] [--repo]
// [--since <hours>] [--json]` reads the local attribution log.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { appendAttribution, type AttributionRecord } from "./attribution.mts";
import { runAttribution } from "./attribution-cli.mts";
import { main } from "./cli.mts";
import { nodePaths, type NodePaths } from "./config.mts";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-08T12:00:00.000Z");

function seeded(t: TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-attribution-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const base: AttributionRecord = { v: 1, ts: "", kind: "push", sessionId: "synthetic-claude-1", runtime: "claude",
    sessionSource: "CLAUDE_CODE_SESSION_ID", repo: "example/repo", toplevel: "/synthetic/repo", branch: "feat/a",
    remoteRef: "refs/heads/feat/a", sha: "a".repeat(40), pr: null };
  const rows: Partial<AttributionRecord>[] = [
    { ts: new Date(NOW - 30 * HOUR).toISOString() },
    { ts: new Date(NOW - 2 * HOUR).toISOString(), kind: "pr-create", remoteRef: null, pr: 7, prSource: "stdout" },
    { ts: new Date(NOW - HOUR).toISOString(), branch: "feat/b", sha: "b".repeat(40), repo: "example/other",
      sessionId: "synthetic-codex-1", runtime: "codex", sessionSource: "marker" },
  ];
  for (const row of rows) appendAttribution(paths, { ...base, ...row }, NOW);
  return paths;
}

function run(paths: NodePaths, argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runAttribution(argv, { paths, now: () => NOW, write: (text) => (out += text), warn: (text) => (err += text) });
  return { code, out, err };
}

const shas = (out: string): string[] => (JSON.parse(out) as AttributionRecord[]).map((entry) => `${entry.kind}:${entry.branch}`);

test("--json prints every record, oldest first", (t) => {
  const result = run(seeded(t), ["--json"]);
  assert.equal(result.code, 0);
  assert.deepEqual(shas(result.out), ["push:feat/a", "pr-create:feat/a", "push:feat/b"]);
});

test("--branch, --pr, --repo and --since filter the records", (t) => {
  const paths = seeded(t);
  assert.deepEqual(shas(run(paths, ["--json", "--branch", "feat/b"]).out), ["push:feat/b"]);
  assert.deepEqual(shas(run(paths, ["--json", "--pr", "7"]).out), ["pr-create:feat/a"]);
  assert.deepEqual(shas(run(paths, ["--json", "--repo", "example/repo"]).out), ["push:feat/a", "pr-create:feat/a"]);
  assert.deepEqual(shas(run(paths, ["--json", "--since", "3"]).out), ["pr-create:feat/a", "push:feat/b"]);
  assert.deepEqual(shas(run(paths, ["--json", "--branch", "feat/a", "--since", "24"]).out), ["pr-create:feat/a"]);
});

test("the text form prints one line per record with session, runtime, repo, branch, sha and PR", (t) => {
  const lines = run(seeded(t), ["--branch", "feat/a"]).out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /pr-create.*example\/repo.*feat\/a.*aaaaaaa.*#7.*claude.*synthetic-claude-1/);
});

test("an empty log prints nothing in text form and [] in JSON", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-attribution-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(run(nodePaths(root), []), { code: 0, out: "", err: "" });
  assert.deepEqual(JSON.parse(run(nodePaths(root), ["--json"]).out), []);
});

test("bad arguments print the usage and exit 2", (t) => {
  const paths = seeded(t);
  for (const argv of [["--pr", "x"], ["--since", "-1"], ["--nope"], ["extra"]]) {
    const result = run(paths, argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.err, /^usage:\n {2}kherep-node attribution /);
  }
});

test("cli.mts dispatches attribution before its own argument parsing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-attribution-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.KHEREP_CONFIG_DIR;
  process.env.KHEREP_CONFIG_DIR = root;
  t.after(() => (previous === undefined ? delete process.env.KHEREP_CONFIG_DIR : (process.env.KHEREP_CONFIG_DIR = previous)));
  const logged: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => (logged.push(String(chunk)), true));
  assert.equal(await main(["attribution", "--json", "--since", "1"]), 0);
  t.mock.restoreAll();
  assert.deepEqual(JSON.parse(logged.join("")), []);
});

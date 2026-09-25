import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { parseCli } from "./runtime/cli-contract.mts";
import { createTwgClient, TwgError } from "./runtime/client.mts";
import type { TwgExecCallback } from "./runtime/client.mts";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function completeToFile(args: string[], callback: TwgExecCallback, body: unknown): void {
  const index = args.indexOf("--output-file");
  assert.notEqual(index, -1, "TWG argv must use a controlled output file");
  fs.writeFileSync(args[index + 1], JSON.stringify(body));
  callback(null, "ignored agent summary", "ignored diagnostic");
}

test("CLI accepts only the bounded read surface and rejects options or write verbs", () => {
  assert.deepEqual(parseCli(["status"]), { operation: "status" });
  assert.deepEqual(parseCli(["jira-get", "OP-1120"]), { operation: "jira-get", input: "OP-1120" });
  assert.deepEqual(parseCli(["jira-get", "JIRA_2-17"]), { operation: "jira-get", input: "JIRA_2-17" });
  assert.deepEqual(parseCli(["confluence-search", "release notes"]), { operation: "confluence-search", input: "release notes" });
  for (const argv of [
    ["jira-delete", "OP-1120"], ["jira-get", "--site"], ["jira-get", "OP-1120", "--raw"],
    ["confluence-search", ""], ["status", "extra"], ["jira-get", "xx-1"], ["jira-get", "XX-0"],
  ]) {
    assert.throws(() => parseCli(argv), (error) => error instanceof TwgError && error.code === "TWG_USAGE");
  }
});

test("client methods enforce the same input gate before process execution", () => {
  let calls = 0;
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl() { calls += 1; },
  });
  for (const invoke of [
    () => client.jiraGet("xx-1"),
    () => client.jiraSearch("--site"),
    () => client.confluenceSearch("-o"),
  ]) {
    assert.throws(invoke, (error) => error instanceof TwgError && error.code === "TWG_USAGE");
  }
  assert.equal(calls, 0);
});

test("confluence-search rejects rows without an id and title", async () => {
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      completeToFile(args, callback, {
        command: "confluence.search.text",
        data: { results: [{}], size: 1, totalSize: 1, nextCursor: null },
      });
    },
  });
  await assert.rejects(
    client.confluenceSearch("fixture"),
    (error) => error instanceof TwgError && error.code === "TWG_OUTPUT_INVALID",
  );
});

test("public CLI help lists only read operations and usage errors are structured", () => {
  const cli = path.join(moduleDir, "runtime", "cli.mts");
  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  const helpBody = JSON.parse(help.stdout);
  assert.deepEqual(helpBody.operations, ["status", "jira-get", "jira-search", "confluence-search", "help"]);
  assert.equal(JSON.stringify(helpBody).includes("delete"), false);

  const rejected = spawnSync(process.execPath, [cli, "jira-delete", "OP-1120"], { encoding: "utf8" });
  assert.equal(rejected.status, 2);
  assert.deepEqual(JSON.parse(rejected.stdout), {
    ok: false, error: { code: "TWG_USAGE", message: "Use one documented TWG read operation." },
  });
  assert.equal(withoutTypeStrippingWarning(rejected.stderr), "");
});

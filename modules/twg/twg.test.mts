import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTwgClient, TwgError } from "./runtime/client.mts";
import type { TwgExecCallback, TwgExecOptions, TwgProcessError } from "./runtime/client.mts";

interface CompleteOptions {
  error?: TwgProcessError;
  stdout?: string;
  stderr?: string;
}

interface ProcessCall {
  file: string;
  args: string[];
  options: TwgExecOptions;
}
function completeToFile(
  args: string[],
  callback: TwgExecCallback,
  body: unknown,
  options: CompleteOptions = {},
): void {
  const index = args.indexOf("--output-file");
  assert.notEqual(index, -1, "TWG argv must use a controlled output file");
  fs.writeFileSync(args[index + 1], typeof body === "string" ? body : JSON.stringify(body));
  callback(options.error || null, options.stdout || "ignored agent summary", options.stderr || "ignored diagnostic");
}
test("client rejects a TWG result path redirected through a symbolic-link directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-twg-result-link-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "result.json"), JSON.stringify({
    command: "doctor.get", data: {
      build: { version: "1.2.7" }, auth: { config: { loaded: true }, resolved: { tokenPresent: true } },
      connectivity: { attempted: true, ok: true }, skills: { canonicalExists: false }, upkeep: { status: "disabled" },
    },
  }));
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      const outputFile = args[args.indexOf("--output-file") + 1];
      const tempDir = path.dirname(outputFile);
      fs.rmSync(tempDir, { force: true, recursive: true });
      fs.symlinkSync(outside, tempDir, process.platform === "win32" ? "junction" : "dir");
      callback(null, "", "");
    },
  });
  await assert.rejects(client.status(), (error) => error instanceof TwgError && error.code === "TWG_OUTPUT_INVALID");
});

test("status runs doctor with fixed argv and returns only allowlisted fields", async () => {
  const calls: ProcessCall[] = [];
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      completeToFile(args, callback, {
        apiVersion: "v2", command: "doctor.get", data: {
          build: { version: "1.2.7", secretBuildPath: "C:\\private\\credential.json" },
          auth: { config: { loaded: true, fields: { authMethod: "oauth" } }, resolved: { tokenPresent: true } },
          connectivity: { attempted: true, ok: true }, skills: { canonicalExists: false },
          upkeep: { status: "disabled" }, credentialPath: "C:\\private\\credential.json",
        },
      }, { stdout: "yaml summary", stderr: "hostile stderr C:\\private\\credential.json token=secret" });
    },
  });
  assert.deepEqual(await client.status(), {
    version: "1.2.7", authConfigured: true, tokenPresent: true,
    connectivityAttempted: true, connectivityOk: true,
    canonicalSkillsInstalled: false, upkeepStatus: "disabled",
  });
  assert.deepEqual(calls[0].args.slice(0, 3), ["doctor", "-o", "json"]);
  assert.equal(calls[0].args.at(-2), "--output-file");
  assert.equal(path.basename(calls[0].args.at(-1)!), "result.json");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(JSON.stringify(await client.status()).includes("credential"), false);
});

test("jira-get preserves hostile text as one positional argument", async () => {
  const calls: ProcessCall[] = [];
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      completeToFile(args, callback, {
        apiVersion: "v2", command: "jira.workitem.get",
        data: [{ key: "OP-1120", summary: "TWG integration", status: { name: "In Progress" }, private: "drop" }],
      });
    },
  });
  assert.deepEqual(await client.jiraGet("OP-1120"), {
    key: "OP-1120", summary: "TWG integration", status: "In Progress",
  });
  assert.deepEqual(calls[0].args.slice(0, -2), [
    "jira", "workitem", "get", "OP-1120", "--fields", "summary,status", "-o", "json",
  ]);
  assert.equal(calls[0].args.at(-2), "--output-file");
  assert.equal(calls[0].options.shell, false);
});

test("jira-get rejects a successful envelope for a different key", async () => {
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      completeToFile(args, callback, {
        apiVersion: "v2", command: "jira.workitem.get",
        data: [{ key: "OP-999", summary: "Wrong", status: { name: "To Do" } }],
      });
    },
  });
  await assert.rejects(
    client.jiraGet("OP-1120"),
    (error) => error instanceof TwgError && error.code === "TWG_OUTPUT_INVALID",
  );
});

test("jira-search uses the query command without saving local JQL history", async () => {
  const calls: ProcessCall[] = [];
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      completeToFile(args, callback, {
        apiVersion: "v2", command: "jira.workitem.query", data: { issues: [{
          id: "10000", key: "OP-1120", url: "https://example.atlassian.net/browse/OP-1120",
          summary: "TWG integration", status: { name: "In Progress" }, updated: "2026-09-06T12:00:00Z",
          reporter: { displayName: "drop" }, project: { name: "drop" },
        }] },
      });
    },
  });
  assert.deepEqual(await client.jiraSearch("key = OP-1120"), {
    issues: [{
      key: "OP-1120", summary: "TWG integration", status: "In Progress",
      url: "https://example.atlassian.net/browse/OP-1120", updated: "2026-09-06T12:00:00Z",
    }],
    returned: 1,
    limit: 25,
  });
  assert.deepEqual(calls[0].args.slice(0, -2), [
    "jira", "workitem", "query", "--jql", "key = OP-1120", "--limit", "25",
    "--save-jqlto-user-history", "false", "-o", "json",
  ]);
});

test("confluence-search uses the current text subcommand and preserves explicit empty results", async () => {
  const calls: ProcessCall[] = [];
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      completeToFile(args, callback, {
        apiVersion: "v2", command: "confluence.search.text", data: {
          results: [], start: 0, limit: 25, size: 0, totalSize: 0,
          cqlQuery: "text ~ fixture", searchDuration: 12, archivedResultCount: 0,
          _links: {}, nextCursor: null,
        },
      });
    },
  });
  assert.deepEqual(await client.confluenceSearch("Teamwork Graph CLI"), {
    results: [], size: 0, totalSize: 0, nextCursor: null,
  });
  assert.deepEqual(calls[0].args.slice(0, -2), [
    "confluence", "search", "text", "Teamwork Graph CLI", "--limit", "25", "-o", "json",
  ]);
});

test("confluence-search projects the documented nested search result", async () => {
  const client = createTwgClient({
    resolveBinary: () => "/safe/twg",
    execFileImpl(file, args, options, callback) {
      completeToFile(args, callback, {
        apiVersion: "v2", command: "confluence.search.text", data: {
          results: [{
            content: { id: "123", type: "page", status: "current", title: "Nested title", restrictions: { private: true } },
            title: "Search title", excerpt: "Approved excerpt", url: "https://example.atlassian.net/wiki/x/123",
            resultGlobalContainer: { title: "Engineering", displayUrl: "drop" }, breadcrumbs: [{ title: "drop" }],
            entityType: "page", lastModified: "2026-09-06T12:00:00Z", friendlyLastModified: "today", score: 0.9,
          }],
          size: 1, totalSize: 1, nextCursor: null,
        },
      });
    },
  });
  assert.deepEqual(await client.confluenceSearch("Scalpel"), {
    results: [{
      id: "123", title: "Search title", type: "page", status: "current",
      url: "https://example.atlassian.net/wiki/x/123", excerpt: "Approved excerpt",
      space: "Engineering", lastModified: "2026-09-06T12:00:00Z",
    }],
    size: 1, totalSize: 1, nextCursor: null,
  });
});

test("process, auth, output-limit, and malformed envelopes fail with safe fixed errors", async () => {
  const cases: Array<{
    invoke(callback: TwgExecCallback, args: string[]): void;
    code: string;
  }> = [
    {
      invoke(callback) {
        const error = new Error("C:\\secret\\credentials.json bearer abc") as TwgProcessError;
        error.code = 1;
        callback(error, "token", "secret");
      },
      code: "TWG_PROCESS_FAILED",
    },
    {
      invoke(callback) {
        const error = new Error("C:\\secret\\credentials.json bearer abc") as TwgProcessError;
        error.killed = true;
        callback(error, "token", "secret");
      },
      code: "TWG_TIMEOUT",
    },
    {
      invoke(callback, args) { completeToFile(args, callback, { command: "doctor.get", data: { auth: { config: { loaded: false }, resolved: { tokenPresent: false } } } }); },
      code: "TWG_AUTH_REQUIRED",
    },
    { invoke(callback, args) { completeToFile(args, callback, "{".repeat(300_000)); }, code: "TWG_OUTPUT_LIMIT" },
    { invoke(callback, args) { completeToFile(args, callback, "not-json"); }, code: "TWG_OUTPUT_INVALID" },
    {
      invoke(callback, args) {
        completeToFile(args, callback, {
          command: "doctor.get", errors: [{ message: "C:\\private\\credential.json token=secret" }],
          data: { build: { version: "1.2.7" } },
        });
      },
      code: "TWG_COMMAND_ERROR",
    },
  ];
  for (const fixture of cases) {
    const client = createTwgClient({
      resolveBinary: () => "/safe/twg",
      execFileImpl(file, args, options, callback) { fixture.invoke(callback, args); },
    });
    await assert.rejects(client.status(), (error) => {
      assert.ok(error instanceof TwgError);
      assert.equal(error.code, fixture.code);
      assert.doesNotMatch(error.message, /secret|credential|bearer|token/i);
      return true;
    });
  }
});

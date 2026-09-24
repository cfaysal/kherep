// OP-1440. The research lookup, driven through both brokers' command lines.
// Three outcomes have to stay apart (golden rule 12): hits, a search that ran
// and matched nothing in the space, and a search that could not run. Synthetic
// values only: injected fetch and semantic search, no network, no process.
import assert from "node:assert/strict";
import test from "node:test";

import { runCli as runClaude, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as runCodex } from "./atl-confluence.mts";
import type { Proposals } from "./confluence-semantic.mts";
import type { HttpResponse } from "./confluence-session.mts";

const SITE = "https://wiki.example.com";
const CRED_PATH = "/nowhere/credentials-for-tests";
const CRED_TEXT = "Client ID: client-id-for-tests\nSecret: secret-for-tests-1234\n";

const BROKERS = [
  { name: "atl-confluence-ccoder.mts", run: runClaude, env: "KHEREP_ATL_CRED_FILE_CLAUDE" },
  { name: "atl-confluence.mts", run: runCodex, env: "KHEREP_ATL_CRED_FILE_CODEX" },
];

function response(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body ?? {}; },
    async text() { return JSON.stringify(body ?? {}); },
  };
}

// The space: one shelf (7000) holding two leaves, plus a page elsewhere on the
// site that the semantic search also proposes.
const SPACE = { results: [{ id: "9001", key: "KB", name: "Knowledge" }] };
const PAGES = {
  results: [
    { id: "7000", title: "Development", parentId: null },
    { id: "7001", title: "Hook ordering in Stop events", parentId: "7000" },
    { id: "7002", title: "Broker verbs and exit codes", parentId: "7000" },
  ],
};
const LABELS: Record<string, string[]> = {
  "7001": ["type-observation", "evidence-confirmed", "status-author-model"],
  "7002": ["type-observation"],
};

function api(url: string): HttpResponse {
  if (url.includes("/spaces?keys=")) return response(200, SPACE);
  if (url.includes("/spaces/9001/pages")) return response(200, PAGES);
  const labels = url.match(/\/pages\/(\d+)\/labels/);
  if (labels) return response(200, { results: (LABELS[labels[1]] ?? []).map((name) => ({ name })) });
  return response(200, {});
}

function harness(env: string, semantic: (query: string) => Promise<Proposals>) {
  const out: string[] = [];
  const err: string[] = [];
  const queries: string[] = [];
  const injected: Injected = {
    env: { KHEREP_ATL_SITE: SITE, [env]: CRED_PATH },
    async readFile(path) {
      if (path !== CRED_PATH) throw new Error("no such file");
      return CRED_TEXT;
    },
    async fetch(url) {
      if (url.startsWith("https://auth.atlassian.com")) return response(200, { access_token: "token", expires_in: 3600 });
      if (url.endsWith("/_edge/tenant_info")) return response(200, { cloudId: "cloud" });
      return api(url);
    },
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
    semantic: async (query) => { queries.push(query); return semantic(query); },
  };
  return { out, err, queries, injected };
}

const proposing = (...titles: string[]) => async (): Promise<Proposals> => ({ titles });

for (const broker of BROKERS) {
  test(`${broker.name} search prints space hits with evidence label and URL, exit 0`, async () => {
    const { out, queries, injected } = harness(
      broker.env,
      proposing("Somewhere else entirely", "Development", "Hook ordering in Stop events", "Broker verbs and exit codes"),
    );
    const code = await broker.run(["search", "--space", "KB", "--query", "stop hook order"], injected);
    assert.equal(code, 0);
    assert.deepEqual(queries, ["stop hook order"]);
    assert.deepEqual(out, [
      `hit\t7001\tHook ordering in Stop events\tevidence-confirmed\t${SITE}/wiki/spaces/KB/pages/7001`,
      `hit\t7002\tBroker verbs and exit codes\tno evidence label\t${SITE}/wiki/spaces/KB/pages/7002`,
      "count: 2",
      "status: hit",
    ]);
  });

  test(`${broker.name} search keeps only leaf pages of the named space and honours --limit`, async () => {
    const { out, injected } = harness(
      broker.env,
      proposing("Development", "Somewhere else entirely", "Broker verbs and exit codes", "Hook ordering in Stop events"),
    );
    assert.equal(await broker.run(["search", "--space", "KB", "--query", "verbs", "--limit", "1"], injected), 0);
    assert.equal(out.filter((line) => line.startsWith("hit\t")).length, 1);
    assert.match(out[0], /^hit\t7002\t/, "the shelf and the foreign page are dropped, order is kept");
  });

  test(`${broker.name} search reports a measured no match with exit 1`, async () => {
    const { out, err, injected } = harness(broker.env, proposing("Development", "Somewhere else entirely"));
    assert.equal(await broker.run(["search", "--space", "KB", "--query", "nothing here"], injected), 1);
    assert.deepEqual(out, ["count: 0", "status: no match"]);
    assert.deepEqual(err, []);
  });

  test(`${broker.name} search reports unavailable, not zero, when the search could not run`, async () => {
    const { out, err, injected } = harness(broker.env, async () => ({ titles: [], error: "semantic search did not run: twg missing" }));
    assert.equal(await broker.run(["search", "--space", "KB", "--query", "anything"], injected), 2);
    assert.deepEqual(out, ["status: unavailable"]);
    assert.match(err.join("\n"), /did not run/);
    assert.match(err.join("\n"), /UNKNOWN, not zero/);
  });

  test(`${broker.name} search is unavailable when the credential is missing or the query is empty`, async () => {
    const missing = harness(broker.env, proposing("Broker verbs and exit codes"));
    missing.injected.env = { KHEREP_ATL_SITE: SITE };
    assert.equal(await broker.run(["search", "--space", "KB", "--query", "x"], missing.injected), 2);
    assert.deepEqual(missing.out, ["status: unavailable"]);
    assert.match(missing.err.join("\n"), new RegExp(`${broker.env} is not set`));

    const empty = harness(broker.env, proposing("Broker verbs and exit codes"));
    assert.equal(await broker.run(["search", "--space", "KB"], empty.injected), 2);
    assert.match(empty.err.join("\n"), /--query is missing/);
    assert.deepEqual(empty.queries, [], "nothing is searched without a query");
  });
}

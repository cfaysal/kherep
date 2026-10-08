// Issue #315. The space inventory, driven through both brokers' command lines.
// The total is counted by reading to exhaustion, never taken from a size field,
// and a read that failed must not print a total that looks measured (golden
// rule 12). Synthetic values only: injected fetch, no network, no process.
import assert from "node:assert/strict";
import test from "node:test";

import { runCli as runClaude, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as runCodex } from "./atl-confluence.mts";
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

type Route = (url: string) => HttpResponse | undefined;

// Two spaces. KB holds 250 + 30 pages across two cursor pages; KX holds one.
const SPACES: Record<string, { id: string; key: string; name: string }> = {
  KB: { id: "9001", key: "KB", name: "Knowledge" },
  KX: { id: "9002", key: "KX", name: "Elsewhere" },
};
const page = (n: number) => ({ id: String(10_000 + n), title: n % 2 ? `Runbook ${n}` : `Decision ${n}`, parentId: null });
const FIRST = Array.from({ length: 250 }, (_, i) => page(i + 1));
const SECOND = Array.from({ length: 30 }, (_, i) => page(251 + i));
const NEXT = "/api/v2/spaces/9001/pages?limit=250&status=current&cursor=c2";

function spaceIndexRoute(second: () => unknown): Route {
  return (url) => {
    const keys = url.match(/\/spaces\?keys=([^&]+)/);
    if (keys) {
      const space = SPACES[decodeURIComponent(keys[1])];
      return response(200, { results: space ? [space] : [] });
    }
    if (url.includes("/spaces/9002/pages")) return response(200, { results: [{ id: "20001", title: "Runbook elsewhere" }] });
    if (url.includes("/spaces/9001/pages") && url.includes("cursor=c2")) return response(200, second());
    if (url.includes("/spaces/9001/pages")) return response(200, { results: FIRST, _links: { next: NEXT } });
    return undefined;
  };
}

const INDEX = spaceIndexRoute(() => ({ results: SECOND, _links: {} }));

function harness(env: string, route: Route) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const injected: Injected = {
    env: { KHEREP_ATL_SITE: SITE, [env]: CRED_PATH },
    async readFile(path) {
      if (path !== CRED_PATH) throw new Error("no such file");
      return CRED_TEXT;
    },
    async fetch(url) {
      if (new URL(url).origin === "https://auth.atlassian.com") return response(200, { access_token: "token", expires_in: 3600 });
      if (url.endsWith("/_edge/tenant_info")) return response(200, { cloudId: "cloud" });
      urls.push(url);
      return route(url) ?? response(404, { message: "not in this fake" });
    },
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
    semantic: async () => { throw new Error("list must not use the semantic search"); },
  };
  return { out, err, urls, injected };
}

const rows = (out: string[]) => out.filter((line) => line.startsWith("page\t"));

for (const broker of BROKERS) {
  test(`${broker.name} list counts every page of the space across cursor pages`, async () => {
    const { out, err, urls, injected } = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list", "--space", "KB"], injected), 0);
    assert.deepEqual(err, []);
    assert.equal(rows(out).length, 280);
    assert.equal(rows(out)[0], `page\t10001\tRunbook 1\t${SITE}/wiki/spaces/KB/pages/10001`);
    assert.deepEqual(out.slice(-3), ["total: 280", "shown: 280", "truncated: false"]);
    assert.ok(urls.some((url) => url.includes("cursor=c2")), "the second cursor page is read");
  });

  test(`${broker.name} list ends on a cursor that repeats instead of spinning`, async () => {
    // The same cursor with the same rows, every time. A fake that eventually
    // fails keeps an unguarded loop from hanging the suite: it then exits 1.
    let calls = 0;
    const repeating = spaceIndexRoute(() => {
      calls += 1;
      if (calls > 5) throw new Error("the loop followed a repeating cursor");
      return { results: SECOND, _links: { next: NEXT } };
    });
    const { out, urls, injected } = harness(broker.env, repeating);
    assert.equal(await broker.run(["list", "--space", "KB"], injected), 0);
    assert.ok(out.includes("total: 280"));
    assert.ok(urls.filter((url) => url.includes("cursor=c2")).length <= 2, "the repeated cursor is not followed forever");
  });

  test(`${broker.name} list reads only the named space`, async () => {
    const { out, urls, injected } = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list", "--space", "KX"], injected), 0);
    assert.deepEqual(rows(out), [`page\t20001\tRunbook elsewhere\t${SITE}/wiki/spaces/KX/pages/20001`]);
    assert.ok(out.includes("total: 1"));
    assert.ok(!urls.some((url) => url.includes("/spaces/9001/")), "no page of KB is read for KX");
  });

  test(`${broker.name} list filters titles case-insensitively on the client`, async () => {
    const { out, urls, injected } = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list", "--space", "KB", "--title-contains", "RUNBOOK 27"], injected), 0);
    // Runbook 27 and Runbook 271, 273, 275, 277, 279 (odd numbers only are runbooks).
    assert.deepEqual(rows(out).map((line) => line.split("\t")[2]),
      ["Runbook 27", "Runbook 271", "Runbook 273", "Runbook 275", "Runbook 277", "Runbook 279"]);
    assert.deepEqual(out.slice(-3), ["total: 6", "shown: 6", "truncated: false"]);
    assert.ok(!urls.some((url) => url.includes("/rest/api/search")), "the title filter sends no CQL");
  });

  test(`${broker.name} list --limit cuts the rows, not the total`, async () => {
    const { out, injected } = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list", "--space", "KB", "--limit", "5"], injected), 0);
    assert.equal(rows(out).length, 5);
    assert.deepEqual(out.slice(-3), ["total: 280", "shown: 5", "truncated: true"]);
  });

  test(`${broker.name} list --label quotes the label in CQL, follows next and keeps only indexed pages`, async () => {
    const search: Route = (url) => {
      if (!url.includes("/wiki/rest/api/search")) return undefined;
      if (url.includes("cursor=l2")) {
        return response(200, { results: [{ content: { id: "10004" } }, { content: { id: "99999" } }], _links: {} });
      }
      return response(200, {
        results: [{ content: { id: "10002" } }, { content: { id: "10003" } }],
        totalSize: 1,
        _links: { next: "/rest/api/search?cql=x&cursor=l2" },
      });
    };
    const { out, urls, injected } = harness(broker.env, (url) => search(url) ?? INDEX(url));
    assert.equal(await broker.run(["list", "--space", "KB", "--label", 'x"y'], injected), 0);
    const cql = urls.filter((url) => url.includes("/wiki/rest/api/search"));
    assert.equal(cql.length, 2, "the label loop follows _links.next");
    const query = new URL(cql[0]).searchParams.get("cql");
    assert.equal(query, 'space="KB" and type=page and label="x\\"y"');
    assert.deepEqual(rows(out).map((line) => line.split("\t")[1]), ["10002", "10003", "10004"]);
    assert.deepEqual(out.slice(-3), ["total: 3", "shown: 3", "truncated: false"], "totalSize is not the total");
  });

  test(`${broker.name} list --label ends on a label cursor that repeats`, async () => {
    let calls = 0;
    const search: Route = (url) => {
      if (!url.includes("/wiki/rest/api/search")) return undefined;
      calls += 1;
      if (calls > 5) return response(500, { message: "the loop followed a repeating cursor" });
      return response(200, { results: [{ content: { id: "10002" } }], _links: { next: "/rest/api/search?cql=x&cursor=same" } });
    };
    const { out, urls, injected } = harness(broker.env, (url) => search(url) ?? INDEX(url));
    assert.equal(await broker.run(["list", "--space", "KB", "--label", "runbook"], injected), 0);
    assert.ok(urls.filter((url) => url.includes("/wiki/rest/api/search")).length <= 2);
    assert.ok(out.includes("total: 1"));
  });

  test(`${broker.name} list prints no total when a read failed, exit 1`, async () => {
    const failing = spaceIndexRoute(() => { throw new Error("unused"); });
    const broken: Route = (url) => url.includes("cursor=c2") ? response(500, { message: "boom" }) : failing(url);
    const { out, err, injected } = harness(broker.env, broken);
    assert.equal(await broker.run(["list", "--space", "KB"], injected), 1);
    assert.ok(!out.some((line) => line.startsWith("total:")), "a failed read never prints a total");
    assert.deepEqual(rows(out), [], "no partial inventory is printed");
    assert.ok(err.length > 0);
  });

  test(`${broker.name} list refuses an unknown space and a bad limit with exit 1 and no total`, async () => {
    const unknown = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list", "--space", "NOPE"], unknown.injected), 1);
    assert.ok(!unknown.out.some((line) => line.startsWith("total:")));
    assert.match(unknown.err.join("\n"), /No space with that key/);

    const bad = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list", "--space", "KB", "--limit", "0"], bad.injected), 1);
    assert.match(bad.err.join("\n"), /--limit must be a positive whole number/);
    assert.deepEqual(bad.urls, [], "an argument error is refused before any request");

    const missing = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list"], missing.injected), 1);
    assert.deepEqual(missing.out, []);
  });

  test(`${broker.name} list prints total 0 with exit 0 when nothing matches`, async () => {
    const { out, injected } = harness(broker.env, INDEX);
    assert.equal(await broker.run(["list", "--space", "KB", "--title-contains", "no such title"], injected), 0);
    assert.deepEqual(out, ["total: 0", "shown: 0", "truncated: false"]);
  });
}

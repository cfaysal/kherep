// Tests for the exact-term half of the neighbour search (issue #651): the CQL
// is built from the title's words, never from the raw title, and a refused
// request is reported with its status instead of aborting the run.
import assert from "node:assert/strict";
import test from "node:test";

import { requestError, SCOPES, type ConfluenceSession, type RequestSpec } from "./confluence-contract.mts";
import { textCql, textFailureLine, textSearch, textTerms } from "./confluence-text-search.mts";

function recorder(bodies: unknown[] = []) {
  const specs: RequestSpec[] = [];
  const session: ConfluenceSession = {
    async request(spec) {
      specs.push(spec);
      return { status: 200, json: bodies[specs.length - 1] ?? { results: [] } };
    },
  };
  return { session, specs };
}

function refusing(status: number, body: unknown = {}): ConfluenceSession {
  return {
    async request(spec) {
      throw requestError({ method: "GET", path: spec.path, scope: SCOPES.get }, status, body);
    },
  };
}

const cqlOf = (spec: RequestSpec): string => decodeURIComponent(spec.path.split("cql=")[1].split("&")[0]);
const valueOf = (cql: string): string => /text ~ "(.*)"$/.exec(cql)?.[1] ?? "";
const ISSUE_TITLE = "Four files import the confluence-evidence modules (grep over modules, bootstrap, claude, codex)";
const ISSUE_CQL = 'space="KB" and type=page and text ~ "four files import confluence evidence modules grep bootstrap claude codex"';

test("textSearch scopes the CQL to the space and reads both result shapes", async () => {
  const { session, specs } = recorder([
    { results: [{ content: { title: "Wrapped In Content" } }, { title: "Flat Title" }, { title: "" }] },
  ]);
  const hits = await textSearch(session, "KB", 'quotes "inside"', 5);
  assert.deepEqual(hits.titles, ["Wrapped In Content", "Flat Title"]);
  assert.deepEqual(hits.failure, { kind: "rows", unreadable: 1, rows: 3 }, "the empty-title row is counted, not dropped");
  assert.equal(cqlOf(specs[0]), 'space="KB" and type=page and text ~ "quotes inside"', "the quote is stripped, not escaped");
  assert.equal(hits.cql, cqlOf(specs[0]));
  assert.equal(specs[0].scope, SCOPES.get);
});

test("parentheses and commas: the issue's title becomes its content words", () => {
  const terms = textTerms(ISSUE_TITLE);
  assert.deepEqual(terms, ["four", "files", "import", "confluence", "evidence", "modules", "grep", "bootstrap", "claude", "codex"]);
  const cql = textCql("KB", terms);
  assert.equal(cql, ISSUE_CQL);
  assert.equal(/[(),]/.test(cql!.split("text ~ ")[1]), false);
});

test("tilde and parentheses leave the value", () => {
  const terms = textTerms("Why text ~ (fuzzy) search roams~");
  assert.deepEqual(terms, ["text", "fuzzy", "search", "roams"]);
  assert.doesNotMatch(valueOf(textCql("KB", terms)!), /[~()]/);
});

test("quotes: exactly the two delimiting quotes remain", () => {
  const cql = textCql("KB", textTerms('A "quoted" title'))!;
  assert.equal(valueOf(cql), "quoted title");
  assert.equal(cql.split("text ~ ")[1], '"quoted title"');
});

test("a backslash and a colon never reach the value", () => {
  const value = valueOf(textCql("KB", textTerms("Path C:\\Users\\name and\\or"))!);
  assert.doesNotMatch(value, /[\\:]/);
});

test("every Lucene special character is removed, every real word kept", () => {
  const title = 'alpha + beta - gamma && delta || eps ! (zeta) {eta} [theta] ^ iota " kappa ~ lambda * mu ? nu : xi \\ omicron / pi';
  const value = valueOf(textCql("KB", textTerms(title))!);
  assert.match(value, /^[a-z0-9 ]+$/);
  for (const word of ["alpha", "beta", "gamma", "delta", "zeta", "theta", "iota", "kappa", "lambda", "omicron"]) {
    assert.ok(value.split(" ").includes(word), word);
  }
});

test("reserved words are lowercased, so Lucene reads them as terms, not operators", () => {
  // It is the lowercasing, not the stop list, that neutralises the keywords:
  // an all-caps NOT, AND, OR passes contentTerms as an acronym. Lucene's
  // Boolean operators "must be ALL CAPS", so a lowercase one is a plain term.
  assert.deepEqual(textTerms("NOT AND OR this"), ["not", "and", "or"]);
  assert.deepEqual(textTerms("Build AND release"), ["build", "and", "release"]);
  for (const title of ["NOT AND OR this", "Build AND release"]) {
    assert.match(valueOf(textCql("KB", textTerms(title))!), /^[a-z0-9 ]+$/);
  }
});

test("dotted and hyphenated identifiers split into their words", () => {
  assert.deepEqual(textTerms("node.js vite-plugin OSGi"), ["node", "js", "vite", "plugin", "osgi"]);
});

test("a repeated word is searched once", () => {
  assert.deepEqual(textTerms("modules (grep over modules)"), ["modules", "grep"]);
});

test("a title with no searchable word sends no request", async () => {
  for (const title of ["(((~~~)))", "The and of it", ""]) {
    assert.deepEqual(textTerms(title), [], title);
    assert.equal(textCql("KB", textTerms(title)), null, title);
    const { session, specs } = recorder();
    assert.deepEqual(await textSearch(session, "KB", title), { titles: [], cql: null });
    assert.equal(specs.length, 0, `no request for ${JSON.stringify(title)}`);
  }
});

test("non-ASCII letters split words as contentTerms does, and none reaches the CQL", () => {
  // Pinned pre-existing contentTerms behaviour in an English-only space: a
  // change here has to be deliberate.
  assert.deepEqual(textTerms("Café Zürich naming überblick"), ["rich", "naming", "berblick"]);
  assert.deepEqual(textTerms("Überblick Zürich"), ["berblick", "rich"]);
  const cql = textCql("KB", textTerms("Café Zürich naming überblick"))!;
  assert.equal(/[^\x00-\x7f]/.test(cql), false);
  assert.match(valueOf(cql), /^[a-z0-9 ]+$/);
});

test("textSearch passes the limit through", async () => {
  const { session, specs } = recorder();
  await textSearch(session, "KB", "alpha beta", 5);
  assert.match(specs[0].path, /&limit=5$/);
});

test("HTTP 400 resolves to an UNKNOWN half with the documented meaning and Atlassian's message", async () => {
  const hits = await textSearch(refusing(400, { message: "Could not parse cql" }), "KB", "alpha beta");
  const cql = 'space="KB" and type=page and text ~ "alpha beta"';
  assert.deepEqual(hits, { titles: [], cql, failure: { kind: "http", status: 400, detail: "Could not parse cql" } });
  assert.equal(textFailureLine(hits),
    `exact-term search: HTTP 400 (the CQL query cannot be parsed) - Could not parse cql. Hits from this half are UNKNOWN. cql: ${cql}`);
});

test("HTTP 403 names the status and the CQL, never a scope", async () => {
  const hits = await textSearch(refusing(403), "KB", "alpha beta");
  assert.deepEqual(hits.failure, { kind: "http", status: 403, detail: "" });
  const line = textFailureLine(hits);
  assert.equal(line, 'exact-term search: HTTP 403. Hits from this half are UNKNOWN. cql: space="KB" and type=page and text ~ "alpha beta"');
  assert.doesNotMatch(line, /scope/i);
});

test("HTTP 500 with a v2-shaped body carries the error title as detail", async () => {
  const hits = await textSearch(refusing(500, { errors: [{ title: "Internal error" }] }), "KB", "alpha beta");
  assert.deepEqual(hits.failure, { kind: "http", status: 500, detail: "Internal error" });
});

test("a malformed response still rejects: the error path is for request failures only", async () => {
  // A structural failure is not an unreadable row: it still throws (issue #656 keeps this boundary).
  for (const body of [{ results: "nope" }, { results: [null] }, { results: [1] }, { results: [[]] }, null, {}]) {
    const session: ConfluenceSession = { async request() { return { status: 200, json: body }; } };
    await assert.rejects(() => textSearch(session, "KB", "alpha beta"), /malformed-response/, JSON.stringify(body));
  }
});

// Issue #656. A row with no readable title in either documented place
// (content.title, title) is counted, never dropped: the half is then
// incomplete, which is UNKNOWN, not zero. No HTTP status is invented for it.
const ALPHA_CQL = 'space="KB" and type=page and text ~ "alpha beta"';
const search = (results: unknown[]) => textSearch(recorder([{ results }]).session, "KB", "alpha beta");

test("an all-unreadable response is an incomplete half with no invented status", async () => {
  const hits = await search([{}]);
  assert.deepEqual(hits, { titles: [], cql: ALPHA_CQL, failure: { kind: "rows", unreadable: 1, rows: 1 } });
  const line = textFailureLine(hits);
  assert.equal(line,
    `exact-term search: 1 of 1 result row(s) had no readable title. Hits from this half are incomplete and UNKNOWN. cql: ${ALPHA_CQL}`);
  assert.doesNotMatch(line, /HTTP/);
  assert.equal("status" in hits.failure!, false);
});

test("one unreadable row counts once, whichever field is bad", async () => {
  const rows = [
    { title: 7 }, { title: null }, { title: true }, { title: {} }, { title: [] }, { title: "" }, { title: "   " },
    { content: { title: 7 } }, { content: { title: "  " } }, { content: {} },
    { content: { title: " " }, title: "" }, { content: { title: 3 }, title: false },
  ];
  for (const row of rows) {
    const hits = await search([row]);
    assert.deepEqual(hits.titles, [], JSON.stringify(row));
    assert.deepEqual(hits.failure, { kind: "rows", unreadable: 1, rows: 1 }, JSON.stringify(row));
  }
});

test("the flat title keeps a row readable when the nested one is not", async () => {
  const cases: [unknown, string][] = [
    [{ content: { title: "   " }, title: "Flat" }, "Flat"],
    [{ content: { title: 5 }, title: "Flat" }, "Flat"],
    [{ content: { title: "" }, title: "Flat" }, "Flat"],
    [{ content: { title: "Nested" }, title: "Flat" }, "Nested"],
    [{ content: { title: "Nested" }, title: 9 }, "Nested"],
    [{ title: "  Padded  " }, "  Padded  "],
  ];
  for (const [row, title] of cases) {
    assert.deepEqual(await search([row]), { titles: [title], cql: ALPHA_CQL }, JSON.stringify(row));
  }
});

test("a mixed response keeps the readable titles and counts the rest", async () => {
  const hits = await search([{ content: { title: "A" } }, {}, { title: "B" }, { title: "  " }]);
  assert.deepEqual(hits.titles, ["A", "B"]);
  assert.deepEqual(hits.failure, { kind: "rows", unreadable: 2, rows: 4 });
  assert.ok(textFailureLine(hits).startsWith("exact-term search: 2 of 4 result row(s) had no readable title."));
});

test("a searched-empty or fully readable response is not unreadable", async () => {
  assert.deepEqual(await search([]), { titles: [], cql: ALPHA_CQL });
  assert.deepEqual(await search([{ title: "X" }]), { titles: ["X"], cql: ALPHA_CQL });
});

test("requestError carries Atlassian's body message as detail and keeps its message", () => {
  const spec = { method: "GET", path: "/wiki/rest/api/search", scope: SCOPES.get };
  const forbidden = requestError(spec, 403, { message: "x" });
  assert.equal(forbidden.detail, "x");
  assert.equal(forbidden.message, "HTTP 403 on GET /wiki/rest/api/search: the service account is missing the scope read:page:confluence - x");
  assert.equal(requestError(spec, 400, { message: "bad" }).detail, "bad");
  assert.equal(requestError(spec, 413, { errors: [{ detail: "big" }] }).detail, "big");
  assert.equal(requestError(spec, 500, {}).detail, "");
});

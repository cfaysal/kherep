import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_RESULTS, boundedMaxResults, readPage, searchFields, searchPath,
} from "./jira-search.mts";

function parsed(path: string): URLSearchParams {
  const [route, query] = path.split("?");
  assert.equal(route, "/search/jql");
  return new URLSearchParams(query);
}

test("the path targets the supported route, not the deprecated one", () => {
  const path = searchPath({ jql: "project = OP" });
  assert.ok(path.startsWith("/search/jql?"), path);
  assert.ok(!path.startsWith("/search?"), path);
});

test("the jql is carried verbatim and the defaults come from the spec", () => {
  const query = parsed(searchPath({ jql: "project = OP AND status != Done" }));
  assert.equal(query.get("jql"), "project = OP AND status != Done");
  assert.equal(query.get("maxResults"), String(DEFAULT_MAX_RESULTS));
  assert.equal(query.get("fields"), "summary,status,updated");
  assert.equal(query.get("nextPageToken"), null);
});

test("fields are sent as one comma-separated value, as the spec requires", () => {
  const query = parsed(searchPath({ jql: "project = OP", fields: ["summary", "assignee"] }));
  assert.equal(query.get("fields"), "summary,assignee");
  assert.deepEqual(query.getAll("fields"), ["summary,assignee"]);
});

test("a continuation token is only sent when there is one", () => {
  assert.equal(parsed(searchPath({ jql: "x = 1", nextPageToken: "abc" })).get("nextPageToken"), "abc");
  assert.equal(parsed(searchPath({ jql: "x = 1", nextPageToken: "" })).get("nextPageToken"), null);
});

test("an empty jql is refused rather than sent as a site-wide query", () => {
  assert.throws(() => searchPath({ jql: "   " }), /--jql/);
});

test("maxResults falls back to the spec default for anything that is not a positive integer", () => {
  assert.equal(boundedMaxResults(undefined), DEFAULT_MAX_RESULTS);
  assert.equal(boundedMaxResults(""), DEFAULT_MAX_RESULTS);
  assert.equal(boundedMaxResults("0"), DEFAULT_MAX_RESULTS);
  assert.equal(boundedMaxResults("-5"), DEFAULT_MAX_RESULTS);
  assert.equal(boundedMaxResults("2.5"), DEFAULT_MAX_RESULTS);
  assert.equal(boundedMaxResults("abc"), DEFAULT_MAX_RESULTS);
  assert.equal(boundedMaxResults("7"), 7);
  assert.equal(boundedMaxResults(114), 114);
});

test("an absent or empty field list keeps the defaults", () => {
  assert.deepEqual(searchFields(undefined), ["summary", "status", "updated"]);
  assert.deepEqual(searchFields(""), ["summary", "status", "updated"]);
  assert.deepEqual(searchFields("summary, assignee"), ["summary", "assignee"]);
});

test("hits are read out of the documented response shape", () => {
  const page = readPage({
    isLast: false,
    nextPageToken: "tok-2",
    issues: [
      { key: "OP-1", fields: { summary: "Erster", status: { name: "In Progress" }, updated: "2026-09-17T10:00:00.000+0200" } },
      { key: "OP-2", fields: { summary: "Zweiter", status: { name: "To Do" }, updated: "2026-09-16T10:00:00.000+0200" } },
    ],
    warnings: ["clause limit reached"],
  });
  assert.equal(page.hits.length, 2);
  assert.deepEqual(page.hits[0], {
    key: "OP-1", status: "In Progress", summary: "Erster", updated: "2026-09-17T10:00:00.000+0200",
  });
  assert.equal(page.nextPageToken, "tok-2");
  assert.equal(page.isLast, false);
  assert.deepEqual(page.warnings, ["clause limit reached"]);
});

test("a missing token marks the last page, because the spec omits it there", () => {
  const page = readPage({ issues: [{ key: "OP-9", fields: { summary: "Letzter" } }] });
  assert.equal(page.nextPageToken, null);
  assert.equal(page.isLast, true);
  assert.equal(page.hits[0]?.status, "");
});

test("a malformed or empty body yields no hits instead of throwing", () => {
  for (const body of [undefined, null, "nope", [], {}, { issues: "nope" }, { issues: [null, 7] }]) {
    const page = readPage(body);
    assert.deepEqual(page.hits, []);
    assert.equal(page.nextPageToken, null);
  }
});

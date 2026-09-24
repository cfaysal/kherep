// Tests for the neighbour finder. The interesting assertions are the ones about
// what it REFUSES: a filter that never rejects anything is a filter that turns
// every page into everybody's neighbour, which is the same as having none.
import assert from "node:assert/strict";
import test from "node:test";

import { SCOPES, type ConfluenceSession, type RequestSpec } from "./confluence-contract.mts";
import {
  contentTerms,
  danglingAnchors,
  neighbourhood,
  outgoingIds,
  requireResolvableAnchors,
  selectRelated,
  spaceIndex,
  textSearch,
  type SpaceIndex,
} from "./confluence-related.mts";
import {
  existingRelated,
  relatedSection,
  withRelated,
  RELATED_HEADING,
} from "./confluence-neighbours.mts";

function recorder(bodies: unknown[] = []) {
  const specs: RequestSpec[] = [];
  const session: ConfluenceSession = {
    async request(spec) {
      specs.push(spec);
      return { status: 200, json: bodies[specs.length - 1] ?? {} };
    },
  };
  return { session, specs };
}

function page(id: string, title: string, parentId: string | null = "node") {
  return { id, title, parentId };
}

function indexOf(...pages: { id: string; title: string; parentId: string | null }[]): SpaceIndex {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const byTitle = new Map(pages.map((p) => [p.title.toLowerCase(), p]));
  const parents = new Set(pages.map((p) => p.parentId).filter((x): x is string => Boolean(x)));
  return { byId, byTitle, parents };
}

test("contentTerms keeps acronyms that a length rule would throw away", () => {
  const terms = contentTerms("JSM Assets AQL: total Field Capped at 1000");
  assert.ok(terms.has("jsm"), "JSM is three letters and the most distinctive token here");
  assert.ok(terms.has("aql"));
  assert.ok(terms.has("assets"));
  assert.ok(!terms.has("at"), "stop words carry no meaning on their own");
});

test("contentTerms drops stop words but keeps dotted and hyphenated identifiers", () => {
  const terms = contentTerms("The node.js and the vite-plugin for a build");
  assert.ok(terms.has("node.js"));
  assert.ok(terms.has("vite-plugin"));
  assert.ok(!terms.has("the"));
  assert.ok(!terms.has("and"));
  assert.ok(!terms.has("for"));
});

test("selectRelated keeps a proposal that shares a word and reports why", () => {
  const index = indexOf(page("node", "Development", null), page("1", "Forge Queue Payload Limit"));
  const out = selectRelated(index, { title: "Forge Bulk Operation Pattern" }, ["Forge Queue Payload Limit"]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "1");
  assert.equal(out[0].reason, "term");
});

test("selectRelated drops a proposal that is not a page in this space", () => {
  const index = indexOf(page("1", "Forge Queue Payload Limit"));
  const out = selectRelated(index, { title: "Forge Bulk Operation Pattern" }, ["Some Page On Another Site"]);
  assert.deepEqual(out, [], "the index IS the space filter - the semantic side has none");
});

test("selectRelated drops a structure node even when the words match", () => {
  // "Development" is somebody's parent, so it is a shelf. It shares no word here;
  // the page that does share one is the shelf itself in the second case.
  const index = indexOf(page("node", "Forge Apps", null), page("1", "Forge Bridge Errors", "node"));
  const out = selectRelated(index, { title: "Forge Bulk Operation Pattern" }, ["Forge Apps", "Forge Bridge Errors"]);
  assert.deepEqual(out.map((p) => p.id), ["1"]);
});

test("selectRelated never returns the source page itself", () => {
  const index = indexOf(page("node", "General", null), page("7", "Forge Bulk Operation Pattern"));
  const out = selectRelated(index, { title: "Forge Bulk Operation Pattern", id: "7" }, ["Forge Bulk Operation Pattern"]);
  assert.deepEqual(out, []);
});

test("selectRelated accepts a sibling without a shared word and marks it as structural", () => {
  const index = indexOf(page("node", "Pinokio", null), page("2", "Runtime Control Reference", "node"));
  const out = selectRelated(index, { title: "Setup Walkthrough", parentId: "node" }, ["Runtime Control Reference"]);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, "sibling", "the hierarchy says what a page is about");
});

test("selectRelated rejects an unrelated page under a different node", () => {
  const index = indexOf(page("a", "Operations", null), page("b", "Kherep", null), page("9", "Kubernetes Inode Exhaustion", "a"));
  const out = selectRelated(index, { title: "Pinokio Runtime Control Reference", parentId: "b" }, ["Kubernetes Inode Exhaustion"]);
  assert.deepEqual(out, [], "this is exactly the repeat stranger the semantic side keeps offering");
});

test("selectRelated preserves proposal order, deduplicates and honours the cap", () => {
  const index = indexOf(
    page("root", "Atlassian", null),
    page("1", "Jira REST API Patterns"),
    page("2", "Jira Issue Picker Field"),
    page("3", "Jira Search JQL Token"),
    page("4", "Jira Field Metadata"),
  );
  const out = selectRelated(
    index,
    { title: "Jira Cloud v3 Textarea Custom Field" },
    ["Jira REST API Patterns", "Jira Issue Picker Field", "Jira REST API Patterns", "Jira Search JQL Token", "Jira Field Metadata"],
    3,
  );
  assert.deepEqual(out.map((p) => p.id), ["1", "2", "3"]);
});

test("selectRelated returns an empty list rather than a filler for an isolated page", () => {
  const index = indexOf(page("root", "Operations", null), page("1", "KVM Guest Shutdown Host Usage"));
  const out = selectRelated(index, { title: "Social Media Content Knowledge Base" }, ["KVM Guest Shutdown Host Usage"]);
  assert.deepEqual(out, [], "no neighbour is a result; an invented one is a lie");
});

test("spaceIndex follows the cursor and collects the parent set", async () => {
  const { session, specs } = recorder([
    {
      results: [
        { id: "10", title: "Development", parentId: null },
        { id: "11", title: "General", parentId: "10" },
      ],
      _links: { next: "/api/v2/spaces/1/pages?cursor=second" },
    },
    { results: [{ id: "12", title: "A Leaf", parentId: "11" }], _links: {} },
  ]);
  const index = await spaceIndex(session, "1");
  assert.equal(specs.length, 2);
  assert.equal(specs[0].scope, SCOPES.get);
  assert.equal(specs[1].path, "/wiki/api/v2/spaces/1/pages?cursor=second", "a bare cursor link gets the /wiki prefix");
  assert.equal(index.byId.size, 3);
  assert.deepEqual([...index.parents].sort(), ["10", "11"]);
  assert.equal(index.byTitle.get("a leaf")?.id, "12");
});

test("spaceIndex stops on a cursor that returns nothing instead of looping", async () => {
  const { session, specs } = recorder([
    { results: [], _links: { next: "/api/v2/spaces/1/pages?cursor=forever" } },
  ]);
  const index = await spaceIndex(session, "1");
  assert.equal(specs.length, 1, "an empty page ends the walk - this shape hung two runs for two hours");
  assert.equal(index.byId.size, 0);
});

test("textSearch scopes the CQL to the space and reads both result shapes", async () => {
  const { session, specs } = recorder([
    { results: [{ content: { title: "Wrapped In Content" } }, { title: "Flat Title" }, { title: "" }] },
  ]);
  const titles = await textSearch(session, "KB", 'quotes "inside"', 5);
  assert.deepEqual(titles, ["Wrapped In Content", "Flat Title"]);
  const query = decodeURIComponent(specs[0].path.split("cql=")[1].split("&")[0]);
  assert.equal(query, 'space="KB" and type=page and text ~ "quotes \\"inside\\""');
  assert.equal(specs[0].scope, SCOPES.get);
});

test("outgoingIds reads the legacy viewpage href as well as the space-relative one", () => {
  const storage = '<a href="/wiki/pages/viewpage.action?pageId=555">legacy</a>'
    + ' <a href="/wiki/spaces/KB/pages/666">modern</a>'
    + ' <a href="/wiki/pages/viewpage.action?pageId=555">the same one again</a>';
  assert.deepEqual(outgoingIds(storage).sort(), ["555", "666"], "one shape is not all the links there are");
});

test("outgoingIds finds every distinct page link in storage and ignores the rest", () => {
  const storage = '<a href="/wiki/spaces/KB/pages/111">a</a> <a href="/wiki/spaces/KB/pages/111">again</a>'
    + ' <a href="/wiki/spaces/OTHER/pages/222">b</a> <a href="https://example.com/x">c</a>';
  assert.deepEqual(outgoingIds(storage), ["111", "222"]);
});

test("neighbourhood reports parent, siblings and only the links that resolve in this space", () => {
  const index = indexOf(
    page("node", "General", null),
    page("1", "Source", "node"),
    page("2", "Sibling", "node"),
    page("3", "Elsewhere", "other"),
  );
  const storage = '<a href="/wiki/spaces/KB/pages/3">x</a> <a href="/wiki/spaces/KB/pages/999">gone</a>'
    + ' <a href="/wiki/spaces/KB/pages/1">self</a>';
  const n = neighbourhood(index, "1", storage);
  assert.equal(n.parent?.title, "General");
  assert.deepEqual(n.siblings.map((p) => p.id), ["2"]);
  assert.deepEqual(n.outgoing.map((p) => p.id), ["3"], "a dead id and a self link are not neighbours");
});

test("neighbourhood refuses a page the index does not contain", () => {
  assert.throws(() => neighbourhood(indexOf(page("1", "Only", null)), "2", ""), /not in this space index/);
});

// --- the stitching block ---------------------------------------------------
// Everything here exists because the naive version of this feature appends a
// second list on every run and drops what the previous run wrote.

test("relatedSection builds one list of space-relative page links", () => {
  const section = relatedSection("KB", [{ id: "1", title: "First" }, { id: "2", title: "Second" }]);
  assert.equal(
    section,
    '<h2>Related pages</h2><ul><li><a href="/wiki/spaces/KB/pages/1">First</a></li>'
    + '<li><a href="/wiki/spaces/KB/pages/2">Second</a></li></ul>',
  );
});

test("withRelated appends the block when there is none", () => {
  const out = withRelated("<p>body</p>\n\n", relatedSection("KB", [{ id: "9", title: "N" }]));
  assert.ok(out.startsWith("<p>body</p>"));
  assert.equal(out.split(RELATED_HEADING).length - 1, 1);
});

test("withRelated replaces the block instead of adding a second one", () => {
  const first = withRelated("<p>body</p>", relatedSection("KB", [{ id: "1", title: "A" }]));
  const second = withRelated(first, relatedSection("KB", [{ id: "2", title: "B" }]));
  assert.equal(second.split(RELATED_HEADING).length - 1, 1, "running twice must not stack two blocks");
  assert.ok(second.includes("/pages/2"));
  assert.ok(!second.includes("/pages/1"));
  assert.ok(second.startsWith("<p>body</p>"));
});

test("existingRelated reads only the block, not the links in the page text", () => {
  const body = '<p>see <a href="/wiki/spaces/KB/pages/500">elsewhere</a></p>'
    + relatedSection("KB", [{ id: "1", title: "A" }, { id: "2", title: "B" }]);
  assert.deepEqual(existingRelated(body), ["1", "2"]);
  assert.deepEqual(existingRelated("<p>no block here</p>"), []);
});

test("existingRelated plus withRelated keeps what an earlier run wrote", () => {
  const before = withRelated("<p>body</p>", relatedSection("KB", [{ id: "1", title: "A" }]));
  const merged = [...new Set([...existingRelated(before), "2"])];
  const after = withRelated(before, relatedSection("KB", merged.map((id) => ({ id, title: id }))));
  assert.deepEqual(existingRelated(after), ["1", "2"], "a sweep that forgets the last sweep undoes it");
});

test("relatedSection escapes the title, because storage format is XHTML", () => {
  const section = relatedSection("KB", [{ id: "1", title: 'A & B <tag> "quoted"' }]);
  assert.ok(section.includes("A &amp; B &lt;tag&gt; &quot;quoted&quot;"));
  assert.ok(!section.includes("<tag>"), "an unescaped title decides what markup the page carries");
});

test("existingRelated still reads back an escaped block", () => {
  const body = withRelated("<p>x</p>", relatedSection("KB", [{ id: "7", title: "A & B" }]));
  assert.deepEqual(existingRelated(body), ["7"]);
});

// --- the anchor guard -------------------------------------------------------
// It exists because the instruction did not hold: on 2026-09-22 the observation
// agent named nine related pages and seven of them did not exist.

test("danglingAnchors makes no request for a body without links", async () => {
  const { session, specs } = recorder();
  assert.deepEqual(await danglingAnchors(session, "<p>plain text</p>", "42"), []);
  assert.equal(specs.length, 0, "the guard must be free on the bodies that do not need it");
});

test("danglingAnchors accepts a link to a page in this space", async () => {
  const { session, specs } = recorder([{ id: "1", spaceId: "42" }]);
  const body = '<a href="/wiki/spaces/KB/pages/1">ok</a>';
  assert.deepEqual(await danglingAnchors(session, body, "42"), []);
  assert.equal(specs[0].path, "/wiki/api/v2/pages/1");
  assert.equal(specs[0].scope, SCOPES.get);
});

test("danglingAnchors rejects a link to a page in another space", async () => {
  const { session } = recorder([{ id: "1", spaceId: "99" }]);
  const body = '<a href="/wiki/spaces/KB/pages/1">elsewhere</a>';
  assert.deepEqual(await danglingAnchors(session, body, "42"), [{ id: "1", reason: "page is in another space" }]);
});

test("danglingAnchors treats an unreadable target as absent and fails closed", async () => {
  const session: ConfluenceSession = { async request() { throw new Error("404"); } };
  const body = '<a href="/wiki/spaces/KB/pages/7">invented</a>';
  assert.deepEqual(await danglingAnchors(session, body, "42"), [{ id: "7", reason: "no such page" }]);
});

test("requireResolvableAnchors names every bad id and what to do instead", async () => {
  const session: ConfluenceSession = { async request() { throw new Error("404"); } };
  const body = '<a href="/wiki/spaces/KB/pages/7">a</a><a href="/wiki/spaces/KB/pages/8">b</a>';
  await assert.rejects(
    () => requireResolvableAnchors(session, body, "42"),
    (error: Error) => {
      assert.match(error.message, /2 page\(s\)/);
      assert.match(error.message, /\b7\b/);
      assert.match(error.message, /\b8\b/);
      assert.match(error.message, /write no link and say that none matched/);
      return true;
    },
  );
});

test("requireResolvableAnchors passes a body whose links all resolve here", async () => {
  const { session } = recorder([{ id: "1", spaceId: "42" }]);
  await requireResolvableAnchors(session, '<a href="/wiki/spaces/KB/pages/1">ok</a>', "42");
});

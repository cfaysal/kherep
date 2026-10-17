// Tests for the stitching run as a whole: what it links, and what it says about
// why. No network: the session answers from fixtures, and the run is a dry run.
import assert from "node:assert/strict";
import test from "node:test";

import type { ConfluenceSession } from "./confluence-contract.mts";
import { reportStitch, type NeighbourDeps } from "./confluence-neighbours.mts";

const PAGES = [
  { id: "node", title: "Acme", parentId: null },
  { id: "src", title: "Acme brand banner: visual identity and color palette", parentId: "node" },
  { id: "1", title: "macOS product-node daemon launchd agent configuration", parentId: "node" },
  { id: "2", title: "Acme architecture: governance layer, not agent harness", parentId: "node" },
  { id: "3", title: "Acme color palette tokens", parentId: "node" },
  { id: "4", title: "Acme installer backup rotation", parentId: "node" },
];

function deps(log: string[]): NeighbourDeps {
  const session: ConfluenceSession = {
    async request(spec) {
      if (spec.path.includes("/spaces/")) return { status: 200, json: { results: PAGES, _links: {} } };
      if (spec.path.includes("/search")) return { status: 200, json: { results: [] } };
      return { status: 200, json: { body: { storage: { value: "<p>body</p>" } } } };
    },
  };
  return {
    session,
    spaceId: "42",
    spaceKey: "KB",
    log: (line) => log.push(line),
    logError: (line) => log.push(`error: ${line}`),
    semantic: async () => ({ titles: PAGES.slice(1).map((p) => p.title) }),
    update: async () => { throw new Error("a dry run must not write"); },
  };
}

test("reportStitch links only on a distinctive word and logs the reason per link", async () => {
  const log: string[] = [];
  const code = await reportStitch(deps(log), { only: "src", perOrphan: 3, dryRun: true });
  assert.equal(code, 0);
  const links = log.filter((line) => line.startsWith("link\t"));
  assert.deepEqual(links, ["link\t3\tsrc\tterm=color,palette\tsibling"],
    "the sibling with no shared word and the page sharing only the product name are not linked");
  assert.ok(log.includes("pages that would be written: 1"));
});

// Issue #479. Two real runs against one in-memory page store. The store hands
// a written body back the way Confluence may re-serialize it (here: a list item
// wrapped in a paragraph), so the bytes read back are not the bytes written.
// "Already linked" has to survive that, for a sibling neighbour as for any.
const SIBLINGS = [
  { id: "node", title: "Acme", parentId: null },
  { id: "101", title: "Broker output differs between hosts", parentId: "node" },
  { id: "102", title: "Why the runtime label differs", parentId: "node" },
  { id: "103", title: "Release checklist", parentId: null },
];

function store(reserialize: (storage: string) => string) {
  const bodies = new Map([["101", "<p>o</p>"], ["102", "<p>n</p>"], ["103", "<p>m</p>"]]);
  const writes: string[] = [];
  const session: ConfluenceSession = {
    async request(spec) {
      if (spec.path.includes("/spaces/")) return { status: 200, json: { results: SIBLINGS, _links: {} } };
      if (spec.path.includes("/search")) return { status: 200, json: { results: [] } };
      const id = /\/pages\/([^/?]+)/.exec(spec.path)?.[1] ?? "";
      return { status: 200, json: { body: { storage: { value: bodies.get(id) ?? "" } } } };
    },
  };
  const log: string[] = [];
  const run: NeighbourDeps = {
    session, spaceId: "42", spaceKey: "KB",
    log: (line) => log.push(line),
    logError: (line) => log.push(`error: ${line}`),
    semantic: async () => ({ titles: SIBLINGS.map((p) => p.title) }),
    update: async (id, storage) => { writes.push(id); bodies.set(id, reserialize(storage)); },
  };
  return { run, writes, log, bodies };
}

const wrapItems = (storage: string) => storage.replace(/<li>(.*?)<\/li>/g, "<li><p>$1</p></li>");

for (const [name, reserialize] of [["verbatim", (s: string) => s], ["re-serialized", wrapItems]] as const) {
  test(`a second stitch of the same orphan writes nothing (${name} store, sibling neighbour)`, async () => {
    const { run, writes, log } = store(reserialize);
    assert.equal(await reportStitch(run, { only: "101", perOrphan: 3 }), 0);
    assert.ok(log.includes("link\t102\t101\tterm=differs\tsibling"), "the neighbour is a sibling");
    assert.deepEqual(writes, ["102"]);

    log.length = 0;
    assert.equal(await reportStitch(run, { only: "101", perOrphan: 3 }), 0);
    assert.deepEqual(writes, ["102"], "the second run must not write the link again");
    assert.ok(log.includes("pages written: 0"));
    assert.ok(log.includes("unchanged: 1"));
  });
}

test("a block that already exists still takes a new orphan", async () => {
  const { run, writes, bodies } = store(wrapItems);
  bodies.set("102", '<p>n</p><h2>Related pages</h2><ul><li><p><a href="/wiki/spaces/KB/pages/103">Release checklist</a></p></li></ul>');
  await reportStitch(run, { only: "101", perOrphan: 3 });
  assert.deepEqual(writes, ["102"]);
  assert.match(bodies.get("102") ?? "", /pages\/103".*pages\/101"/, "the earlier link is kept and the orphan added");
});

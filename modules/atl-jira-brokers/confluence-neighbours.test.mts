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

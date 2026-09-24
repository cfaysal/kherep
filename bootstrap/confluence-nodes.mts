/**
 * The placement map: the hierarchy nodes ROUTING.md prescribes, resolved to the
 * page ids they carry in THIS host's knowledge space.
 *
 * Why it exists. The observation agent has been told to pass
 * `--parent <the node the page belongs under>`, and nothing on a host could
 * turn such a NAME into the id that flag wants. Measured on 2026-09-22: ten
 * observation pages written that day landed as direct children of the space
 * home page, siblings of the hierarchy instead of inside it. The instruction
 * was there, the mapping was not.
 *
 * The node names live here as a list rather than being parsed out of ROUTING.md
 * at runtime - prose is a poor parser input - and a test binds the two, so the
 * list cannot drift away from the rule it implements.
 *
 * Nothing here creates a node and nothing here guesses an id. A name that does
 * not resolve comes back AS A NAME, so the setup step can report it and the
 * agent can refuse to place a page rather than invent a parent.
 */
import { readFile as nodeReadFile } from "node:fs/promises";

import { spaceIndex, type IndexedPage } from "../modules/atl-jira-brokers/confluence-related.mts";
import { createSession, type ConfluenceContext } from "../modules/atl-jira-brokers/confluence-session.mts";

// The hierarchy of claude/teams/kherep/ROUTING.md, with the shelves the leaf
// paths hang from. The `<App>` level is deliberately absent: an app node
// appears without the space being reconfigured, so it is resolved live from the
// mapped shelf's children instead of being frozen into a per-host file.
export const PLACEMENT_NODES = [
  "Atlassian",
  "Development",
  "Development/DC Apps",
  "Development/Forge Apps",
  "Development/General",
  "Kherep",
  "Operations",
] as const;

export interface Placement {
  /** Node path -> page id, for the nodes that actually resolved. */
  nodes: Record<string, string>;
  /** Every prescribed node that did not, by name. Never an id, never a guess. */
  missing: string[];
}

function sameTitle(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// One segment at a time: the first anywhere in the space, every later one only
// among the children of the segment before it. That is what makes this a PATH
// rather than a title match - "General" exists in more than one hierarchy the
// moment a second shelf grows one.
//
// Two candidates are as unresolvable as none. Picking either would be a guess,
// and a guess here files knowledge under the wrong branch without anything
// failing.
function resolveOne(pages: readonly IndexedPage[], node: string): string | null {
  const segments = node.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return null;
  let scope: readonly IndexedPage[] = pages;
  let id: string | null = null;
  for (const segment of segments) {
    const hits = scope.filter((page) => sameTitle(page.title, segment));
    if (hits.length !== 1) return null;
    id = hits[0].id;
    scope = pages.filter((page) => page.parentId === id);
  }
  return id;
}

// Pure over an already-read space, so every case below can be checked without a
// credential, a network or a live space.
export function resolvePlacement(
  pages: readonly IndexedPage[],
  nodes: readonly string[] = PLACEMENT_NODES,
): Placement {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const node of nodes) {
    const id = resolveOne(pages, node);
    if (id) resolved[node] = id;
    else missing.push(node);
  }
  return { nodes: resolved, missing };
}

// The persisted shape. spaceKey, spaceId and spaceName keep their names and
// their place because the observation agents and bootstrap/orphan-check.sh read
// them; `nodes` is added beside them, not in place of anything.
export function spaceFile(
  space: { key: string; id: string; name: string },
  nodes: Record<string, string>,
): string {
  return `${JSON.stringify({
    spaceKey: space.key, spaceId: space.id, spaceName: space.name, nodes,
  }, null, 2)}\n`;
}

/**
 * The read half. It goes through the BROKER's own transport under the service
 * account - the same modules, the same credential variable, one authenticated
 * pass over the space - for the reason bootstrap/confluence-space.mts spells
 * out beside its own broker call: a space the operator's personal account can
 * read is not a space the account that writes every observation can read.
 *
 * One pass rather than a subprocess per node: the whole space arrives as
 * (id, title, parentId) rows, which is exactly what a path needs, and the
 * hierarchy is then resolved without asking the site again.
 */
export async function readSpacePages(credEnv: string, spaceId: string): Promise<IndexedPage[]> {
  const ctx: ConfluenceContext = {
    env: process.env,
    credEnv,
    readFile: nodeReadFile,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    // Fresh per call, like every CLI builds it. Never at module scope.
    session: {},
  };
  return [...(await spaceIndex(createSession(ctx), spaceId)).byId.values()];
}

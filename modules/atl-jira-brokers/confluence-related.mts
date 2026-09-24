// Finds the pages a new page belongs next to, so that writing one does not
// silently produce another page nobody links to.
//
// Two signals, because neither is sufficient alone and they fail differently.
// Both were measured on 2026-09-22 against five pages in the live space that
// had no incoming link:
//
//   - CQL full text does not rank. The AND form returned nothing in three of
//     the five cases; the OR form returned the same unrelated pages for
//     completely different sources. On its own it is a keyword filter wearing
//     the word "search", not a neighbourhood signal.
//   - The semantic search does rank. It paired the two Pinokio pages with each
//     other and found four true Jira neighbours for a Jira page. But it has no
//     space filter, it returns no score, and it offers structure nodes and the
//     same handful of strangers over and over.
//
// So the semantic side proposes and a mechanical side disposes. A proposal has
// to be a page in THIS space, it has to be a leaf rather than a shelf, and it
// has to share a content word with the source title or sit under the same node.
// An unrankable signal plus an exact one beats either alone.
import { ConfluenceError, SCOPES, v1, v2, type ConfluenceSession } from "./confluence-contract.mts";

export interface IndexedPage {
  id: string;
  title: string;
  parentId: string | null;
}

export interface SpaceIndex {
  byId: Map<string, IndexedPage>;
  // Lowercased title. Titles are unique per space here, by construction: the
  // carry-over resolved collisions by qualifying with the parent segment.
  byTitle: Map<string, IndexedPage>;
  // Every page that is somebody's parent. In this deliberately flat hierarchy a
  // page with children is a shelf, not a book - so this set IS the structure,
  // derived from the live space instead of copied into a constant that rots.
  parents: Set<string>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rowsOf(json: unknown): Record<string, unknown>[] {
  const results = (json as { results?: unknown })?.results;
  return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
}

// Reads the whole space in one paginated pass. One request per 250 pages beats
// two requests per candidate, and the parent set falls out for free.
export async function spaceIndex(session: ConfluenceSession, spaceId: string): Promise<SpaceIndex> {
  const byId = new Map<string, IndexedPage>();
  const byTitle = new Map<string, IndexedPage>();
  const parents = new Set<string>();

  let path: string | null = v2(`/spaces/${spaceId}/pages?limit=250&status=current`);
  while (path) {
    const { json } = await session.request({ method: "GET", path, scope: SCOPES.get });
    const rows = rowsOf(json);
    for (const row of rows) {
      const id = text(row.id);
      if (!id) continue;
      const parentId = text(row.parentId) || null;
      const page: IndexedPage = { id, title: text(row.title), parentId };
      byId.set(id, page);
      if (page.title) byTitle.set(page.title.toLowerCase(), page);
      if (parentId) parents.add(parentId);
    }
    const next = (json as { _links?: { next?: unknown } })?._links?.next;
    const link = typeof next === "string" ? next : "";
    // Only follow a cursor that actually advanced. A link that returns the same
    // page forever is the shape that hung two runs on 2026-09-21 for two hours.
    path = link && rows.length ? (link.startsWith("/wiki") ? link : `/wiki${link}`) : null;
  }
  return { byId, byTitle, parents };
}

// English only: everything in this space is written in English by convention.
const STOP = new Set(
  ("the a an and or of for in on to with without from by is are was were be being been not no this that these" +
    " those it its as at into over under via when then than which who whom whose how why what does do did done" +
    " has have had can could should would will shall may might must about after before during between each" +
    " other more most only just also does per use used using")
    .split(" "),
);

// A token counts when it carries meaning on its own: a word of four or more
// letters, or an acronym. The acronyms are the point - AQL, JQL, CQL, JSM, OSGi
// are the most distinctive tokens in this corpus and a plain length rule throws
// exactly them away.
export function contentTerms(source: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(source).split(/[^A-Za-z0-9.+-]+/)) {
    const token = raw.replace(/^[.+-]+|[.+-]+$/g, "");
    if (!token) continue;
    const acronym = /^[A-Z][A-Z0-9]{1,}$/.test(token);
    const word = token.length >= 4 && !STOP.has(token.toLowerCase());
    if (acronym || word) out.add(token.toLowerCase());
  }
  return out;
}

export interface RelatedSource {
  title: string;
  // Present when the source page already exists. It is never its own neighbour.
  id?: string;
  // Present when the source already hangs somewhere. Siblings count as related
  // even without a shared word: the hierarchy says what a page is about.
  parentId?: string | null;
}

export interface Related extends IndexedPage {
  // Why this one survived. Carried with the result, not only logged, so a
  // caller can tell a topical hit from a structural one.
  reason: "term" | "sibling";
}

// Keeps the proposal order - that order is the only ranking the semantic side
// gives us - and drops everything the mechanical side cannot justify.
export function selectRelated(
  index: SpaceIndex,
  source: RelatedSource,
  proposals: string[],
  limit = 3,
): Related[] {
  const sourceTerms = contentTerms(source.title);
  const seen = new Set<string>();
  const out: Related[] = [];

  for (const proposal of proposals) {
    if (out.length >= limit) break;
    const hit = index.byTitle.get(String(proposal).trim().toLowerCase());
    if (!hit) continue;                       // not in this space
    if (hit.id === source.id) continue;       // not itself
    if (seen.has(hit.id)) continue;
    if (index.parents.has(hit.id)) continue;  // a shelf, not a book

    const sibling = Boolean(source.parentId) && hit.parentId === source.parentId;
    const shared = [...contentTerms(hit.title)].some((term) => sourceTerms.has(term));
    if (!sibling && !shared) continue;

    seen.add(hit.id);
    out.push({ ...hit, reason: shared ? "term" : "sibling" });
  }
  return out;
}

// The exact-term half. It hits rarely and precisely, which is the opposite
// failure mode to the semantic half - that is the entire reason to keep it.
export async function textSearch(
  session: ConfluenceSession,
  spaceKey: string,
  phrase: string,
  limit = 10,
): Promise<string[]> {
  const cql = `space=${JSON.stringify(spaceKey)} and type=page and text ~ ${JSON.stringify(phrase)}`;
  const path = v1(`/search?cql=${encodeURIComponent(cql)}&limit=${limit}`);
  const { json } = await session.request({ method: "GET", path, scope: SCOPES.get });
  return rowsOf(json)
    .map((row) => text((row.content as { title?: unknown } | undefined)?.title) || text(row.title))
    .filter(Boolean);
}

// The storage body, which getPage deliberately does not carry: a verb that
// prints a page has no business pulling a whole document down with it. Only the
// neighbourhood needs the body, and only to read the links out of it.
export async function pageStorage(session: ConfluenceSession, id: string): Promise<string> {
  const { json } = await session.request({
    method: "GET",
    path: v2(`/pages/${encodeURIComponent(id)}?body-format=storage`),
    scope: SCOPES.get,
  });
  const value = (json as { body?: { storage?: { value?: unknown } } })?.body?.storage?.value;
  return text(value);
}

export interface DanglingAnchor {
  id: string;
  reason: "no such page" | "page is in another space";
}

// Every page link in a body, checked against the site before the body is
// written. One lookup per anchor and none at all for a body without anchors,
// which is why this can sit in front of every write instead of only some.
//
// The rule it enforces cannot be enforced by asking: on 2026-09-22 the
// observation agent named nine related pages in its bodies and seven of them did
// not exist. It had read the instruction not to twice. A reference that points
// nowhere is worse than no reference, because it reads like a trail.
export async function danglingAnchors(
  session: ConfluenceSession,
  storage: string,
  spaceId: string,
): Promise<DanglingAnchor[]> {
  const out: DanglingAnchor[] = [];
  for (const id of outgoingIds(storage)) {
    let json: unknown;
    try {
      ({ json } = await session.request({
        method: "GET",
        path: v2(`/pages/${encodeURIComponent(id)}`),
        scope: SCOPES.get,
      }));
    } catch {
      // A page that cannot be read is not a page this body may point at. The
      // guard fails closed: an unreadable target and an absent one are the same
      // answer to the only question being asked.
      out.push({ id, reason: "no such page" });
      continue;
    }
    const where = text((json as { spaceId?: unknown })?.spaceId);
    if (where !== spaceId) out.push({ id, reason: "page is in another space" });
  }
  return out;
}

// Refuses the write rather than reporting afterwards. A body with an invented
// link must never reach the space: once it is there, nothing distinguishes it
// from a real trail except following it.
export async function requireResolvableAnchors(
  session: ConfluenceSession,
  storage: string,
  spaceId: string,
): Promise<void> {
  const bad = await danglingAnchors(session, storage, spaceId);
  if (!bad.length) return;
  const detail = bad.map((a) => `${a.id} (${a.reason})`).join(", ");
  throw new ConfluenceError(
    `The body links to ${bad.length} page(s) that this space does not hold: ${detail}. `
    + "Link only pages you have seen a search return, or write no link and say that none matched.",
  );
}

// The neighbourhood of a page: what it points at, what sits beside it. This is
// what a later context delivery traverses - knowing a page's neighbours is the
// difference between a search result and context.
export interface Neighbourhood {
  page: IndexedPage;
  parent: IndexedPage | null;
  siblings: IndexedPage[];
  outgoing: IndexedPage[];
}

// Confluence serves the same page under two href shapes and both occur in this
// space: the space-relative one that this code writes, and the legacy
// viewpage.action form that the editor and some agents produce. A parser that
// knows only one of them under-reports links silently - it reported four of
// nine observation pages as unlinked on 2026-09-22 when all nine carried
// anchors, and the write guard built on it would have waved those anchors
// through unchecked.
const PAGE_HREFS = [
  /\/wiki\/spaces\/[^/"'\s]+\/pages\/(\d+)/g,
  /\/wiki\/pages\/viewpage\.action\?pageId=(\d+)/g,
];

export function outgoingIds(storage: string): string[] {
  const out = new Set<string>();
  for (const pattern of PAGE_HREFS) {
    for (const match of String(storage).matchAll(pattern)) out.add(match[1]);
  }
  return [...out];
}

export function neighbourhood(index: SpaceIndex, id: string, storage: string): Neighbourhood {
  const page = index.byId.get(id);
  if (!page) throw new Error(`page ${id} is not in this space index`);
  const parent = page.parentId ? index.byId.get(page.parentId) ?? null : null;
  const siblings = page.parentId
    ? [...index.byId.values()].filter((p) => p.parentId === page.parentId && p.id !== id)
    : [];
  const outgoing = outgoingIds(storage)
    .map((linked) => index.byId.get(linked))
    .filter((p): p is IndexedPage => Boolean(p) && p!.id !== id);
  return { page, parent, siblings, outgoing };
}

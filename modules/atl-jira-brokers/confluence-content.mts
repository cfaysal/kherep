// The Confluence verbs, as pure functions over an injected session. No process,
// no argv, no env: everything that decides WHO is calling lives in
// confluence-session.mts, everything that decides WHAT is called lives here.
//
// Every endpoint below was verified against the Atlassian OpenAPI spec on
// 2026-09-21. The shapes are not to be "improved" from memory.
import {
  ConfluenceError,
  SCOPES,
  v1,
  v2,
  type ConfluenceSession,
} from "./confluence-contract.mts";

// There is no markdown representation in this API. A caller that asks for one
// gets a refusal, not a guess.
const FORMATS = { storage: "storage", wiki: "wiki", adf: "atlas_doc_format" } as const;

export type Format = keyof typeof FORMATS;
export type Representation = (typeof FORMATS)[Format];

export function representationFor(format: string | undefined): Representation {
  const wanted = (format ?? "").trim();
  if (!wanted) throw new ConfluenceError("--format is missing. Use storage, wiki or adf.");
  const mapped = FORMATS[wanted as Format];
  if (!mapped) {
    throw new ConfluenceError(
      `--format "${wanted}" is not a Confluence representation. Use storage, wiki or adf (atlas_doc_format).`,
    );
  }
  return mapped;
}

export interface Page {
  id: string;
  title: string;
  status: string;
  version: number;
  // The acceptance criterion of this broker: a page created through it must
  // read back with the SERVICE ACCOUNT here, not a personal account.
  authorId: string;
  spaceId: string;
  link: string;
}

export interface Space {
  id: string;
  key: string;
  name: string;
}

export interface Child {
  id: string;
  title: string;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : "";
}

function asPage(json: unknown): Page {
  const raw = (json ?? {}) as {
    id?: unknown; title?: unknown; status?: unknown; authorId?: unknown; spaceId?: unknown;
    version?: { number?: unknown }; _links?: { webui?: unknown };
  };
  return {
    id: text(raw.id),
    title: text(raw.title),
    status: text(raw.status),
    version: typeof raw.version?.number === "number" ? raw.version.number : 0,
    authorId: text(raw.authorId),
    spaceId: text(raw.spaceId),
    link: text(raw._links?.webui),
  };
}

function resultsOf(json: unknown): Record<string, unknown>[] {
  const raw = (json ?? {}) as { results?: unknown };
  if (!Array.isArray(raw.results)) return [];
  return raw.results.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

// Confluence content ids are numeric strings. Checked before the path is built,
// so a caller cannot walk out of the endpoint with a crafted id.
function contentId(id: string | undefined, flag: string): string {
  const value = (id ?? "").trim();
  if (!/^\d+$/.test(value)) throw new ConfluenceError(`${flag} must be a numeric Confluence id.`);
  return value;
}

function spaceKey(key: string | undefined): string {
  const value = (key ?? "").trim();
  if (!/^[A-Za-z0-9_~]+$/.test(value)) throw new ConfluenceError("--space must be a Confluence space key.");
  return value;
}

export interface CreateInput {
  spaceId: string;
  title: string;
  representation: Representation;
  value: string;
  parentId?: string;
}

// POST /wiki/api/v2/pages. Answers 200 with authorId, version.number and
// _links; 413 when the request exceeds 5 MB, which the transport surfaces as
// its own failure kind rather than as a permission problem.
export async function createPage(session: ConfluenceSession, input: CreateInput): Promise<Page> {
  const body: Record<string, unknown> = {
    spaceId: input.spaceId,
    status: "current",
    title: input.title,
    body: { representation: input.representation, value: input.value },
  };
  if (input.parentId) body.parentId = contentId(input.parentId, "--parent");
  const { json } = await session.request({ method: "POST", path: v2("/pages"), scope: SCOPES.create, body });
  return asPage(json);
}

// The status filter is not decoration. A trashed page answers 404 on the plain
// read, so a purge that first reads the page to confirm it IS trashed can never
// succeed - measured against the live API on 2026-09-21, not derived from the
// spec. The documented `status` query parameter is what makes a trashed page
// readable, and the guard that exists to prevent an accidental purge only works
// when it can see the state it is guarding against.
export async function getPage(
  session: ConfluenceSession,
  id: string,
  statuses?: readonly string[],
): Promise<Page> {
  const pageId = contentId(id, "--id");
  const filter = statuses?.length ? `?status=${statuses.map(encodeURIComponent).join("&status=")}` : "";
  const { json } = await session.request({
    method: "GET", path: v2(`/pages/${pageId}${filter}`), scope: SCOPES.get,
  });
  return asPage(json);
}

// GET /wiki/api/v2/pages/{id}?body-format=<representation> ("Get page by id",
// raw spec dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json, read
// 2026-09-25): the enum PrimaryBodyRepresentationSingle includes storage and
// atlas_doc_format, and "if available" the body is under body.<representation>
// .value as a string. An answer without it is an error, never an empty body.
export async function getPageBody(
  session: ConfluenceSession,
  id: string,
  representation: "storage" | "atlas_doc_format",
): Promise<string> {
  const pageId = contentId(id, "--id");
  const { json } = await session.request({
    method: "GET", path: v2(`/pages/${pageId}?body-format=${representation}`), scope: SCOPES.get,
  });
  const value = (json as { body?: Record<string, { value?: unknown } | undefined> } | null)?.body?.[representation]?.value;
  if (typeof value !== "string") throw new ConfluenceError(`Page ${pageId} answered without a ${representation} body.`);
  return value;
}

export interface UpdateInput {
  id: string;
  representation: Representation;
  value: string;
  title?: string;
  message?: string;
  // Re-parenting. Omitted means "leave where it is", NOT "move to the space root":
  // a field that silently relocates a page when a caller forgets it would turn
  // every ordinary edit into a structural change.
  parentId?: string;
}

export interface UpdateResult {
  page: Page;
  readVersion: number;
  sentVersion: number;
}

// PUT /wiki/api/v2/pages/{id}. The version number is READ here rather than
// accepted from the caller: a caller holding a stale number would otherwise
// clobber a version written since it last looked. A page that reports no
// version at all is refused - an absent number is unknown, not one.
export async function updatePage(session: ConfluenceSession, input: UpdateInput): Promise<UpdateResult> {
  const current = await getPage(session, input.id);
  if (!current.version) {
    throw new ConfluenceError(`Page ${input.id} reported no version number; refusing to invent one.`);
  }
  const sentVersion = current.version + 1;
  const { json } = await session.request({
    method: "PUT",
    path: v2(`/pages/${current.id || input.id.trim()}`),
    scope: SCOPES.update,
    body: {
      id: input.id.trim(),
      status: "current",
      title: input.title?.trim() || current.title,
      body: { representation: input.representation, value: input.value },
      version: { number: sentVersion, message: input.message ?? "" },
      ...(input.parentId ? { parentId: contentId(input.parentId, "--parent") } : {}),
    },
  });
  return { page: asPage(json), readVersion: current.version, sentVersion };
}

// DELETE moves the page to the trash. It does NOT remove it.
export async function deletePage(session: ConfluenceSession, id: string): Promise<void> {
  const pageId = contentId(id, "--id");
  await session.request({ method: "DELETE", path: v2(`/pages/${pageId}`), scope: SCOPES.delete });
}

// The second, permanent half, modelled as its own verb so a caller cannot purge
// by accident. It runs only against a page that is ALREADY trashed, and needs
// the manage/content space permission on top of the scope.
export async function purgePage(session: ConfluenceSession, id: string): Promise<void> {
  // Measured 2026-09-21: a binding without the space's manage-content permission
  // cannot read trashed content AT ALL. The direct read answers 404 and the
  // trashed listing answers 200 with zero results - fail-soft emptiness, not a
  // permission error. A page deleted seconds earlier is invisible both ways, so
  // "not found" here does NOT mean the page is gone. Saying so would turn a
  // missing permission into a false claim of absence, which is the one thing a
  // purge must never do.
  let page;
  try {
    page = await getPage(session, id, ["current", "trashed"]);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404) throw error;
    throw new ConfluenceError(
      `Page ${id.trim()} cannot be read, so purge is refused. Either it no longer exists, or this `
      + "identity cannot see trashed content - a binding without manage-content on the space gets an "
      + "empty answer rather than a permission error, and the two are indistinguishable from here. "
      + "Grant manage-content on the space, then repeat.",
    );
  }
  if (page.status !== "trashed") {
    throw new ConfluenceError(
      `Page ${page.id || id} is "${page.status || "of unknown status"}", not "trashed". `
      + "purge removes a page that is already in the trash; run delete first.",
    );
  }
  await session.request({ method: "DELETE", path: v2(`/pages/${page.id}?purge=true`), scope: SCOPES.purge });
}

// Moving a page WITHOUT touching its body. updatePage needs a representation and
// a value, so using it to re-parent would mean re-sending the content - and any
// difference between what was read and what is sent back is a silent edit. Here
// the current storage body is read and returned unchanged, so the only thing that
// differs between the two versions is the parent.
export async function movePage(
  session: ConfluenceSession,
  id: string,
  parentId: string,
): Promise<{ page: Page; fromParent: string; toParent: string }> {
  const pageId = contentId(id, "--id");
  const target = contentId(parentId, "--parent");
  if (pageId === target) throw new ConfluenceError("A page cannot be its own parent.");
  const { json: before } = await session.request({
    method: "GET", path: v2(`/pages/${pageId}?body-format=storage`), scope: SCOPES.get,
  });
  const current = asPage(before);
  if (!current.version) throw new ConfluenceError(`Page ${pageId} reported no version number.`);
  const fromParent = text((before as { parentId?: unknown }).parentId);
  if (fromParent === target) return { page: current, fromParent, toParent: target };
  const value = text(((before as { body?: { storage?: { value?: unknown } } }).body?.storage?.value));
  const { json } = await session.request({
    method: "PUT",
    path: v2(`/pages/${pageId}`),
    scope: SCOPES.update,
    body: {
      id: pageId,
      status: "current",
      title: current.title,
      parentId: target,
      body: { representation: "storage", value },
      version: { number: current.version + 1, message: "re-parented" },
    },
  });
  return { page: asPage(json), fromParent, toParent: target };
}

// Labels are NOT writable through v2. The add path is classic v1 and takes a
// JSON ARRAY, not an object.
export async function addLabels(session: ConfluenceSession, id: string, names: string[]): Promise<string[]> {
  const pageId = contentId(id, "--id");
  const wanted = names.map((name) => name.trim()).filter(Boolean);
  if (wanted.length === 0) throw new ConfluenceError("--labels is missing a label name.");
  const { json } = await session.request({
    method: "POST",
    path: v1(`/content/${pageId}/label`),
    scope: SCOPES.labels,
    body: wanted.map((name) => ({ prefix: "global", name })),
  });
  return resultsOf(json).map((row) => text(row.name)).filter(Boolean);
}

// Removal is classic v1 as well. The query form takes any name (the path form
// refuses "/"), answers 204 with no body, and the doc does not say what it
// answers for a label the page does not carry - so the result is the labels
// read back afterwards, not the status of the deletes.
export async function removeLabels(session: ConfluenceSession, id: string, names: string[]): Promise<string[]> {
  const pageId = contentId(id, "--id");
  const unwanted = names.map((name) => name.trim()).filter(Boolean);
  if (unwanted.length === 0) throw new ConfluenceError("--remove is missing a label name.");
  for (const name of unwanted) {
    await session.request({
      method: "DELETE",
      path: v1(`/content/${pageId}/label?name=${encodeURIComponent(name)}`),
      scope: SCOPES.labels,
    });
  }
  return listLabels(session, pageId);
}

// Reading labels is v2 and paginated by a next link, like the child list.
export async function listLabels(session: ConfluenceSession, id: string): Promise<string[]> {
  const pageId = contentId(id, "--id");
  const out = new Set<string>();
  let path: string | null = v2(`/pages/${pageId}/labels?limit=250`);
  while (path) {
    const { json }: { json: unknown } = await session.request({ method: "GET", path, scope: SCOPES.get });
    const before = out.size;
    for (const row of resultsOf(json)) {
      const name = text(row.name);
      if (name) out.add(name);
    }
    const next = (json as { _links?: { next?: unknown } })?._links?.next;
    const link = typeof next === "string" && next ? next : "";
    path = link && out.size > before ? (link.startsWith("/wiki") ? link : `/wiki${link}`) : null;
  }
  return [...out];
}

// GET /wiki/api/v2/spaces?keys=<key>. Only an EXACT key is adopted: the filter
// can answer with neighbours, and a near miss adopted as the target would file
// content into the wrong space.
export async function findSpace(session: ConfluenceSession, key: string): Promise<Space | null> {
  const wanted = spaceKey(key);
  const { json } = await session.request({
    method: "GET",
    path: v2(`/spaces?keys=${encodeURIComponent(wanted)}`),
    scope: SCOPES.space,
  });
  const hit = resultsOf(json).find((row) => text(row.key).toUpperCase() === wanted.toUpperCase());
  return hit ? { id: text(hit.id), key: text(hit.key), name: text(hit.name) } : null;
}

// Paginated to exhaustion, and that is the whole point. Measured 2026-09-21: the
// endpoint answers with at most 25 children and a cursor. A single request made
// four parents with 26, 26, 63 and 65 children all report exactly 25, and a count
// used to verify a migration then confirms a number the API never claimed. A
// truncated list that looks complete is worse than an error, because nothing asks
// a plausible number a second question.
export async function listChildren(session: ConfluenceSession, id: string): Promise<Child[]> {
  const pageId = contentId(id, "--id");
  const out: Child[] = [];
  const seen = new Set<string>();
  let path: string | null = v2(`/pages/${pageId}/children?limit=250`);
  // A cursor that repeats would spin forever; a page that adds nothing new ends it.
  while (path) {
    const { json }: { json: unknown } = await session.request({ method: "GET", path, scope: SCOPES.children });
    const before = out.length;
    for (const row of resultsOf(json)) {
      const child = { id: text(row.id), title: text(row.title) };
      if (child.id && !seen.has(child.id)) { seen.add(child.id); out.push(child); }
    }
    const next = (json as { _links?: { next?: unknown } })?._links?.next;
    const link = typeof next === "string" && next ? next : "";
    path = link && out.length > before ? (link.startsWith("/wiki") ? link : `/wiki${link}`) : null;
  }
  return out;
}

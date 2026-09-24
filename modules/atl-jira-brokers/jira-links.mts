// OP-1095: shared, side-effect-free Jira issue-link decisions for both brokers.
// The callers own HTTP. This module validates direction, exact link type and
// readbacks before a write can be reported as successful.

export const LINK_TYPE_CATALOG_PATH = "/issueLinkType";
export const LINK_PATH = "/issueLink";
export const linkDeletePath = (linkId: string): string => `/issueLink/${encodeURIComponent(linkId)}`;
export const linkReadbackPath = (key: string): string => `/issue/${encodeURIComponent(key)}?fields=issuelinks`;

export interface LinkOptions {
  type?: unknown;
  outward?: unknown;
  inward?: unknown;
}

export interface LinkPlan {
  typeName: string;
  outwardKey: string;
  inwardKey: string;
}

export interface LinkType {
  id: string;
  name: string;
  inward: string | null;
  outward: string | null;
}

interface LinkEntry {
  id?: unknown;
  type?: { id?: unknown; name?: unknown };
  inwardIssue?: { key?: unknown };
  outwardIssue?: { key?: unknown };
}

interface LinkFields {
  issuelinks?: unknown;
}

export interface LinkParseResult {
  plan?: LinkPlan;
  error?: string;
}

export interface LinkTypeResult {
  type?: LinkType;
  error?: string;
}

export interface LinkIdsResult {
  ids?: string[];
  error?: string;
}

export interface LinkIdResult {
  id?: string;
  error?: string;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;

function issueKey(raw: unknown, flag: string): { key?: string; error?: string } {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!value) return { error: `--${flag} fehlt.` };
  if (!ISSUE_KEY.test(value)) return { error: `--${flag} ist kein Vorgangsschlüssel.` };
  return { key: value };
}

export function parseLinkOptions(options: LinkOptions = {}): LinkParseResult {
  const typeName = typeof options.type === "string" ? options.type.trim() : "";
  if (!typeName) return { error: "--type fehlt." };
  const outward = issueKey(options.outward, "outward");
  if (outward.error || !outward.key) return { error: outward.error };
  const inward = issueKey(options.inward, "inward");
  if (inward.error || !inward.key) return { error: inward.error };
  if (outward.key === inward.key) return { error: "Ein Vorgang kann nicht mit sich selbst verknüpft werden." };
  return { plan: { typeName, outwardKey: outward.key, inwardKey: inward.key } };
}

export function resolveLinkType(name: string, catalog: unknown): LinkTypeResult {
  const known = new Map<string, LinkType>();
  const source = catalog !== null && typeof catalog === "object"
    ? (catalog as { issueLinkTypes?: unknown }).issueLinkTypes
    : undefined;
  const entries = Array.isArray(source) ? source : [];
  for (const raw of entries) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as { id?: unknown; name?: unknown; inward?: unknown; outward?: unknown };
    if (typeof entry.name !== "string" || entry.id === undefined || entry.id === null) continue;
    known.set(entry.name, {
      id: String(entry.id),
      name: entry.name,
      inward: typeof entry.inward === "string" ? entry.inward : null,
      outward: typeof entry.outward === "string" ? entry.outward : null,
    });
  }
  const type = known.get(name);
  if (type) return { type };
  return { error: `Unbekannter Verknüpfungstyp: ${name}. Bekannt auf der Site: ${[...known.keys()].join(", ") || "keine"}.` };
}

export function linkRequestBody(type: LinkType, plan: LinkPlan): object {
  return {
    type: { id: type.id },
    outwardIssue: { key: plan.outwardKey },
    inwardIssue: { key: plan.inwardKey },
  };
}

export function describeLink(type: LinkType, plan: LinkPlan): string {
  return `${plan.outwardKey} ${type.outward || type.name || "verknüpft mit"} ${plan.inwardKey}`;
}

function matchesType(entry: LinkEntry, type: LinkType): boolean {
  const id = entry.type?.id;
  if (id !== undefined && id !== null) return String(id) === type.id;
  return entry.type?.name === type.name;
}

function matchesDirection(entry: LinkEntry, plan: LinkPlan): boolean {
  if (entry.inwardIssue?.key !== plan.inwardKey) return false;
  const outward = entry.outwardIssue?.key;
  return outward === undefined || outward === plan.outwardKey;
}

export function findLinkIds(fields: unknown, type: LinkType, plan: LinkPlan): LinkIdsResult {
  if (fields === null || typeof fields !== "object" || !Object.hasOwn(fields, "issuelinks")) {
    return { error: "Readback liefert keine Verknüpfungen." };
  }
  const links = (fields as LinkFields).issuelinks;
  if (!Array.isArray(links)) return { error: "Readback liefert keine Verknüpfungen." };
  const ids = links
    .filter((entry): entry is LinkEntry => entry !== null && typeof entry === "object")
    .filter((entry) => matchesType(entry, type) && matchesDirection(entry, plan))
    .map((entry) => entry.id)
    .filter((id) => id !== undefined && id !== null)
    .map(String);
  return { ids };
}

export function confirmLinkCreated(fields: unknown, type: LinkType, plan: LinkPlan): LinkIdResult {
  const found = findLinkIds(fields, type, plan);
  if (found.error || !found.ids) return { error: found.error };
  if (!found.ids.length) return { error: `Readback bestätigt die Verknüpfung nicht: ${describeLink(type, plan)} ist am Vorgang nicht zu finden.` };
  return { id: found.ids[0] };
}

export function selectLinkToRemove(fields: unknown, type: LinkType, plan: LinkPlan): LinkIdResult {
  const found = findLinkIds(fields, type, plan);
  if (found.error || !found.ids) return { error: found.error };
  if (!found.ids.length) return { error: `Keine passende Verknüpfung: ${describeLink(type, plan)} besteht nicht.` };
  if (found.ids.length > 1) return { error: `Mehrere passende Verknüpfungen: ${found.ids.join(", ")}. Es wird nicht geraten, welche gelöst werden soll.` };
  return { id: found.ids[0] };
}

export function confirmLinkRemoved(fields: unknown, type: LinkType, plan: LinkPlan): { error?: string } {
  const found = findLinkIds(fields, type, plan);
  if (found.error || !found.ids) return { error: found.error };
  if (found.ids.length) return { error: `Readback zeigt die Verknüpfung weiterhin: ${describeLink(type, plan)}.` };
  return {};
}

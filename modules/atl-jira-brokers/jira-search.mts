import { fieldListOr } from "./jira-fields.mts";

// OP-1372. Without a search verb the house rule "look for an existing work item
// before creating one" cannot be executed by the service account at all, and the
// only way around it was a cloud MCP under a different identity. That produced a
// real duplicate once (OP-1359 beside OP-1349) and, on 2026-09-17, a measured
// finding that had to be parked as a comment because no duplicate check was
// possible.
//
// THE ROUTE IS READ OFF THE SPEC, NOT REMEMBERED (CLAUDE.md rule 5). The official
// OpenAPI document marks GET and POST /rest/api/3/search as deprecated with
// "Currently being removed"; the supported route is /rest/api/3/search/jql. The
// two differ in how they page: the old one counted with startAt, this one carries
// an opaque nextPageToken, and the spec states the token is "not included in the
// response for the last page". A search built from memory of the old interface
// therefore returns page one forever.
//
// This module holds no I/O so both brokers can share it and test it with a stub.

/** Fields the spec accepts as a comma-separated list; `key` is top level, not a field. */
export const DEFAULT_SEARCH_FIELDS = ["summary", "status", "updated"] as const;

/** Spec default for maxResults. The spec states no ceiling; the server may return fewer. */
export const DEFAULT_MAX_RESULTS = 50;

export interface SearchRequest {
  readonly jql: string;
  readonly maxResults?: number | undefined;
  readonly fields?: readonly string[] | undefined;
  readonly nextPageToken?: string | undefined;
}

export interface SearchHit {
  readonly key: string;
  readonly status: string;
  readonly summary: string;
  readonly updated: string;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  /** Null on the last page, because the spec omits the token there. */
  readonly nextPageToken: string | null;
  readonly isLast: boolean;
  readonly warnings: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A positive integer, or the spec default. Guards the argument, it does not cap the API. */
export function boundedMaxResults(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_RESULTS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_RESULTS;
  return parsed;
}

export function searchFields(raw: unknown): string[] {
  return fieldListOr(raw, DEFAULT_SEARCH_FIELDS);
}

/** Path below the REST base, ready for the broker's authenticated GET. */
export function searchPath(request: SearchRequest): string {
  const jql = request.jql.trim();
  if (!jql) throw new Error("--jql darf nicht leer sein.");
  const fields = request.fields?.length ? request.fields : DEFAULT_SEARCH_FIELDS;
  const query = new URLSearchParams();
  query.set("jql", jql);
  query.set("maxResults", String(boundedMaxResults(request.maxResults)));
  query.set("fields", fields.join(","));
  if (request.nextPageToken) query.set("nextPageToken", request.nextPageToken);
  return `/search/jql?${query.toString()}`;
}

export function readPage(value: unknown): SearchPage {
  const holder = record(value);
  const issues = Array.isArray(holder?.issues) ? holder.issues : [];
  const hits: SearchHit[] = [];
  for (const entry of issues) {
    const issue = record(entry);
    if (!issue) continue;
    const fields = record(issue.fields) ?? {};
    hits.push({
      key: text(issue.key),
      status: text(record(fields.status)?.name),
      summary: text(fields.summary),
      updated: text(fields.updated),
    });
  }
  const token = text(holder?.nextPageToken);
  const warnings: string[] = Array.isArray(holder?.warnings)
    ? holder.warnings.map(text).filter(Boolean)
    : [];
  return {
    hits,
    nextPageToken: token || null,
    // The token's absence is the documented end marker; isLast is reported when
    // the site sends it, but it is not the field the loop may depend on.
    isLast: holder?.isLast === true || token === "",
    warnings,
  };
}

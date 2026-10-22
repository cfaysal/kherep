// The exact-term half of the neighbour search. It hits rarely and precisely,
// which is the opposite failure mode to the semantic half - that is the entire
// reason to keep it.
//
// The value of `text ~ "..."` is parsed twice: once as a CQL string, then by
// Lucene, whose syntax includes ( ) ~ " \ : * ? [ ] { } ^ ! + - /. The raw
// title used to go through unescaped, and titles carrying those characters drew
// HTTP 403 and 500 (issue #651). The only escape Atlassian documents inside a
// CQL string is \", so this module does not escape: it keeps only lowercase
// ASCII letters and digits, which cannot be syntax. Lowercase also matters for
// the words AND, OR, NOT: Lucene operators must be ALL CAPS, so a lowercase one
// is a plain term.
import { ConfluenceRequestError, SCOPES, v1, type ConfluenceSession } from "./confluence-contract.mts";
import { strictRows } from "./confluence-pagination.mts";
import { contentTerms } from "./confluence-related.mts";

// The content words of a title, split once more so that contentTerms' inner
// . + - (node.js, vite-plugin) cannot reach Lucene. Order of first appearance,
// no duplicates. Only these words can let selectRelated accept a neighbour, so
// searching on exactly them loses no accepted result.
export function textTerms(title: string): string[] {
  const out = new Set<string>();
  for (const term of contentTerms(title)) {
    for (const part of term.split(/[^a-z0-9]+/)) if (part) out.add(part);
  }
  return [...out];
}

// Every word required, in no particular order - Atlassian's documented reading
// of several words inside one quoted value. Null when there is nothing to search.
export function textCql(spaceKey: string, terms: string[]): string | null {
  if (!terms.length) return null;
  return `space=${JSON.stringify(spaceKey)} and type=page and text ~ "${terms.join(" ")}"`;
}

export interface TextHits {
  titles: string[];
  // The CQL that was sent; null when the title had no searchable word and no request was made.
  cql: string | null;
  // Present when the request was refused or failed. titles is then [] and means UNKNOWN, not zero.
  failure?: { status: number; detail: string };
}

export async function textSearch(
  session: ConfluenceSession,
  spaceKey: string,
  title: string,
  limit = 10,
): Promise<TextHits> {
  const cql = textCql(spaceKey, textTerms(title));
  if (cql === null) return { titles: [], cql };
  const path = v1(`/search?cql=${encodeURIComponent(cql)}&limit=${limit}`);
  let json: unknown;
  try {
    ({ json } = await session.request({ method: "GET", path, scope: SCOPES.get }));
  } catch (error) {
    // A refused request is one unsearched half, not a reason to end the run.
    // Anything else (network, a broker bug) still aborts.
    if (!(error instanceof ConfluenceRequestError)) throw error;
    return { titles: [], cql, failure: { status: error.status, detail: error.detail } };
  }
  const titles = strictRows(json)
    .map((row) => text((row.content as { title?: unknown } | undefined)?.title) || text(row.title))
    .filter(Boolean);
  return { titles, cql };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// One line for the operator. It names the status, never a cause the broker did
// not measure: 400 is the only status whose meaning the endpoint documents.
export function textFailureLine(hits: TextHits): string {
  const { status, detail } = hits.failure ?? { status: 0, detail: "" };
  const hint = status === 400 ? " (the CQL query cannot be parsed)" : "";
  const said = detail ? ` - ${detail}` : "";
  return `exact-term search: HTTP ${status}${hint}${said}. Hits from this half are UNKNOWN. cql: ${hits.cql}`;
}

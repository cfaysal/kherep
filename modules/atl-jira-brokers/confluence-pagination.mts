// Strict, endpoint-bound pagination shared by inventory and drainage label reads.
import { ConfluenceError } from './confluence-contract.mts';

export class ReadFailure extends ConfluenceError {
  reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}

export function readFailure(error: unknown): {reason: string; httpStatus?: number} {
  const status = (error as {status?: unknown} | null)?.status;
  return {reason: error instanceof ReadFailure ? error.reason : 'read-failed',
    ...(typeof status === 'number' ? {httpStatus:status} : {})};
}

export function strictRows(json: unknown): Record<string, unknown>[] {
  const rows = (json as {results?: unknown} | null)?.results;
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new ReadFailure('malformed-response');
  }
  return rows as Record<string, unknown>[];
}

export function nextPath(json: unknown, endpoint: string): string | null {
  const links = (json as {_links?: unknown} | null)?._links;
  if (links !== undefined && (!links || typeof links !== 'object' || Array.isArray(links))) {
    throw new ReadFailure('malformed-pagination-links');
  }
  const next = (links as {next?: unknown} | undefined)?.next;
  if (next === undefined || next === null || next === '') return null;
  if (typeof next !== 'string' || !/^\/(?:wiki\/)?api\/v2\//.test(next) || /[\\#\s]/.test(next)) {
    throw new ReadFailure('invalid-next-link');
  }
  const normalized = next.startsWith('/wiki/') ? next : `/wiki${next}`;
  const parsed = new URL(normalized, 'https://pagination.invalid');
  if (parsed.pathname !== endpoint || [...parsed.searchParams.keys()].some(k => !['cursor','limit','status'].includes(k))
    || (parsed.searchParams.has('status') && parsed.searchParams.get('status') !== 'current')) {
    throw new ReadFailure('escaped-next-link');
  }
  const keys = [...parsed.searchParams.keys()];
  const limit = parsed.searchParams.get('limit');
  if (new Set(keys).size !== keys.length || !parsed.searchParams.get('cursor')
    || (limit !== null && (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))))) {
    throw new ReadFailure('malformed-pagination-query');
  }
  return parsed.pathname + parsed.search;
}

export function positiveVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfluenceError('--expected-version must be a positive whole number.');
  }
  return value;
}

export function parseExpectedVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new ConfluenceError('--expected-version must be a positive whole number.');
  return positiveVersion(Number(value));
}

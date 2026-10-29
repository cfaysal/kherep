// Local deterministic analysis only. No content excerpts or server messages cross this output boundary.
import { ConfluenceError, type ConfluenceSession } from './confluence-contract.mts';
import { InventoryError, spaceIndex, type SpaceIndex } from './confluence-related.mts';
import { drainageRules, type Candidate, type Snapshot } from './confluence-drainage-rules.mts';
import { readFailure, ReadFailure } from './confluence-pagination.mts';
import { drainageSnapshot } from './confluence-drainage-snapshot.mts';
import { revisionStaleness, staleCandidates, type StalenessOptions, type StalenessReport } from './confluence-revision-staleness.mts';

export interface ScanOptions {
  spaceId: string;
  metadataApproved: boolean;
  pageIds?: string[];
  excludeIds?: string[];
  now?: () => number;
  // #693: the read-only git probe of the operator's --repo-root; absent means no checkout was given.
  staleness?: StalenessOptions;
}
interface ReadError { pageId?: string; stage: 'inventory' | 'snapshot' | 'inventory-readback'; reason: string; httpStatus?: number }
export interface DrainageReport {
  scope: { spaceId: string; selection: 'visible-space' | 'subset'; requestedIds: string[]; excludedIds: string[] };
  inventory: { status: 'complete' | 'partial' | 'failed'; discovered: number; selected: number; read: number;
    excluded: number; startedAt: string; finishedAt: string; errors: ReadError[] };
  semanticReview: 'UNKNOWN';
  graph: 'visible-space-read' | 'not-evaluated';
  limitations: string[];
  candidates: Candidate[];
  revisionStaleness: StalenessReport;
}
function ids(values: string[] = []): string[] {
  if (values.some(id => !/^\d+$/.test(id))) throw new ConfluenceError('Page ids must be numeric.');
  return [...new Set(values)].sort((a,b) => a.localeCompare(b,'en'));
}
function readError(error: unknown, stage: ReadError['stage'], pageId?: string): ReadError {
  return {stage,...(pageId ? {pageId} : {}),
    ...(error instanceof InventoryError ? error.failure : readFailure(error))};
}
function signature(index: SpaceIndex): string {
  return JSON.stringify([...index.byId.values()].sort((a,b)=>a.id.localeCompare(b.id,'en')));
}
export async function scanDrainage(session: ConfluenceSession, options: ScanOptions): Promise<DrainageReport> {
  if (!options.metadataApproved) throw new ConfluenceError('Classify and approve page-id/version metadata before scanning (--metadata-approved).');
  if (!/^\d+$/.test(options.spaceId)) throw new ConfluenceError('Space id must be numeric.');
  const requestedIds = ids(options.pageIds);
  const excludedIds = ids(options.excludeIds);
  if (options.pageIds && !requestedIds.length) throw new ConfluenceError('Subset must contain a page id.');
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const errors: ReadError[] = [];
  let index: SpaceIndex = {byId:new Map(),byTitle:new Map(),parents:new Set()};
  try { index = await spaceIndex(session,options.spaceId); }
  catch (error) {
    if (error instanceof InventoryError) index = error.index;
    errors.push(readError(error,'inventory'));
  }
  const wanted = options.pageIds ? requestedIds : ids([...index.byId.keys()]);
  const selected = wanted.filter(id => !excludedIds.includes(id));
  const pages: Snapshot[] = [];
  for (const id of selected) {
    try {
      if (!index.byId.has(id)) throw new ReadFailure('requested-page-not-visible');
      const snapshot = await drainageSnapshot(session,id,options.spaceId);
      const listed = index.byId.get(id)!;
      if (snapshot.title !== listed.title || snapshot.parentId !== listed.parentId) throw new ReadFailure('inventory-drift');
      pages.push(snapshot);
    } catch (error) { errors.push(readError(error,'snapshot',id)); }
  }
  // Detect observed inventory moves/changes before claiming graph coverage.
  if (!errors.length) {
    try {
      if (signature(index) !== signature(await spaceIndex(session,options.spaceId))) throw new ReadFailure('inventory-drift');
    } catch (error) { errors.push(readError(error,'inventory-readback')); }
  }
  const graphComplete = !options.pageIds && !excludedIds.length && !errors.length;
  let status: DrainageReport['inventory']['status'];
  if (errors.length && !index.byId.size && !pages.length) status = 'failed';
  else if (errors.length || excludedIds.length) status = 'partial';
  else status = 'complete';
  const staleness = await revisionStaleness(pages, {status,selected:selected.length,read:pages.length},
    options.staleness ?? {probe:null,ref:'HEAD'});
  return {
    scope:{spaceId:options.spaceId,selection:options.pageIds ? 'subset':'visible-space',requestedIds,excludedIds},
    inventory:{status,
      discovered:index.byId.size,selected:selected.length,read:pages.length,
      excluded:excludedIds.filter(id=>index.byId.has(id)).length,startedAt,finishedAt:new Date(now()).toISOString(),errors},
    semanticReview:'UNKNOWN',graph:graphComplete?'visible-space-read':'not-evaluated',
    limitations:[
      'Coverage is limited to current pages visible to this service account; hidden pages remain UNKNOWN.',
      'Bracket reads detect observed drift, not an atomic space or label snapshot.',
      'Complete inventory does not prove that contradictions, duplicates or external incoming links are absent.',
      'Historical measurements remain valid for their original scope; later changes require current verification.',
      ...(excludedIds.length ? ['Excluded pages were not read; private or unavailable routes remain outside review.'] : []),
      'Revision staleness compares bound paths between commits of the given checkout; it is a signal to re-measure, not a refutation, and a page without paths or without a checkout stays unjudged.',
    ],
    candidates:[...drainageRules(pages,graphComplete),...staleCandidates(staleness)],
    revisionStaleness:staleness,
  };
}

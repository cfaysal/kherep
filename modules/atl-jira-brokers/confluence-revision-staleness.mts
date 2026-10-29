// Issue #693: flag confirmed code observations whose bound paths changed since their Revision. Read-only: the
// judge asks an injected GitProbe and returns a report; it never writes a page or a label. Not part of the
// synchronous drainage rules, which the confirm path re-runs on a promoted body and which must never spawn git.
import { revisionLines } from './confluence-claim-text.mts';
import { revisionBody } from './confluence-evidence.mts';
import type { Candidate, Snapshot } from './confluence-drainage-rules.mts';
import { checkoutName, repositoryOf, type ChangedPath, type GitProbe, type Tri } from './confluence-revision-staleness-git.mts';

export type StalenessOutcome = 'stale' | 'current' | 'unscoped' | 'unknown';
export interface BindingStaleness {
  revision: string; repository: string; outcome: StalenessOutcome; reason: string;
  paths?: string[]; changed?: ChangedPath[]; comparedSha?: string;
}
export interface PageStaleness { pageId: string; readVersion: number; outcome: StalenessOutcome; reason: string; bindings: BindingStaleness[] }
export interface StalenessReport {
  checkout: 'given' | 'not-given'; repository: string | null; comparedRef: string; comparedSha: string | null;
  shallow: boolean | 'UNKNOWN'; workingTree: 'not-compared';
  coverage: 'complete' | 'partial' | 'failed';
  counts: { stale: number; current: number; unscoped: number; unknown: number; notRead: number; notEligible: number };
  pages: PageStaleness[];
}
export interface StalenessOptions { probe: GitProbe | null; ref: string }
interface PlannedBinding { revision: string; repository: string; sha: string; paths: string[] }
interface PlannedPage { pageId: string; readVersion: number; bindings: PlannedBinding[] }

// D5: reasons that mean this checkout could not answer, so the run's coverage is incomplete (exit 2).
export const GIT_INCOMPLETE = new Set(['checkout-not-a-repository', 'ref-unresolved', 'commit-missing', 'git-failed']);
const ORDER: StalenessOutcome[] = ['stale', 'unknown', 'unscoped', 'current'];

// D3: confirmed observation or knowledge pages with at least one bound Revision line, read as the drainage rule reads them.
export function planStaleness(pages: Snapshot[]): { planned: PlannedPage[]; notEligible: number } {
  const planned: PlannedPage[] = [];
  for (const p of pages) {
    if (!p.labels.includes('evidence-confirmed') || !p.labels.some(l => l === 'type-observation' || l === 'type-knowledge')) continue;
    const r = revisionLines(revisionBody(p.body));
    if (!r.bound.length) continue;
    const bindings = [...new Set(r.bound)].map(revision => ({ revision, repository: repositoryOf(revision.slice(0, revision.lastIndexOf('@'))),
      sha: revision.slice(revision.lastIndexOf('@') + 1), paths: r.paths[revision] ?? [] }));
    planned.push({ pageId: p.id, readVersion: p.version, bindings });
  }
  return { planned, notEligible: pages.length - planned.length };
}

function memo<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return key => { if (!cache.has(key)) cache.set(key, fn(key)); return cache.get(key)!; };
}
const unknown = (b: PlannedBinding, reason: string): BindingStaleness =>
  ({ revision: b.revision, repository: b.repository, outcome: 'unknown', reason, ...(b.paths.length ? { paths: b.paths } : {}) });

async function judgeStaleness(planned: PlannedPage[], options: StalenessOptions) {
  const { probe, ref } = options;
  const top = probe ? await probe.topLevel() : null;
  const repository = top ? checkoutName(top) : null;
  const refSha = probe && top ? await probe.resolveRef(ref) : null;
  const shallow = probe && top ? await probe.shallow() : 'UNKNOWN';
  const commit = memo(sha => probe!.commit(sha)), ancestor = memo(sha => probe!.ancestor(sha, refSha!));
  const diff = memo(key => { const [sha, ...paths] = key.split('\n'); return probe!.diff(sha, refSha!, paths); });
  const pathAt = memo(key => { const [sha, path] = key.split('\n'); return probe!.pathAt(sha, path); });
  const failed = (t: Tri, b: PlannedBinding, no: string): BindingStaleness | null => t === 'yes' ? null : unknown(b, t === 'no' ? no : 'git-failed');

  async function judge(b: PlannedBinding): Promise<BindingStaleness> {
    if (!b.paths.length) return { revision: b.revision, repository: b.repository, outcome: 'unscoped', reason: 'no-paths-on-line' };
    if (!probe) return unknown(b, 'checkout-not-given');
    if (!top) return unknown(b, 'checkout-not-a-repository');
    if (b.repository !== repository) return unknown(b, 'repository-not-checked-out');
    if (!refSha) return unknown(b, 'ref-unresolved');
    const early = failed(await commit(b.sha), b, 'commit-missing') ?? failed(await ancestor(b.sha), b, 'commit-not-ancestor');
    if (early) return early;
    const rows = await diff([b.sha, ...b.paths].join('\n'));
    if (!rows) return unknown(b, 'git-failed');
    const base = { revision: b.revision, repository: b.repository, paths: b.paths, comparedSha: refSha };
    if (rows.length) return { ...base, outcome: 'stale', reason: 'paths-changed', changed: rows };
    // D4: a bound path absent at the bound commit (and, with no row, at the compared one) is never "unchanged".
    for (const path of b.paths) {
      const missing = failed(await pathAt(`${b.sha}\n${path}`), b, 'path-not-in-repository');
      if (missing) return missing;
    }
    return { ...base, outcome: 'current', reason: 'paths-unchanged' };
  }

  const counts = { stale: 0, current: 0, unscoped: 0, unknown: 0 };
  const pages: PageStaleness[] = [];
  for (const page of planned) {
    const bindings: BindingStaleness[] = [];
    for (const b of page.bindings) bindings.push(await judge(b));
    const decider = ORDER.map(o => bindings.find(b => b.outcome === o)).find(Boolean)!;
    counts[decider.outcome]++;
    pages.push({ pageId: page.pageId, readVersion: page.readVersion, outcome: decider.outcome, reason: decider.reason, bindings });
  }
  return { checkout: probe ? 'given' as const : 'not-given' as const, repository, comparedRef: ref, comparedSha: refSha, shallow, workingTree: 'not-compared' as const, counts, pages };
}

export async function revisionStaleness(pages: Snapshot[], inventory: { status: StalenessReport['coverage']; selected: number; read: number },
  options: StalenessOptions): Promise<StalenessReport> {
  const { planned, notEligible } = planStaleness(pages);
  const judged = await judgeStaleness(planned, options);
  return { ...judged, coverage: inventory.status,
    counts: { ...judged.counts, notRead: Math.max(0, inventory.selected - inventory.read), notEligible } };
}

// One recheck candidate per stale page, from the binding that decided it. The label is never changed here.
export function staleCandidates(report: StalenessReport): Candidate[] {
  return report.pages.filter(p => p.outcome === 'stale').map(p => {
    const b = p.bindings.find(binding => binding.outcome === 'stale')!;
    return { pageId: p.pageId, readVersion: p.readVersion, problem: 'revision-stale', proposedAction: 'recheck-evidence',
      evidence: 'Paths bound on a confirmed code observation changed between its Revision and the compared ref; re-measure at the compared commit or supersede. The label is unchanged.',
      uncertainty: 'UNKNOWN', detail: { repository: b.repository, boundCommit: b.revision.slice(b.revision.lastIndexOf('@') + 1),
        comparedRef: report.comparedRef, comparedSha: b.comparedSha ?? '', changedPaths: (b.changed ?? []).map(c => c.path) } };
  });
}
// D5: a complete inventory still exits 2 when the given checkout could not answer for a binding.
export const gitIncomplete = (report: StalenessReport): boolean =>
  report.pages.some(p => p.bindings.some(b => b.outcome === 'unknown' && GIT_INCOMPLETE.has(b.reason)));

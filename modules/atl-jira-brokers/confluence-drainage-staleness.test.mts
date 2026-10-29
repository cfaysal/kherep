// Issue #693 T2-T8: the drainage scan flags confirmed code observations whose bound paths changed. Synthetic pages,
// a fake git probe; every Confluence call is a GET and nothing is ever written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scanDrainage } from './confluence-drainage-scan.mts';
import { cmdDrainage } from './confluence-drainage-cli.mts';
import type { ConfluenceSession, RequestSpec } from './confluence-contract.mts';
import type { ChangedPath, GitProbe, Tri } from './confluence-revision-staleness-git.mts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), HEAD = 'c'.repeat(40);
const CONFIRMED = ['type-observation', 'evidence-confirmed', 'status-author-model'];
const page = (id: string, value: string, labels = CONFIRMED) => ({ id, title: `Synthetic ${id}`, spaceId: '9', status: 'current',
  parentId: null, version: { number: 3 }, body: { storage: { value } }, labels });
const rev = (line: string) => `<p>Revision: ${line}</p><p>Code: the retry queue keeps receipt identity.</p>`;
function harness(pages: ReturnType<typeof page>[], fail?: (spec: RequestSpec) => boolean) {
  const calls: RequestSpec[] = [];
  const session: ConfluenceSession = { async request(spec) {
    assert.equal(spec.method, 'GET', 'scanner must never mutate'); calls.push(spec);
    if (fail?.(spec)) throw Object.assign(new Error('PRIVATE'), { status: 500 });
    if (spec.path.includes('/spaces')) return { status: 200, json: spec.path.includes('/spaces/9/pages') ? { results: pages } : { results: [{ id: '9', key: 'KB' }] } };
    const p = pages.find(p => p.id === /\/pages\/(\d+)(?:[/?]|$)/.exec(spec.path)?.[1]);
    if (spec.path.includes('/labels')) return { status: 200, json: { results: p?.labels.map(name => ({ name })) } };
    return { status: 200, json: p };
  } };
  return { calls, session };
}
interface Fake { top?: string | null; refSha?: string | null; commit?: Tri; ancestor?: Tri; rows?: ChangedPath[] | null; pathAt?: Tri }
function probe(f: Fake = {}): GitProbe & { log: string[] } {
  const log: string[] = [];
  return { log,
    async topLevel() { log.push('top'); return f.top === undefined ? '/w/alpha' : f.top; },
    async resolveRef(ref) { log.push(`ref ${ref}`); return f.refSha === undefined ? HEAD : f.refSha; },
    async shallow() { return false; },
    async commit(sha) { log.push(`commit ${sha.slice(0, 1)}`); return f.commit ?? 'yes'; },
    async ancestor(sha) { log.push(`ancestor ${sha.slice(0, 1)}`); return f.ancestor ?? 'yes'; },
    async diff(sha, _ref, paths) { log.push(`diff ${sha.slice(0, 1)} ${paths.join(',')}`); return f.rows === undefined ? [] : f.rows; },
    async pathAt(_sha, p) { log.push(`path ${p}`); return f.pathAt ?? 'yes'; },
  };
}
const opts = { spaceId: '9', metadataApproved: true, now: () => 1000 };
const scan = (pages: ReturnType<typeof page>[], p: GitProbe | null = probe(), ref = 'HEAD') =>
  scanDrainage(harness(pages).session, { ...opts, staleness: { probe: p, ref } });
const only = async (line: string, f: Fake = {}) => (await scan([page('1', rev(line))], probe(f))).revisionStaleness.pages[0];

test('T2/T3 a changed bound path is a revision-stale candidate with ids, commits and paths only', async () => {
  const r = await scan([page('1', rev(`alpha@${A} -- src/queue.mts src/gone.mts`))],
    probe({ rows: [{ status: 'M', path: 'src/queue.mts' }, { status: 'D', path: 'src/gone.mts' }] }));
  const c = r.candidates.filter(c => c.problem === 'revision-stale');
  assert.deepEqual(c, [{ pageId: '1', readVersion: 3, problem: 'revision-stale', proposedAction: 'recheck-evidence',
    evidence: 'Paths bound on a confirmed code observation changed between its Revision and the compared ref; re-measure at the compared commit or supersede. The label is unchanged.',
    uncertainty: 'UNKNOWN', detail: { repository: 'alpha', boundCommit: A, comparedRef: 'HEAD', comparedSha: HEAD, changedPaths: ['src/queue.mts', 'src/gone.mts'] } }]);
  assert.equal(r.revisionStaleness.pages[0].outcome, 'stale');
  assert.equal(r.revisionStaleness.pages[0].reason, 'paths-changed');
  assert.deepEqual(r.revisionStaleness.pages[0].bindings[0].changed?.map(x => x.status), ['M', 'D'], 'T7f a deleted path is stale');
  assert.equal(r.revisionStaleness.counts.stale, 1);
  assert.ok(!JSON.stringify(r).includes('retry queue') && !JSON.stringify(r).includes('Synthetic 1'), 'no title or body text');
  assert.equal(r.revisionStaleness.workingTree, 'not-compared');
});
test('T4 unchanged bound paths are current with the compared commit', async () => {
  const p = await only(`alpha@${A} -- src/queue.mts`);
  assert.deepEqual([p.outcome, p.reason, p.bindings[0].comparedSha], ['current', 'paths-unchanged', HEAD]);
});
test('T5 a bound line without paths is unscoped and asks git nothing', async () => {
  const fake = probe();
  const r = await scan([page('1', rev(`alpha@${A}`))], fake);
  assert.deepEqual([r.revisionStaleness.pages[0].outcome, r.revisionStaleness.pages[0].reason], ['unscoped', 'no-paths-on-line']);
  assert.ok(!fake.log.some(l => /^(commit|diff)/.test(l)));
  assert.ok(!r.candidates.some(c => c.problem === 'revision-stale'));
});
test('T6/T7 every failure is unknown with its reason, never current', async () => {
  const line = `alpha@${A} -- src/queue.mts`;
  for (const [f, reason] of [[{ commit: 'no' }, 'commit-missing'], [{ commit: 'failed' }, 'git-failed'], [{ top: null }, 'checkout-not-a-repository'],
    [{ top: '/w/beta' }, 'repository-not-checked-out'], [{ refSha: null }, 'ref-unresolved'], [{ ancestor: 'no' }, 'commit-not-ancestor'],
    [{ ancestor: 'failed' }, 'git-failed'], [{ rows: null }, 'git-failed'], [{ pathAt: 'no' }, 'path-not-in-repository'], [{ pathAt: 'failed' }, 'git-failed']] as [Fake, string][]) {
    const p = await only(line, f);
    assert.deepEqual([p.outcome, p.reason], ['unknown', reason], JSON.stringify(f));
  }
  const none = await scan([page('1', rev(line))], null);
  assert.equal(none.revisionStaleness.checkout, 'not-given');
  assert.deepEqual([none.revisionStaleness.pages[0].outcome, none.revisionStaleness.pages[0].reason], ['unknown', 'checkout-not-given']);
  assert.equal(none.revisionStaleness.comparedSha, null);
  assert.equal(none.revisionStaleness.counts.unknown, 1);
});
test('T7g a page with mixed bindings takes the worst outcome; git is asked once per commit and path set', async () => {
  const fake = probe({ rows: [] });
  const two = rev(`alpha@${A} -- src/a.mts`) + `<p>Revision: alpha@${B}</p><p>Revision: beta@${A} -- x.mts</p>`;
  const r = await scan([page('1', two), page('2', rev(`alpha@${A} -- src/a.mts`))], fake);
  const [one] = r.revisionStaleness.pages;
  assert.deepEqual(one.bindings.map(b => b.outcome), ['current', 'unscoped', 'unknown']);
  assert.deepEqual([one.outcome, one.reason], ['unknown', 'repository-not-checked-out']);
  assert.equal(fake.log.filter(l => l === 'diff a src/a.mts').length, 1, 'cached across pages');
  assert.equal(fake.log.filter(l => l === 'commit a').length, 1);
});
test('eligibility: confirmed observation or knowledge pages with a bound line; others are counted, not judged', async () => {
  const line = rev(`alpha@${A} -- src/a.mts`);
  const r = await scan([page('1', line), page('2', line, ['type-knowledge', 'evidence-confirmed']), page('3', line, ['type-observation', 'evidence-assumed']),
    page('4', rev('none (no exact binding: no repository)')), page('5', line, ['evidence-confirmed'])]);
  assert.deepEqual(r.revisionStaleness.pages.map(p => p.pageId), ['1', '2']);
  assert.equal(r.revisionStaleness.counts.notEligible, 3);
});
test('T8 a partially read space reports coverage and unread pages, never a space-wide count', async () => {
  const pages = [page('1', rev(`alpha@${A} -- src/a.mts`)), page('2', rev(`alpha@${A} -- src/b.mts`))];
  const { session } = harness(pages, spec => spec.path.startsWith('/wiki/api/v2/pages/2') || /\/pages\/2(?:[/?]|$)/.test(spec.path));
  const r = await scanDrainage(session, { ...opts, staleness: { probe: probe({ rows: [{ status: 'M', path: 'src/a.mts' }] }), ref: 'HEAD' } });
  assert.equal(r.inventory.status, 'partial');
  assert.equal(r.revisionStaleness.coverage, 'partial');
  assert.equal(r.revisionStaleness.counts.notRead, 1);
  assert.deepEqual(r.revisionStaleness.pages.map(p => p.pageId), ['1']);
  assert.deepEqual(r.candidates.filter(c => c.problem === 'revision-stale').map(c => c.pageId), ['1']);
  assert.ok(r.limitations.some(l => /signal to re-measure, not a refutation/.test(l)));
});
function cli(pages: ReturnType<typeof page>[], args: Record<string, string>, exec: (args: string[]) => string | Error) {
  const { session } = harness(pages);
  const seen: string[][] = [], out: string[] = [];
  const ctx = { log: (line: string) => { out.push(line); }, now: () => 1000 } as never;
  return { seen, out, run: () => cmdDrainage(ctx, { space: 'KB', 'metadata-approved': undefined, ...args }, { session,
    exec: async (file, a) => { assert.equal(file, 'git'); seen.push(a); const r = exec(a); if (r instanceof Error) throw r; return { stdout: r, stderr: '' }; } }) };
}
test('CLI: D5 exit 2 when the checkout cannot answer; every git call is read-only; --ref is validated', async () => {
  const pages = [page('1', rev(`alpha@${A} -- src/a.mts`))];
  const git = (fail: string) => (a: string[]) => a.includes(fail) ? new Error('fatal: synthetic') : a[2] === 'rev-parse' && a[3] === '--show-toplevel' ? '/w/alpha\n'
    : a.includes('--is-shallow-repository') ? 'false\n' : a[2] === 'rev-parse' ? `${HEAD}\n` : a.includes('-t') ? 'commit\n' : a[2] === 'merge-base' ? `${A}\n` : '';
  const ok = cli(pages, { 'repo-root': '/w/alpha' }, git('none'));
  assert.equal(await ok.run(), 0);
  assert.ok(ok.seen.every(a => a[0] === '-C' && ['rev-parse', 'cat-file', 'merge-base', 'diff'].includes(a[2])), JSON.stringify(ok.seen));
  assert.ok(ok.seen.some(a => a.includes(':(literal)src/a.mts')));
  assert.equal(JSON.parse(ok.out[0]).revisionStaleness.pages[0].outcome, 'current');
  assert.equal(await cli(pages, { 'repo-root': '/w/alpha' }, git('diff')).run(), 2, 'git-failed forces exit 2');
  assert.equal(await cli(pages, {}, git('none')).run(), 0, 'no checkout: unknown but not a failure');
  for (const ref of ['a..b', 'HEAD@{1}', '-x', 'a b', 'main~1']) await assert.rejects(() => cli(pages, { 'repo-root': '/w', ref }, git('none')).run(), /--ref/, ref);
  await assert.rejects(() => cli(pages, { ref: 'main' }, git('none')).run(), /--ref needs --repo-root/);
});
test('no write path: the staleness modules import no label, update or write verb', () => {
  for (const file of ['confluence-revision-staleness.mts', 'confluence-revision-staleness-git.mts']) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
    assert.doesNotMatch(source, /labels?-cli|updatePage|setLabels|'PUT'|'POST'|'DELETE'|writeFile|node:fs/, file);
  }
});

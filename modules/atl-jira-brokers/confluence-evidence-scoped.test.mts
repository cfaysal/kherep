// Issue #693 T9: a scoped Revision line leaves the confirm gates unchanged; they compare the core.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaim, decide, revisionLines, type Measurement } from './confluence-evidence.mts';
import { drainageRules } from './confluence-drainage-rules.mts';

const SHA = 'a'.repeat(40), CORE = `alpha@${SHA}`;
const NOW = new Date(2026, 9, 22, 12).getTime();
const FOOTER = '<h2>Related pages</h2>';
const LABELS = ['type-observation', 'evidence-assumed', 'status-author-model', 'runtime-claude-code-win'];
const SCOPED = `<p>Revision: ${CORE} -- src/queue.mts</p><p>Code: src/queue.mts retries on receipt</p>${FOOTER}`;
const claim = (body: string) => classifyClaim({ id: '1', version: 3, spaceId: '9', body, labels: LABELS }, true);
const M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'code', source: 'alpha (git checkout)', sourceClass: 'repository',
  command: `git show ${SHA}:src/queue.mts`, excerpt: '12: retry(receipt)', measuredAt: '2026-10-22', verdict: 'reproduces',
  revision: CORE, ...over } as Measurement);
const OPT = { now: NOW, repoRoot: '/x/alpha', repoTopLevel: '/x/alpha', revisionExists: (sha: string) => sha === SHA };

test('T9 a scoped page confirms on its core and carries the paths in the claim', () => {
  const c = claim(SCOPED);
  assert.deepEqual(c.revisions, { bound: [CORE], unbound: [], malformed: [], paths: { [CORE]: ['src/queue.mts'] } });
  const d = decide(c, M(), OPT);
  assert.equal(d.outcome, 'confirmed');
  assert.equal(d.measuredRevision, CORE);
  assert.equal(decide(c, M({ revision: `${CORE} -- src/queue.mts` }), OPT).reason, 'revision-malformed', 'a measurement names the core only');
});
test('T9 a superseding page with a scoped line binds its core', () => {
  const other = `beta@${'b'.repeat(40)}`;
  const page = { id: '77', title: 'Queue retry moved', spaceId: '9', spaceKey: 'KB',
    bound: revisionLines(`<p>Revision: ${CORE} -- src/retry.mts</p>`).bound };
  const unbound = claim(`<p>Revision: none (no exact binding: no repository)</p><p>Code: src/queue.mts</p>${FOOTER}`);
  const d = decide(unbound, M({ verdict: 'contradicts', supersededBy: '77' }), { ...OPT, superseded: page });
  assert.equal(d.outcome, 'superseded');
  assert.equal(decide(unbound, M({ verdict: 'contradicts', supersededBy: '77' }),
    { ...OPT, superseded: { ...page, bound: [other] } }).reason, 'superseded-page-not-bound');
});
test('T9 the drainage format rule accepts a scoped confirmed page and flags a bad path list', () => {
  const snap = (id: string, body: string) => ({ id, version: 3, title: id, spaceId: '9', parentId: null, body,
    labels: ['type-observation', 'evidence-confirmed'] });
  const flagged = drainageRules([snap('1', SCOPED), snap('2', SCOPED.replace('src/queue.mts</p>', 'src/*.mts</p>'))], false)
    .filter(c => c.problem === 'revision-missing-or-invalid').map(c => c.pageId);
  assert.deepEqual(flagged, ['2']);
});

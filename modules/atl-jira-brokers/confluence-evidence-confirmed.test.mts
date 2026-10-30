// Issue #695: the evidence verb on a confirmed page. A contradicting measurement refutes it at the bound
// revision and supersedes it at a newer one; a holding measurement is a no-op. Synthetic bodies only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaim, decide, insertBeforeFooter, MEASUREMENT_BLOCK, renderMeasurementBlock, type Measurement,
  type SupersedingPage } from './confluence-evidence.mts';
import { PROPOSED } from './confluence-evidence-report.mts';
import { drainageRules } from './confluence-drainage-rules.mts';

const B = 'a'.repeat(40), R = 'c'.repeat(40);
const NOW = new Date(2026, 9, 22, 12).getTime();
const TODAY = '2026-10-22';
const FOOTER = '<h2>Related pages</h2>';
const RUNTIME = 'runtime-claude-code-win';
const CONFIRMED = ['type-observation', 'evidence-confirmed', 'status-author-model', RUNTIME];
const with_ = (evidence: string, author = 'status-author-model') => ['type-observation', evidence, author, RUNTIME];
const CODE = `<p>Revision: alpha@${B}</p><p>Code: src/queue.mts</p><p>Queue retries keep receipt identity.</p>${FOOTER}`;
const snap = (body: string, labels: string[]) => ({ id: '1', version: 3, title: 't', spaceId: '9', parentId: null, body, labels });
const claim = (body = CODE, labels = CONFIRMED) => classifyClaim(snap(body, labels), true);
const M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'code', source: 'alpha (git checkout)', sourceClass: 'repository',
  command: `git show ${B}:src/queue.mts`, excerpt: '12: retry(receipt)', measuredAt: TODAY, verdict: 'contradicts',
  revision: `alpha@${B}`, ...over } as Measurement);
const AT_R = (over: Record<string, unknown> = {}) => M({ revision: `alpha@${R}`, command: `git show ${R}:src/queue.mts`, ...over });
const OPT = (over: Record<string, unknown> = {}) => ({ now: NOW, repoRoot: '/x/alpha', repoTopLevel: '/x/alpha',
  revisionExists: () => true, revisionNewer: (rev: string) => rev === `alpha@${R}`, ...over });
const TARGET = (bound: string[], over: Partial<SupersedingPage> = {}): SupersedingPage => ({ id: '77', title: 'New page', spaceId: '9', spaceKey: 'K', bound, ...over });
const shape = (d: ReturnType<typeof decide>) => [d.outcome, d.reason, d.labelsAdd, d.labelsRemove];

test('T1 a contradiction at the bound revision refutes a confirmed page; the result stays valid for drainage', () => {
  const d = decide(claim(), M(), OPT());
  assert.deepEqual([...shape(d), d.measuredRevision], ['refuted', 'measured', ['evidence-refuted'], ['evidence-confirmed'], `alpha@${B}`]);
  const block = renderMeasurementBlock(d, M(), RUNTIME);
  assert.match(block, /<p>Outcome: refuted \(model-run, status-author-model unchanged\)<\/p><p>Revision: alpha@a{40}<\/p>/);
  assert.match(block, new RegExp(MEASUREMENT_BLOCK.source, 's'));
  const out = insertBeforeFooter(CODE, block);
  const after = with_('evidence-refuted');
  assert.deepEqual(drainageRules([snap(out, after)], true).filter(c => c.problem === 'revision-missing-or-invalid'), []);
  assert.deepEqual(claim(out, after).revisions.bound, [`alpha@${B}`]);
});

test('T2 a confirmed code page is superseded only by a same-space target binding the bound or a newer revision', () => {
  const sup = decide(claim(), AT_R({ supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${R}`]) }));
  assert.deepEqual([...shape(sup), sup.measuredRevision, sup.supersededBy],
    ['superseded', 'measured', ['evidence-superseded'], ['evidence-confirmed'], `alpha@${R}`, '77']);
  const block = renderMeasurementBlock(sup, AT_R({ supersededBy: '77' }), RUNTIME, TARGET([`alpha@${R}`]));
  assert.ok(block.includes(`<p>Revision: alpha@${R}</p>`) && block.includes('/wiki/spaces/K/pages/77">New page</a>'), block);
  assert.match(block, new RegExp(MEASUREMENT_BLOCK.source, 's'));
  // D2 equal-or-newer: a corrected finding at the bound commit, with a target binding it.
  assert.equal(decide(claim(), M({ supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${B}`]) })).outcome, 'superseded');
  const cases: [string, ReturnType<typeof decide>, string][] = [
    ['not newer, with target', decide(claim(), AT_R({ supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${R}`]), revisionNewer: () => false })), 'revision-not-newer'],
    ['no newer probe', decide(claim(), AT_R({ supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${R}`]), revisionNewer: undefined })), 'revision-not-newer'],
    ['target binds B, not R', decide(claim(), AT_R({ supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${B}`]) })), 'superseded-page-not-bound'],
    ['page binds B, target nothing', decide(claim(), M({ supersededBy: '77' }), OPT({ superseded: TARGET([]) })), 'superseded-page-not-bound'],
    ['other space', decide(claim(), AT_R({ supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${R}`], { spaceId: '8' }) })), 'superseded-other-space'],
    ['same page', decide(claim(), AT_R({ supersededBy: '1' }), OPT()), 'superseded-same-page'],
    ['no superseding page', decide(claim(), AT_R({ supersededBy: '77' }), OPT()), 'superseded-needs-page'],
    ['newer, no target', decide(claim(), AT_R(), OPT()), 'revision-not-on-page'],
    ['not newer, no target', decide(claim(), AT_R(), OPT({ revisionNewer: () => false })), 'revision-not-on-page'],
    ['reproduces at B with target', decide(claim(), M({ verdict: 'reproduces', supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${B}`]) })), 'superseded-needs-contradiction'],
    ['reproduces at R with target', decide(claim(), AT_R({ verdict: 'reproduces', supersededBy: '77' }), OPT({ superseded: TARGET([`alpha@${R}`]) })), 'superseded-needs-contradiction'],
  ];
  for (const [name, decision, reason] of cases) assert.deepEqual(shape(decision), ['unknown', reason, [], []], name);
});

test('T3 every existing measurement and revision refusal holds on a confirmed page', () => {
  const secret = ['sk', 'abcdefghijklmnop'].join('-');
  const unbound = CODE.replace(FOOTER, `<p>Revision: none (no exact binding: dirty tree)</p>${FOOTER}`);
  const cases: [string, ReturnType<typeof decide>, string][] = [
    ['stale', decide(claim(), M({ measuredAt: '2026-10-19' }), OPT()), 'measurement-stale'],
    ['future', decide(claim(), M({ measuredAt: '2026-10-23' }), OPT()), 'measurement-in-future'],
    ['secret', decide(claim(), M({ excerpt: `12: ${secret}` }), OPT()), 'excerpt-secret-marker'],
    ['control chars', decide(claim(), M({ excerpt: '12: \x1b[31mretry' }), OPT()), 'excerpt-control-chars'],
    ['unknown field', decide(claim(), M({ newRevision: `alpha@${R}` }), OPT()), 'measurement-unknown-field'],
    ['forbidden source', decide(claim(), M({ sourceClass: 'brain-page' }), OPT()), 'measurement-source-forbidden'],
    ['kind mismatch', decide(claim(), M({ kind: 'doc', sourceClass: 'official-doc' }), OPT()), 'kind-mismatch'],
    ['unrelated', decide(claim(), M({ command: 'npm test', excerpt: '# pass 42' }), OPT()), 'measurement-does-not-touch-claim'],
    ['no repo root', decide(claim(), M(), OPT({ repoRoot: undefined })), 'revision-not-verified'],
    ['other checkout', decide(claim(), M(), OPT({ repoTopLevel: '/x/other' })), 'repo-root-name-mismatch'],
    ['not in repository', decide(claim(), M(), OPT({ revisionExists: () => false })), 'revision-not-in-repository'],
    ['dirty', decide(claim(), M({ revision: `alpha@${B} (no exact binding: dirty tree)` }), OPT()), 'revision-dirty'],
    ['malformed', decide(claim(), M({ revision: B }), OPT()), 'revision-malformed'],
    ['missing revision', decide(claim(), M({ revision: undefined }), OPT()), 'revision-missing'],
    ['unbound line, reproduces', decide(claim(unbound), M({ verdict: 'reproduces' }), OPT()), 'revision-unbound-on-page'],
    ['no measurement', decide(claim(), undefined, OPT()), 'no-measurement'],
    ['not body-approved', decide(classifyClaim(snap(CODE, CONFIRMED), false), M(), OPT()), 'record-not-body-approved'],
  ];
  for (const [name, decision, reason] of cases) assert.deepEqual(shape(decision), ['unknown', reason, [], []], name);
});

const TRK = `<p>Tracker: KEY-12 holds the queue retry fix.</p>${FOOTER}`;
const KEY12 = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'tracker', source: 'KEY-12', sourceClass: 'tracker',
  command: 'node tools/atl-jira-ccoder.mts get --key KEY-12', excerpt: 'key: KEY-12\nstate: To Do', measuredAt: TODAY, verdict: 'contradicts', ...over } as Measurement);
const LIVE = `<p>Host: alpha-node</p><p>The queue service listens on port 8443.</p>${FOOTER}`;
const LIVE_M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'live', source: 'alpha-node/queue', sourceClass: 'target-host',
  command: 'ss -ltn | grep -E "8443|8080"', excerpt: 'LISTEN 0 4096 *:8080', measuredAt: TODAY, verdict: 'contradicts', subject: '8443', ...over } as Measurement);
const DOC = `<p>Doc: https://developer.atlassian.com/cloud/x</p><p>The endpoint pages at 250 results.</p>${FOOTER}`;
const DOC_M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'doc', source: 'developer.atlassian.com', sourceClass: 'official-doc',
  command: 'curl -s https://developer.atlassian.com/cloud/x', excerpt: 'limit: maximum 250', measuredAt: TODAY, verdict: 'contradicts', subject: '250', ...over } as Measurement);

test('T4 tracker, live and doc confirmed pages: refuted, superseded or holds; a partial tracker read touches nothing', () => {
  for (const [name, body, m] of [['tracker', TRK, KEY12], ['live', LIVE, LIVE_M], ['doc', DOC, DOC_M]] as const) {
    const c = claim(body);
    assert.equal(c.kind, name);
    assert.deepEqual(shape(decide(c, m(), OPT())), ['refuted', 'measured', ['evidence-refuted'], ['evidence-confirmed']], name);
    const sup = decide(c, m({ supersededBy: '77' }), OPT({ superseded: TARGET([]) }));
    assert.deepEqual([...shape(sup), sup.supersededBy], ['superseded', 'measured', ['evidence-superseded'], ['evidence-confirmed'], '77'], name);
    assert.equal(decide(c, m({ supersededBy: '77' }), OPT({ superseded: TARGET([], { spaceId: '8' }) })).reason, 'superseded-other-space', name);
    assert.deepEqual(shape(decide(c, m({ verdict: 'reproduces' }), OPT())), ['holds', 'measured', [], []], name);
    assert.equal(decide(c, m({ verdict: 'reproduces' }), OPT()).measuredRevision, undefined, name);
  }
  const two = claim(`<p>Tracker: KEY-12 and KEY-13 hold the queue retry fix.</p>${FOOTER}`);
  assert.equal(decide(two, KEY12(), OPT()).reason, 'measurement-does-not-touch-claim');
});

test('T5 a holding measurement of a confirmed page is a no-op with outcome holds, at the bound or a newer revision', () => {
  assert.deepEqual(decide(claim(), M({ verdict: 'reproduces' }), OPT()),
    { outcome: 'holds', reason: 'measured', labelsAdd: [], labelsRemove: [], measuredRevision: `alpha@${B}` });
  assert.deepEqual(decide(claim(), AT_R({ verdict: 'reproduces' }), OPT()),
    { outcome: 'holds', reason: 'measured', labelsAdd: [], labelsRemove: [], measuredRevision: `alpha@${R}` });
  assert.equal(decide(claim(), AT_R({ verdict: 'reproduces' }), OPT({ revisionNewer: () => false })).reason, 'revision-not-on-page');
  assert.equal(PROPOSED.includes('holds'), false);
});

test('T6 final pages are already decided; malformed and person-assigned labels keep their refusals; assumed pages unchanged', () => {
  for (const label of ['evidence-refuted', 'evidence-superseded']) {
    for (const verdict of ['reproduces', 'contradicts']) {
      assert.deepEqual(shape(decide(claim(CODE, with_(label)), M({ verdict }), OPT())), ['unknown', 'page-already-decided', [], []], `${label} ${verdict}`);
    }
  }
  assert.equal(decide(claim(CODE, [...CONFIRMED, 'evidence-refuted']), M(), OPT()).reason, 'labels-malformed');
  for (const author of ['status-author-verified', 'status-author-operator']) {
    assert.deepEqual(shape(decide(claim(CODE, with_('evidence-confirmed', author)), M(), OPT())), ['reported-only', 'status-author-not-model', [], []], author);
  }
  const assumed = with_('evidence-assumed');
  assert.deepEqual(shape(decide(claim(CODE, assumed), M({ verdict: 'reproduces' }), OPT())), ['confirmed', 'measured', ['evidence-confirmed'], ['evidence-assumed']]);
  assert.deepEqual(shape(decide(claim(CODE, assumed), M(), OPT())), ['refuted', 'measured', ['evidence-refuted'], ['evidence-assumed']]);
  // revisionNewer is a confirmed-page rule only: an assumed page measured at a newer commit stays revision-not-on-page.
  assert.equal(decide(claim(CODE, assumed), AT_R(), OPT()).reason, 'revision-not-on-page');
  assert.equal(decide(claim(CODE, assumed), M({ verdict: 'reproduces', supersededBy: '77' }), OPT({ superseded: TARGET([]) })).outcome, 'confirmed');
});

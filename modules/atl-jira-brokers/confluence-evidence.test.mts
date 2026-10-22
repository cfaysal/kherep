// Pure gates of the confirm path (issue #519). Synthetic storage bodies only;
// secret samples are assembled at runtime so no file carries a literal marker.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyClaim, decide, evidenceLabelsOk, insertBeforeFooter, renderMeasurementBlock, renderReport,
  type Measurement,
} from './confluence-evidence.mts';
import { drainageRules } from './confluence-drainage-rules.mts';

const SHA = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 22, 12).getTime();
const pad = (n: number) => String(n).padStart(2, '0');
const day = (offset = 0) => { const d = new Date(NOW + offset * DAY); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const FOOTER = '<h2>Related pages</h2><ul><li>x</li></ul>';
const BASE = `<p>Revision: alpha@${SHA}</p><p>Code: src/queue.mts</p><p>Queue retries keep receipt identity.</p>`;
const LABELS = ['type-observation', 'evidence-assumed', 'status-author-model', 'runtime-claude-code-win'];
const LIVE = '<p>Host: alpha-node</p><p>The queue service listens on port 8443.</p>';
const snap = (body = BASE + FOOTER, labels = LABELS) => ({ id: '1', version: 3, title: 'Synthetic title', spaceId: '9', parentId: null, body, labels });
const claim = (body?: string, labels?: string[], approved = true) => classifyClaim(snap(body, labels), approved);
const M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'code', source: 'alpha (git checkout)', sourceClass: 'repository',
  command: `git -C /x/alpha show ${SHA}:src/queue.mts | grep -n retry`, excerpt: '12: retry(receipt)', measuredAt: day(),
  verdict: 'reproduces', revision: `alpha@${SHA}`, ...over } as Measurement);
const LIVE_M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'live', source: 'alpha-node/queue', sourceClass: 'target-host',
  command: 'ss -ltn | grep -E "8443|8080"', excerpt: 'LISTEN 0 4096 *:8080', measuredAt: day(), verdict: 'contradicts', subject: '8443', ...over } as Measurement);
const OPT = (over: Record<string, unknown> = {}) => ({ now: NOW, repoRoot: '/x/alpha', repoTopLevel: '/x/alpha',
  revisionExists: (sha: string) => sha === SHA, ...over });
const SUPER = { id: '77', title: 'New <page> & co', spaceId: '9', spaceKey: 'K' };

test('confirmedCode: label diff, one block before the footer, prefix and original Revision line unchanged', () => {
  const d = decide(claim(), M(), OPT());
  assert.equal(d.outcome, 'confirmed');
  assert.deepEqual([d.labelsAdd, d.labelsRemove], [['evidence-confirmed'], ['evidence-assumed']]);
  const block = renderMeasurementBlock(d, M(), 'runtime-claude-code-win');
  assert.match(block, /^<h2>Measurement \d{4}-\d{2}-\d{2}<\/h2><p>Outcome: confirmed \(model-run, status-author-model unchanged\)<\/p>/);
  const out = insertBeforeFooter(BASE + FOOTER, block);
  assert.ok(out.startsWith(BASE) && out.endsWith(FOOTER));
  assert.equal(out.match(/<h2>Measurement /g)?.length, 1);
  assert.ok(out.indexOf('<h2>Measurement') < out.indexOf('<h2>Related pages</h2>'));
  assert.equal(out.slice(0, BASE.length).split(`<p>Revision: alpha@${SHA}</p>`).length - 1, 1);
  assert.equal(insertBeforeFooter('<p>x</p>', block), `<p>x</p>${block}`);
});

test('Defect 1: promoted bodies stay valid for drainage; unbound lines block only an in-place confirmation', () => {
  const d = decide(claim(), M(), OPT());
  const out = insertBeforeFooter(BASE + FOOTER, renderMeasurementBlock(d, M(), 'runtime-claude-code-win'));
  const after = ['type-observation', 'evidence-confirmed', 'status-author-model', 'runtime-claude-code-win'];
  assert.deepEqual(drainageRules([snap(out, after)], true).filter(c => c.problem === 'revision-missing-or-invalid'), []);
  const unbound = BASE + '<p>Revision: none (no exact binding: dirty tree)</p>' + FOOTER;
  const blocked = decide(claim(unbound), M(), OPT());
  assert.deepEqual([blocked.outcome, blocked.reason], ['unknown', 'revision-unbound-on-page']);
  const dirty = BASE + `<p>Revision: beta@${SHA} (no exact binding: dirty tree)</p>` + FOOTER;
  assert.equal(decide(claim(dirty), M(), OPT()).reason, 'revision-unbound-on-page');
  assert.equal(decide(claim(unbound), M({ verdict: 'contradicts' }), OPT()).outcome, 'refuted');
});

test('refutedLive and the superseded variant', () => {
  const c = claim(LIVE + FOOTER);
  assert.equal(c.kind, 'live');
  const refuted = decide(c, LIVE_M(), OPT());
  assert.deepEqual([refuted.outcome, refuted.labelsAdd], ['refuted', ['evidence-refuted']]);
  const sup = decide(c, LIVE_M({ supersededBy: '77' }), OPT({ superseded: SUPER }));
  assert.deepEqual([sup.outcome, sup.labelsAdd, sup.labelsRemove], ['superseded', ['evidence-superseded'], ['evidence-assumed']]);
  const block = renderMeasurementBlock(sup, LIVE_M({ supersededBy: '77' }), 'runtime-codex-mac', SUPER);
  assert.ok(block.includes('<a href="/wiki/spaces/K/pages/77">New &lt;page&gt; &amp; co</a>'));
  assert.ok(!block.includes('Revision:'));
  assert.equal(decide(c, LIVE_M({ supersededBy: '1' }), OPT()).reason, 'superseded-same-page');
  assert.equal(decide(c, LIVE_M({ supersededBy: '77' }), OPT()).reason, 'superseded-needs-page');
  assert.equal(decide(c, LIVE_M({ supersededBy: '77' }), OPT({ superseded: { ...SUPER, spaceId: '8' } })).reason, 'superseded-other-space');
});

test('historical, no measurement and excluded private records stay unknown', () => {
  const hist = claim('<p>Historical measurement from the queue rollout: delivery stalled twice.</p>');
  assert.equal(hist.kind, 'historical');
  assert.deepEqual([decide(hist, undefined, OPT()).outcome, decide(hist, undefined, OPT()).reason], ['unknown', 'historical-not-repeatable']);
  const none = decide(claim(), undefined, OPT());
  assert.deepEqual([none.outcome, none.reason, none.labelsAdd, none.labelsRemove], ['unknown', 'no-measurement', [], []]);
  const report = renderReport([{ pageId: '5', excluded: 'private', reason: 'private-no-local-route' }]);
  assert.match(report, /excluded: private/);
  assert.match(report, /private-no-local-route/);
  assert.doesNotMatch(report, /sha256|bodySha/i);
});

test('malformed and refused inputs give unknown with the exact reason, never confirmed', () => {
  const cases: [string, () => ReturnType<typeof decide>, string][] = [
    ['bare SHA', () => decide(claim(), M({ revision: SHA }), OPT()), 'revision-malformed'],
    ['dirty revision', () => decide(claim(), M({ revision: `alpha@${SHA} (no exact binding: dirty tree)` }), OPT()), 'revision-dirty'],
    ['missing revision', () => decide(claim(), M({ revision: undefined }), OPT()), 'revision-missing'],
    ['not on page', () => decide(claim(), M({ revision: `alpha@${SHA_B}` }), OPT({ revisionExists: () => true })), 'revision-not-on-page'],
    ['newRevision', () => decide(claim(), M({ newRevision: `alpha@${SHA_B}` }), OPT()), 'measurement-unknown-field'],
    ['not in repository', () => decide(claim(), M(), OPT({ revisionExists: () => false })), 'revision-not-in-repository'],
    ['no repo root', () => decide(claim(), M(), OPT({ repoRoot: undefined })), 'revision-not-verified'],
    ['other repo', () => decide(claim(), M(), OPT({ repoTopLevel: '/x/other' })), 'repo-root-name-mismatch'],
    ...['brain-page', 'search-summary', 'peer-report', 'paraphrase', 'memory', 'wiki'].map(sourceClass =>
      [sourceClass, () => decide(claim(), M({ sourceClass }), OPT()), 'measurement-source-forbidden'] as [string, () => ReturnType<typeof decide>, string]),
    ['empty excerpt', () => decide(claim(), M({ excerpt: '' }), OPT()), 'measurement-incomplete'],
    ['4001 chars', () => decide(claim(), M({ excerpt: 'src/queue.mts '.padEnd(4001, 'x') }), OPT()), 'excerpt-too-long'],
    ['stale', () => decide(claim(), M({ measuredAt: day(-3) }), OPT()), 'measurement-stale'],
    ['future', () => decide(claim(), M({ measuredAt: day(1) }), OPT()), 'measurement-in-future'],
    ['kind mismatch', () => decide(claim(), M({ kind: 'doc', sourceClass: 'official-doc' }), OPT()), 'kind-mismatch'],
    ['two evidence labels', () => decide(claim(undefined, [...LABELS, 'evidence-confirmed']), M(), OPT()), 'labels-malformed'],
    ['no evidence label', () => decide(claim(undefined, LABELS.filter(l => l !== 'evidence-assumed')), M(), OPT()), 'labels-malformed'],
    ['no type label', () => decide(claim(undefined, LABELS.slice(1)), M(), OPT()), 'page-not-eligible'],
    ['unrelated green test', () => decide(claim(), M({ command: 'npm test', excerpt: '# pass 42' }), OPT()), 'measurement-does-not-touch-claim'],
    ['already confirmed', () => decide(claim(undefined, ['type-observation', 'evidence-confirmed', 'status-author-model']), M(), OPT()), 'page-not-assumed'],
    ['not body-approved', () => decide(claim(undefined, undefined, false), M(), OPT()), 'record-not-body-approved'],
  ];
  for (const [name, run, reason] of cases) {
    const d = run();
    assert.equal(d.reason, reason, name);
    assert.equal(d.outcome, 'unknown', name);
    assert.deepEqual([d.labelsAdd, d.labelsRemove], [[], []], name);
  }
  assert.equal(decide(claim(), M({ measuredAt: day(-3) }), OPT({ maxAgeDays: 7 })).outcome, 'confirmed');
  for (const author of ['status-author-operator', 'status-author-verified']) {
    const d = decide(claim(undefined, [...LABELS.filter(l => l !== 'status-author-model'), author]), M(), OPT());
    assert.deepEqual([d.outcome, d.reason, d.labelsAdd, d.labelsRemove], ['reported-only', 'status-author-not-model', [], []]);
  }
});

const SAMPLES = ['sk-' + 'A'.repeat(12), 'Bearer ' + 'abc.def', 'eyJ' + 'hbGciOi.eyJzdWIi.c2ln',
  'https://' + 'user:pass' + '@example.org/repo', 'https://' + 'tokenvalue123' + '@example.org/repo',
  'https://example.org/x?access_' + 'token=zzz', '-----BEGIN ' + 'PRIVATE KEY-----', 'ENC[' + 'AES256_GCM,data:x]',
  'AS' + 'IA' + 'Q'.repeat(16)];

test('Defect 4: every secret marker refuses the excerpt without echoing it', () => {
  for (const sample of SAMPLES) {
    const m = M({ excerpt: `12: retry(receipt) ${sample}` });
    const d = decide(claim(), m, OPT());
    assert.deepEqual([d.outcome, d.reason], ['unknown', 'excerpt-secret-marker'], sample);
    const report = renderReport([{ pageId: '1', readVersion: 3, claim: claim(), measurement: m, decision: d }]);
    assert.ok(!d.reason.includes(sample) && !report.includes(sample), sample);
  }
  assert.equal(decide(claim(), M({ excerpt: '12: retry(receipt) https://example.org/path?page=2' }), OPT()).outcome, 'confirmed');
  assert.equal(decide(claim(), M({ command: `curl -H 'Bearer x' src/queue.mts` }), OPT()).reason, 'excerpt-secret-marker');
});

test('a format-only repair never promotes and leaves drainage without a revision candidate', () => {
  const broken = snap('<p>Revision: dirty-tree</p><p>Code: src/queue.mts</p>');
  assert.equal(drainageRules([broken], false).filter(c => c.problem === 'revision-missing-or-invalid').length, 1);
  const repaired = `<p>Revision: alpha@${SHA}</p><p>Code: src/queue.mts</p>`;
  assert.deepEqual(drainageRules([snap(repaired)], false), []);
  const d = decide(claim(repaired), undefined, OPT());
  assert.deepEqual([d.reason, d.labelsAdd], ['no-measurement', []]);
});

test('evidenceLabelsOk requires exactly the outcome label', () => {
  assert.equal(evidenceLabelsOk(['evidence-assumed', 'evidence-confirmed'], 'confirmed'), false);
  assert.equal(evidenceLabelsOk(['evidence-confirmed', 'type-observation'], 'confirmed'), true);
  assert.equal(evidenceLabelsOk(['evidence-refuted'], 'confirmed'), false);
  assert.equal(evidenceLabelsOk(['type-observation'], 'confirmed'), false);
});

test('renderReport: verbatim proposals, passive labels, no titles or bodies, deterministic', () => {
  const passive = [...LABELS, 'currency-uncertain', 'origin-wiki'];
  const c = claim(undefined, passive);
  const confirmed = { pageId: '1', readVersion: 3, title: 'Synthetic title', body: BASE, claim: c, measurement: M(), decision: decide(c, M(), OPT()) };
  const staleM = M({ measuredAt: day(-5), excerpt: '12: stale-only output' });
  const unknown = { pageId: '2', readVersion: 4, claim: c, measurement: staleM, decision: decide(c, staleM, OPT()) };
  const reported = claim(undefined, [...LABELS.slice(0, 2), 'status-author-operator']);
  const records = [unknown, confirmed, { pageId: '3', readVersion: 1, claim: reported, decision: decide(reported, M(), OPT()) },
    { pageId: '4', excluded: 'private', reason: 'private-local-result-not-returned' }, { pageId: '6', readVersion: 2, claim: c }];
  const report = renderReport(records);
  assert.equal(report, renderReport(records));
  assert.ok(!report.includes('Synthetic title') && !report.includes('receipt identity'));
  for (const text of [M().command, M().excerpt, 'verdict: reproduces', '+evidence-confirmed / -evidence-assumed',
    'passive labels: currency-uncertain, origin-wiki', 'measurement-stale', 'reported-only']) assert.ok(report.includes(text), text);
  assert.ok(!report.includes('stale-only output'), 'unknown records print no excerpt');
  for (const line of report.split('\n').filter(l => l.startsWith('- label diff:'))) assert.doesNotMatch(line, /currency|origin/);
  assert.match(report, /confirmed: 1\n- refuted: 0\n- superseded: 0\n- unknown: 1 \(measurement-stale: 1\)\n- reported-only: 1\n- excluded: 1\n- failed: 1/);
  assert.match(report, /not a Brain-confirmed verdict/);
  assert.ok(report.indexOf('## Page 1') < report.indexOf('## Page 2'));
});

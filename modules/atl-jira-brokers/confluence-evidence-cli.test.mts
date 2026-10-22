// The evidence verb's I/O boundary: injected session, git and file writes only.
// Nothing here reaches a network, a real repository or a Confluence page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './atl-confluence-ccoder.mts';
import { BODY, decideArgs, harness, LABELS, MEASUREMENT, prepareArgs as prepare, prepared, SHA, TODAY } from './confluence-evidence-cli.fixture.mts';
import { runtimeLabel } from './confluence-runtime-label.mts';

test('Defect 5: prepare refuses without body approval or with an --out inside a work tree, before any request', async () => {
  const h = harness();
  await assert.rejects(() => h.run({ mode: 'prepare', id: '1', space: 'K', out: '/tmp/ev/r.json' }), /body-approved/);
  await assert.rejects(() => h.run({ ...prepare, out: '/repo/notes/r.json' }), /out-inside-repository/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.files.size, 0);
});

test('Defect 5: only git\'s explicit "not a git repository" counts as outside; any other git error refuses', async () => {
  const h = harness();
  await assert.rejects(() => h.run({ ...prepare, out: '/dubious/r.json' }), /cannot be shown to lie outside/);
  const decided = await prepared();
  await assert.rejects(() => decided.run({ ...decideArgs, 'out-body': '/dubious/b.xml' }), /cannot be shown to lie outside/);
  assert.deepEqual([h.calls.length, h.files.size, decided.calls.length, decided.files.has('/dubious/b.xml')], [0, 0, 0, false]);
  assert.equal(await h.run(prepare), 0, 'fatal: not a git repository is the explicit negative');
});

test('prepare reads with GET only, prints metadata only and writes body and title to the record', async () => {
  const h = harness();
  assert.equal(await h.run(prepare), 0);
  assert.ok(h.calls.length > 0);
  const printed = h.out.join('\n');
  assert.ok(!printed.includes('Synthetic title') && !printed.includes('receipt identity') && !printed.includes('src/queue.mts'));
  assert.match(printed, /kind: code/);
  const record = JSON.parse(h.files.get('/tmp/ev/r.json') ?? '{}');
  assert.equal(record.title, 'Synthetic title');
  assert.equal(record.body, BODY);
  assert.equal(record.claim.bodyApproved, true);
});

test('decide performs zero requests, writes the body and appends the decision; exit codes 0 and 2', async () => {
  const h = await prepared();
  assert.equal(await h.run(decideArgs), 0);
  assert.equal(h.calls.length, 0);
  assert.ok(h.files.get('/tmp/ev/b.xml')?.includes('<h2>Measurement 2026-10-22</h2>'));
  const record = JSON.parse(h.files.get('/tmp/ev/r.json') ?? '{}');
  assert.equal(record.decision.outcome, 'confirmed');
  assert.deepEqual(record.labelsAfter, ['evidence-confirmed', 'runtime-claude-code-win', 'status-author-model', 'type-observation']);
  const stale = await prepared(harness(), { ...MEASUREMENT, measuredAt: '2026-10-10' });
  assert.equal(await stale.run(decideArgs), 2);
  assert.equal(stale.files.has('/tmp/ev/b.xml'), false);
  assert.match(stale.out.join('\n'), /reason: measurement-stale/);
});

test('Defect 4 and 5: a secret marker writes no body; --out-body inside a work tree exits before reading', async () => {
  const h = await prepared(harness(), { ...MEASUREMENT, excerpt: 'Bearer ' + 'abc' });
  assert.equal(await h.run(decideArgs), 2);
  assert.equal(h.files.has('/tmp/ev/b.xml'), false);
  assert.ok(!h.out.join('\n').includes('abc'));
  const inside = await prepared();
  await assert.rejects(() => inside.run({ ...decideArgs, 'out-body': '/repo/b.xml' }), /out-inside-repository/);
  assert.equal(inside.files.has('/repo/b.xml'), false);
});

test('--superseded-by needs body approval, then one GET, and refuses another space', async () => {
  const contradicts = { ...MEASUREMENT, verdict: 'contradicts' };
  const h = await prepared(harness({ '1': { body: BODY, labels: LABELS }, '77': { body: '<p>x</p>', labels: [] } }), contradicts);
  await assert.rejects(() => h.run({ ...decideArgs, 'superseded-by': '77' }), /body-approved/);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.run({ ...decideArgs, 'superseded-by': '77', 'body-approved': undefined }), 0);
  assert.equal(h.calls.length, 1);
  assert.match(h.files.get('/tmp/ev/b.xml') ?? '', /pages\/77">Synthetic title<\/a>/);
  const other = await prepared(harness({ '1': { body: BODY, labels: LABELS }, '78': { body: '', labels: [], spaceId: '8' } }), contradicts);
  assert.equal(await other.run({ ...decideArgs, 'superseded-by': '78', 'body-approved': undefined }), 2);
  assert.match(other.out.join('\n'), /superseded-other-space/);
});

test('--max-age-days above 7 exits 1 through the broker', async () => {
  const errors: string[] = [];
  const code = await runCli(['evidence', '--mode', 'decide', '--record', 'r.json', '--measurement', 'm.json', '--out-body', 'b.xml',
    '--max-age-days', '8'], { log: () => {}, logError: line => errors.push(line), readFile: async () => { throw new Error('unread'); } });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /max-age-days-above-cap/);
});

test('git receives only a validated 40-hex SHA', async () => {
  const bad = await prepared(harness(), { ...MEASUREMENT, revision: `alpha@${SHA}; touch x` });
  assert.equal(await bad.run(decideArgs), 2);
  assert.ok(!bad.execs.some(c => c.includes('cat-file')));
  const good = await prepared();
  assert.equal(await good.run(decideArgs), 0);
  const catFile = good.execs.filter(c => c.includes('cat-file'));
  assert.equal(catFile.length, 1);
  assert.ok(catFile.every(c => /^[0-9a-f]{40}$/.test(c.at(-1) ?? '')));
});

test('Defect 2: verify matches only the reviewed body with exactly the outcome label', async () => {
  const h = await prepared();
  assert.equal(await h.run(decideArgs), 0);
  const body = h.files.get('/tmp/ev/b.xml') ?? '';
  const verify = { mode: 'verify', record: '/tmp/ev/r.json', 'body-file': '/tmp/ev/b.xml' };
  const run = async (pageBody: string, labels: string[]) => {
    const v = harness({ '1': { body: pageBody, labels } });
    for (const [k, value] of h.files) v.files.set(k, value);
    return [await v.run(verify), v.out.at(-1)];
  };
  const after: string[] = JSON.parse(h.files.get('/tmp/ev/r.json') ?? '{}').labelsAfter;
  assert.deepEqual(after, ['evidence-confirmed', 'runtime-claude-code-win', 'status-author-model', 'type-observation']);
  assert.deepEqual(await run(body, [...after].reverse()), [0, 'readback: match']);
  assert.deepEqual(await run(body, [...after, 'evidence-assumed']), [2, 'readback: mismatch labels (+evidence-assumed)']);
  assert.deepEqual(await run(body, ['type-observation']),
    [2, 'readback: mismatch labels (-evidence-confirmed, -runtime-claude-code-win, -status-author-model)']);
  assert.deepEqual(await run(body.replace('retry', 'retrz'), after), [2, 'readback: mismatch body']);
  // Any label change between prepare and apply is a mismatch, not only the evidence label.
  const verified = after.map(l => l === 'status-author-model' ? 'status-author-verified' : l);
  assert.deepEqual(await run(body, verified), [2, 'readback: mismatch labels (+status-author-verified, -status-author-model)']);
  assert.deepEqual(await run(body, [...after, 'currency-uncertain']), [2, 'readback: mismatch labels (+currency-uncertain)']);
});

test('labelsAfter anticipates the runtime label the labels call adds to a page without one', async () => {
  const h = await prepared(harness({ '1': { body: BODY, labels: LABELS.slice(0, 3) } }));
  assert.equal(await h.run(decideArgs), 0);
  const record = JSON.parse(h.files.get('/tmp/ev/r.json') ?? '{}');
  assert.ok(record.labelsAfter.includes(runtimeLabel('KHEREP_ATL_CRED_FILE_CLAUDE', {})));
  assert.equal(record.labelsAfter.filter((l: string) => l.startsWith('runtime-')).length, 1);
});

test('--superseded-by naming the page itself refuses before any read: superseded-same-page', async () => {
  const h = await prepared(harness(), { ...MEASUREMENT, verdict: 'contradicts' });
  await assert.rejects(() => h.run({ ...decideArgs, 'superseded-by': '1', 'body-approved': undefined }), /superseded-same-page/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.files.has('/tmp/ev/b.xml'), false);
});

test('a promoted body the drainage scan would flag stays unknown: promoted-body-revision-invalid', async () => {
  const page = '<p>Host: alpha-node</p><p>The port in src/queue.mts is 8443.</p><h2>Related pages</h2>';
  const h = harness({ '1': { body: page, labels: LABELS } });
  assert.equal(await h.run({ ...prepare, kind: 'live' }), 0);
  assert.ok(h.out.includes('kind: live (override; classified code)'), h.out.join('\n'));
  h.files.set('/tmp/ev/m.json', JSON.stringify({ kind: 'live', source: 'alpha-node', sourceClass: 'target-host',
    command: 'ss -ltn | grep -E "8443|8080"', excerpt: 'LISTEN 0 4096 *:8080', measuredAt: TODAY, verdict: 'contradicts',
    subject: '8443', kindOverride: 'the claim is about the running host' }));
  assert.equal(await h.run(decideArgs), 2);
  assert.match(h.out.join('\n'), /reason: promoted-body-revision-invalid/);
  assert.equal(h.files.has('/tmp/ev/b.xml'), false);
  const record = JSON.parse(h.files.get('/tmp/ev/r.json') ?? '{}');
  assert.deepEqual([record.decision.outcome, record.decision.labelsAdd, record.labelsAfter], ['unknown', [], [...LABELS].sort()]);
});

test('record registers an excluded page without a GET and report renders it', async () => {
  const h = harness();
  assert.equal(await h.run({ mode: 'record', id: '5', excluded: 'private', reason: 'private-no-local-route', out: '/tmp/ev/x.json' }), 0);
  await assert.rejects(() => h.run({ mode: 'record', id: '5', excluded: 'private', reason: 'free text with spaces', out: '/tmp/ev/y.json' }));
  assert.equal(h.calls.length, 0);
  assert.equal(await h.run({ mode: 'report', records: '/tmp/ev/x.json' }), 0);
  assert.match(h.out.join('\n'), /excluded: private[\s\S]*private-no-local-route/);
  await assert.rejects(() => h.run({ mode: 'unknown' }), /--mode/);
});

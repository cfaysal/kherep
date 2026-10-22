// Second-review gates of the confirm path (issue #519): normalisation-stable rendering,
// tracker key matching and the historical refusal under --kind. Synthetic bodies only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claimBody, classifyClaim, decide, escapeText, insertBeforeFooter, MEASUREMENT_BLOCK, renderMeasurementBlock,
  type Measurement, type SupersedingPage } from './confluence-evidence.mts';
import { drainageRules } from './confluence-drainage-rules.mts';

const SHA = 'a'.repeat(40);
const NOW = new Date(2026, 9, 22, 12).getTime();
const TODAY = '2026-10-22';
const FOOTER = '<h2>Related pages</h2>';
const LABELS = ['type-observation', 'evidence-assumed', 'status-author-model', 'runtime-claude-code-win'];
const claim = (body: string, kind?: 'code' | 'tracker' | 'live' | 'doc') =>
  classifyClaim({ id: '1', version: 3, spaceId: '9', body, labels: LABELS }, true, kind);
const CODE = `<p>Revision: alpha@${SHA}</p><p>Code: src/queue.mts and src/retry.mts</p>${FOOTER}`;
const M = (over: Record<string, unknown> = {}): Measurement => ({ kind: 'code', source: 'alpha (git checkout)', sourceClass: 'repository',
  command: `git show ${SHA}:src/queue.mts`, excerpt: '12: retry(receipt)', measuredAt: TODAY, verdict: 'reproduces',
  revision: `alpha@${SHA}`, ...over } as Measurement);
const TRACKER = (excerpt: string): Measurement => ({ kind: 'tracker', source: 'KEY-1', sourceClass: 'tracker',
  command: 'jira get --key KEY-1', excerpt, measuredAt: TODAY, verdict: 'reproduces' });
const OPT = { now: NOW, repoRoot: '/x/alpha', repoTopLevel: '/x/alpha', revisionExists: (sha: string) => sha === SHA };
const GH = (command: string, excerpt: string): Measurement => ({ kind: 'tracker', source: 'github', sourceClass: 'tracker',
  command, excerpt, measuredAt: TODAY, verdict: 'reproduces' });
const closed = 'state: CLOSED, closedAt: 2026-10-22T13:00:00Z';

test('P2: text nodes escape &, <, > and " (as &quot;, #662); line endings reach neither the gates nor the body as CR', () => {
  const m = M({ source: `alpha's "main" checkout`, command: `git show ${SHA}:src/queue.mts | grep -n "it's" && echo 'a<b>'`,
    excerpt: `12: retry('receipt')\r\n13: say "done"\r14: end` });
  const d = decide(claim(CODE), m, OPT);
  assert.equal(d.outcome, 'confirmed');
  const block = renderMeasurementBlock(d, m, 'runtime-claude-code-win');
  assert.ok(!block.includes('&#39;') && block.includes('&quot;'), block);
  assert.ok(!block.includes('\r'), 'no CR reaches the body');
  assert.ok(block.includes(`<p>Source: code, alpha's &quot;main&quot; checkout</p>`), block);
  assert.ok(block.includes(`grep -n &quot;it's&quot; &amp;&amp; echo 'a&lt;b&gt;'</code>`), block);
  assert.ok(block.includes(`<pre>12: retry('receipt')\n13: say &quot;done&quot;\n14: end</pre>`), block);
  // Normalised before the gates: 4500 raw characters are 3000 once CRLF becomes LF.
  assert.equal(decide(claim(CODE), M({ excerpt: 'x\r\n'.repeat(2001) }), OPT).reason, 'excerpt-too-long');
  assert.equal(decide(claim(CODE), M({ excerpt: 'x\r\n'.repeat(1500) }), OPT).outcome, 'confirmed');
});

test('P2: one escaper serves text and attribute values; a superseding title is text', () => {
  assert.equal(escapeText(`/wiki/"x"?a=1&b='2'<`), `/wiki/&quot;x&quot;?a=1&amp;b='2'&lt;`);
  assert.equal(escapeText(`it's "x" & <y>`), `it's &quot;x&quot; &amp; &lt;y&gt;`);
  const live = claim(`<p>Host: alpha-node</p><p>The queue listens on 8443.</p>${FOOTER}`);
  const m: Measurement = { kind: 'live', source: 'alpha-node', sourceClass: 'target-host', command: 'ss -ltn', excerpt: '8443 -> 8080',
    measuredAt: TODAY, verdict: 'contradicts', subject: '8443', supersededBy: '77' };
  const page = { id: '77', title: `Queue "port" isn't 8443`, spaceId: '9', spaceKey: 'K"Q' };
  const d = decide(live, m, { ...OPT, superseded: page });
  assert.equal(d.outcome, 'superseded');
  const block = renderMeasurementBlock(d, m, 'runtime-codex-mac', page);
  assert.ok(block.includes(`<a href="/wiki/spaces/K%22Q/pages/77">Queue &quot;port&quot; isn't 8443</a>`), block);
});

test(`#662: the block carries the entity forms Confluence returns: " as &quot;, ' raw, no &#39;, no CR`, () => {
  const m: Measurement = { kind: 'live', source: `alpha's "main"`, sourceClass: 'target-host',
    command: 'gh issue view 519 --json state,closedAt | jq .', excerpt: `{\n  "state": "CLOSED",\n  "title": "it's done"\n}`,
    measuredAt: TODAY, verdict: 'contradicts', subject: 'CLOSED', supersededBy: '77' };
  const page = { id: '77', title: `Queue "port" isn't 8443`, spaceId: '9', spaceKey: 'K"Q' };
  const d = decide(claim('<p>Host: alpha-node</p><p>The issue is CLOSED.</p>'), m, { ...OPT, superseded: page });
  assert.equal(d.outcome, 'superseded');
  const block = renderMeasurementBlock(d, m, 'runtime-claude-code-win', page);
  assert.ok(block.includes(`<p>Source: live, alpha's &quot;main&quot;</p>`), block);
  assert.ok(block.includes(`<pre>{\n  &quot;state&quot;: &quot;CLOSED&quot;,\n  &quot;title&quot;: &quot;it's done&quot;\n}</pre>`), block);
  assert.ok(block.includes(`<a href="/wiki/spaces/K%22Q/pages/77">Queue &quot;port&quot; isn't 8443</a>`), block);
  assert.equal(escapeText(`a & b < c > d " e ' f`), `a &amp; b &lt; c &gt; d &quot; e ' f`);
  assert.ok(!block.includes('&#39;') && !block.includes(String.fromCharCode(13)), block);
});

test('P3-a: a tracker key matches on word boundaries only', () => {
  const c = claim('<p>Tracker: KEY-1 tracks the queue retry.</p>');
  assert.equal(c.kind, 'tracker');
  assert.equal(decide(c, TRACKER('key: KEY-12\nstate: Done'), OPT).reason, 'measurement-does-not-touch-claim');
  assert.equal(decide(c, TRACKER('key: XKEY-1\nstate: Done'), OPT).reason, 'measurement-does-not-touch-claim');
  assert.equal(decide(c, TRACKER('key: KEY-1\nstate: Done'), OPT).outcome, 'confirmed');
});

test('P3-b: a tracker claim needs every tracker key in the excerpt; a code claim needs any token', () => {
  const c = claim('<p>Tracker: KEY-1 and KEY-2 were closed together.</p>');
  assert.deepEqual(c.trackerKeys, ['KEY-1', 'KEY-2']);
  assert.equal(decide(c, TRACKER('key: KEY-1\nstate: Done'), OPT).reason, 'measurement-does-not-touch-claim');
  assert.equal(decide(c, TRACKER('key: KEY-1\nstate: Done\nkey: KEY-2\nstate: Done'), OPT).outcome, 'confirmed');
  assert.equal(decide(claim(CODE), M({ command: `git show ${SHA}:src/retry.mts` }), OPT).outcome, 'confirmed');
});

test('F1: a GitHub key counts only as #N in the excerpt or as the number gh issue/pr view reads', () => {
  const both = claim('<p>GitHub issue #10 and #648 are closed.</p>');
  assert.equal(both.kind, 'tracker');
  assert.equal(decide(both, GH('gh issue view 648 --json state,closedAt', closed), OPT).reason, 'measurement-does-not-touch-claim');
  const one = claim('<p>GitHub issue #648 is closed.</p>');
  assert.equal(decide(one, GH('gh issue view 648 --json state,closedAt', closed), OPT).outcome, 'confirmed');
  assert.equal(decide(one, GH('gh pr view 648 --json state', 'state: MERGED'), OPT).outcome, 'confirmed');
  assert.equal(decide(one, GH('gh api repos/o/r/issues', '#648 state: CLOSED'), OPT).outcome, 'confirmed');
  assert.equal(decide(one, GH('gh issue view 6480 --json state', closed), OPT).reason, 'measurement-does-not-touch-claim');
  assert.equal(decide(one, GH('gh api repos/o/r/issues', '#6480 state: CLOSED, 648 open'), OPT).reason, 'measurement-does-not-touch-claim');
  assert.equal(decide(one, GH('echo 648 #648', closed), OPT).reason, 'measurement-does-not-touch-claim');
});

test('F2: once a page names a GitHub key, every #N it states is a key; a read of one never confirms both', () => {
  const both = claim('<p>GitHub issue #10 and #648 are closed.</p>');
  assert.deepEqual(both.trackerKeys, ['#10', '#648']);
  assert.equal(decide(both, GH('gh issue view 10 --json state,closedAt', closed), OPT).reason, 'measurement-does-not-touch-claim');
  assert.equal(decide(both, GH('gh api repos/o/r/issues', '#10 state: CLOSED\n#648 state: CLOSED'), OPT).outcome, 'confirmed');
  // Two gh invocations name no key by the command; the excerpt must state both.
  assert.equal(decide(both, GH('gh issue view 10 --json state; gh issue view 648 --json state', closed), OPT).reason, 'measurement-does-not-touch-claim');
  assert.equal(decide(both, GH('gh issue view 10 --json state; gh issue view 648 --json state', '#10 CLOSED\n#648 CLOSED'), OPT).outcome, 'confirmed');
  assert.deepEqual(claim('<p>GitHub issue #648 is closed.</p>').trackerKeys, ['#648']);
  assert.deepEqual(claim('<p>Fixed by <a href="https://github.com/o/r/pull/12">the PR</a>; see #13.</p>').trackerKeys, ['#12', '#13']);
  // A numeric character reference is not a key; without a GitHub key a #N stays prose and Jira keys are unchanged.
  assert.deepEqual(claim('<p>GitHub issue #10 isn&#39;t open.</p>').trackerKeys, ['#10']);
  assert.deepEqual(claim('<p>Tracker: KEY-1 is done, step #2 of the plan.</p>').trackerKeys, ['KEY-1']);
  // decide judges the claim as read at prepare: a #N in the appended measurement block never becomes a key of it.
  const m = GH('gh api repos/o/r/issues', '#10 state: CLOSED\n#648 state: CLOSED\nsee #999');
  const d = decide(both, m, OPT);
  const promoted = `<p>GitHub issue #10 and #648 are closed.</p>${renderMeasurementBlock(d, m, 'runtime-claude-code-win')}`;
  assert.deepEqual([d.outcome, both.trackerKeys], ['confirmed', ['#10', '#648']]);
  assert.ok(!claim(promoted).trackerKeys.includes('#999'), 'a re-classification reads the claim without the block (#650)');
});

test('F3: the command names a key only as one gh issue/pr view of exactly N; #N in the excerpt is a whole token', () => {
  const ten = claim('<p>GitHub issue #10 is closed.</p>');
  const miss = (command: string, excerpt = closed) => assert.equal(decide(ten, GH(command, excerpt), OPT).reason,
    'measurement-does-not-touch-claim', `${command} / ${excerpt}`);
  const hit = (command: string, excerpt = closed) => assert.equal(decide(ten, GH(command, excerpt), OPT).outcome,
    'confirmed', `${command} / ${excerpt}`);
  for (const command of ['gh issue view 10-other --json state,closedAt', 'gh issue view 10.5', 'echo gh issue view 10',
    'x gh issue view 10', 'gh issue view 010', 'gh issue view 648 && gh issue view 10', 'gh issue view 10 && gh issue view 648',
    'gh issue view 10 | gh api x', 'gh issue view 10 --repo "o/r', 'gh "issue view" 10']) miss(command);
  const pair = claim('<p>GitHub issue #648 and #10 are closed.</p>');
  assert.equal(decide(pair, GH('gh issue view 648 && gh issue view 10', '#648 state: CLOSED'), OPT).reason, 'measurement-does-not-touch-claim');
  miss('gh api repos/o/r/issues', '#10-other state: CLOSED');
  miss('gh api repos/o/r/issues', '#10.5 state: CLOSED');
  hit('gh issue view 10 --json state,closedAt');
  hit('gh pr view 10 | jq .state', 'MERGED');
  hit(`gh issue view '10' --json state`);
  hit('gh api repos/o/r/issues', 'Issue #10. state: CLOSED');
  hit('gh api repos/o/r/issues', '#10, state: CLOSED');
  // The F1 date case: a 10 inside a date is never #10.
  miss('gh api repos/o/r/issues', 'state: CLOSED, closedAt: 2026-10-10T13:00:00Z');
});

test('P3-c: a --kind override never bypasses historical-not-repeatable', () => {
  const hist = claim('<p>Historical measurement from the queue rollout: delivery stalled on port 8443.</p>', 'live');
  assert.deepEqual([hist.kind, hist.classifiedKind], ['live', 'historical']);
  const m: Measurement = { kind: 'live', source: 'alpha-node', sourceClass: 'target-host', command: 'ss -ltn | grep 8443',
    excerpt: 'LISTEN *:8443', measuredAt: TODAY, verdict: 'reproduces', subject: '8443', kindOverride: 'the port is still live' };
  const d = decide(hist, m, OPT);
  assert.deepEqual([d.outcome, d.reason, d.labelsAdd], ['unknown', 'historical-not-repeatable', []]);
});

// Issue #650: the measurement block decide appends is metadata; only the original claim decides code-boundness.
const RUNTIME = 'runtime-claude-code-win';
const AFTER = ['evidence-confirmed', RUNTIME, 'status-author-model', 'type-observation'];
const TRK = '<p>Tracker: KEY-12 holds the queue retry fix.</p>';
const CCODER = 'node tools/atl-jira-ccoder.mts get --key KEY-12';
const KEY12 = (command = CCODER, measuredAt = TODAY): Measurement => ({ kind: 'tracker', source: 'KEY-12', sourceClass: 'tracker',
  command, excerpt: 'key: KEY-12\nstate: Done', measuredAt, verdict: 'reproduces' });
const promote = (body: string, m: Measurement, page?: SupersedingPage) => {
  const d = decide(claim(body), m, page ? { ...OPT, superseded: page } : OPT);
  const block = renderMeasurementBlock(d, m, RUNTIME, page);
  return { d, block, body: insertBeforeFooter(body, block) };
};
const flagged = (body: string, labels = AFTER) => drainageRules([{ id: '1', version: 3, title: 't', spaceId: '9', parentId: null, body, labels }],
  false).filter(c => c.problem === 'revision-missing-or-invalid').length;

test('#650 T1: renderer and recogniser agree on every rendered variant', () => {
  const page = { id: '77', title: `Queue "port" & <x> isn't 8443`, spaceId: '9', spaceKey: 'K"Q' };
  const live: Measurement = { kind: 'live', source: 'alpha-node', sourceClass: 'target-host', command: 'ss -ltn', excerpt: '8443 -> 8080',
    measuredAt: TODAY, verdict: 'contradicts', subject: '8443', supersededBy: '77' };
  const blocks = [promote(CODE, M()), promote(TRK + FOOTER, KEY12()),
    promote(`<p>Host: alpha-node</p><p>The queue listens on 8443.</p>${FOOTER}`, live, page)];
  assert.deepEqual(blocks.map(b => b.d.outcome), ['confirmed', 'confirmed', 'superseded']);
  assert.ok(blocks[0].block.includes('<p>Revision: ') && blocks[2].block.includes('<a href='));
  for (const { block } of blocks) {
    assert.equal(claimBody(block), '', block);
    assert.equal(claimBody(TRK + block + FOOTER), TRK + FOOTER, block);
    assert.equal(block.match(MEASUREMENT_BLOCK)?.[0], block);
  }
});

test('#650 T2: a tracker claim measured through a .mts, .js or .py tool confirms and the promoted body is not code-bound', () => {
  for (const command of [CCODER, 'node tools/jira.js get --key KEY-12', 'python tools/jira.py get --key KEY-12']) {
    const { d, body } = promote(TRK + FOOTER, KEY12(command));
    assert.equal(d.outcome, 'confirmed', command);
    assert.equal(flagged(body), 0, command);
  }
});

test('#650 T4: an original Measurement heading with code is page content and keeps its Revision requirement', () => {
  const a07 = `<h2>Measurement ${TODAY}</h2><p>Code: src/queue.mts</p>${TRK}${FOOTER}`;
  assert.equal(claimBody(a07), a07);
  const c = claim(a07, 'tracker');
  assert.deepEqual([c.classifiedKind, c.codeTokens.includes('src/queue.mts')], ['code', true]);
  assert.equal(flagged(a07, LABELS), 1);
  const m = { ...KEY12(), kindOverride: 'the claim is the tracker state' };
  const d = decide(c, m, OPT);
  assert.equal(d.outcome, 'confirmed', 'the pure gates pass; the CLI re-check is what refuses');
  assert.equal(flagged(insertBeforeFooter(a07, renderMeasurementBlock(d, m, RUNTIME))), 1);
  const human = `<h2>Measurement ${TODAY}</h2><p>Outcome: confirmed</p><p>Code: src/queue.mts</p>`;
  assert.equal(claimBody(human), human);
});

test('#650 T5: partial or look-alike blocks stay visible with every code token', () => {
  const { block } = promote(TRK + FOOTER, KEY12());
  const variants = [block.replace(/<p>Measured via [^<]*<\/p>/, ''),
    block.replace('<h2>', '<h3>').replace('</h2>', '</h3>'), block.replace('<h2>', '<h2 class="x">'),
    block.replace('<h2>', '<H2>').replace('</h2>', '</H2>'), block.replace(`on ${TODAY}.`, 'on 2026-10-21.'),
    block.replace('Source: tracker, KEY-12', 'Source: tracker, <b>KEY-12</b>'),
    block.replace(`<h2>Measurement ${TODAY}</h2>`, `<p>&lt;h2&gt;Measurement ${TODAY}&lt;/h2&gt;</p>`)];
  for (const v of variants) {
    assert.notEqual(v, block);
    const body = `${v}<p>Code: src/queue.mts</p>`;
    assert.equal(claimBody(body), body, v);
    assert.ok(['src/queue.mts', 'tools/atl-jira-ccoder.mts'].every(t => claim(body).codeTokens.includes(t)), v);
  }
});

test('#650 T6: a second measurement reads the original claim; original code between two blocks stays visible', () => {
  const first = promote(TRK + FOOTER, KEY12());
  const again = claim(first.body);
  assert.deepEqual([again.kind, again.trackerKeys], ['tracker', ['KEY-12']]);
  const m2 = KEY12('node tools/jira.js get --key KEY-12', '2026-10-21');
  const d2 = decide(again, m2, OPT);
  assert.equal(d2.outcome, 'confirmed');
  const block2 = renderMeasurementBlock(d2, m2, RUNTIME);
  const both = insertBeforeFooter(first.body, block2);
  assert.equal(claimBody(both), TRK + FOOTER);
  assert.equal(flagged(both), 0);
  const a08 = `${TRK}${first.block}<p>Code: src/queue.mts</p>${block2}${FOOTER}`;
  assert.equal(claimBody(a08), `${TRK}<p>Code: src/queue.mts</p>${FOOTER}`);
  assert.equal(flagged(a08), 1);
});

test('#650 T8: an original code claim still needs its own bound Revision; a block never supplies it', () => {
  const { d, block, body } = promote(CODE, M());
  assert.equal(d.outcome, 'confirmed');
  const line = `<p>Revision: alpha@${SHA}</p>`;
  assert.equal(body.split(line).length - 1, 2);
  assert.ok(body.indexOf(line) < body.indexOf('<h2>Measurement'));
  assert.equal(flagged(body), 0);
  const bare = `<p>Revision: ${SHA}</p><p>Code: src/queue.mts</p>${block}${FOOTER}`;
  assert.equal(flagged(bare, LABELS), 1);
  assert.equal(decide(claim(bare), M(), OPT).reason, 'revision-not-on-page');
});

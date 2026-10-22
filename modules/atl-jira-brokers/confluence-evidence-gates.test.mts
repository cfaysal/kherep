// Second-review gates of the confirm path (issue #519): normalisation-stable rendering,
// tracker key matching and the historical refusal under --kind. Synthetic bodies only.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as evidence from './confluence-evidence.mts';
import { classifyClaim, decide, renderMeasurementBlock, type Measurement } from './confluence-evidence.mts';

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

test('P2: text nodes escape only &, < and >; line endings reach neither the gates nor the body as CR', () => {
  const m = M({ source: `alpha's "main" checkout`, command: `git show ${SHA}:src/queue.mts | grep -n "it's" && echo 'a<b>'`,
    excerpt: `12: retry('receipt')\r\n13: say "done"\r14: end` });
  const d = decide(claim(CODE), m, OPT);
  assert.equal(d.outcome, 'confirmed');
  const block = renderMeasurementBlock(d, m, 'runtime-claude-code-win');
  assert.ok(!block.includes('&#39;') && !block.includes('&quot;'), block);
  assert.ok(!block.includes('\r'), 'no CR reaches the body');
  assert.ok(block.includes(`<p>Source: code, alpha's "main" checkout</p>`), block);
  assert.ok(block.includes(`grep -n "it's" &amp;&amp; echo 'a&lt;b&gt;'</code>`), block);
  assert.ok(block.includes(`<pre>12: retry('receipt')\n13: say "done"\n14: end</pre>`), block);
  // Normalised before the gates: 4500 raw characters are 3000 once CRLF becomes LF.
  assert.equal(decide(claim(CODE), M({ excerpt: 'x\r\n'.repeat(2001) }), OPT).reason, 'excerpt-too-long');
  assert.equal(decide(claim(CODE), M({ excerpt: 'x\r\n'.repeat(1500) }), OPT).outcome, 'confirmed');
});

test('P2: an attribute value still escapes the double quote; a superseding title is text', () => {
  const attr = (evidence as Record<string, unknown>).escapeAttr as ((v: string) => string) | undefined;
  const text = (evidence as Record<string, unknown>).escapeText as ((v: string) => string) | undefined;
  assert.equal(typeof attr, 'function', 'escapeAttr is exported');
  assert.equal(attr?.(`/wiki/"x"?a=1&b='2'<`), `/wiki/&quot;x&quot;?a=1&amp;b='2'&lt;`);
  assert.equal(text?.(`it's "x" & <y>`), `it's "x" &amp; &lt;y&gt;`);
  const live = claim(`<p>Host: alpha-node</p><p>The queue listens on 8443.</p>${FOOTER}`);
  const m: Measurement = { kind: 'live', source: 'alpha-node', sourceClass: 'target-host', command: 'ss -ltn', excerpt: '8443 -> 8080',
    measuredAt: TODAY, verdict: 'contradicts', subject: '8443', supersededBy: '77' };
  const page = { id: '77', title: `Queue "port" isn't 8443`, spaceId: '9', spaceKey: 'K"Q' };
  const d = decide(live, m, { ...OPT, superseded: page });
  assert.equal(d.outcome, 'superseded');
  const block = renderMeasurementBlock(d, m, 'runtime-codex-mac', page);
  assert.ok(block.includes(`<a href="/wiki/spaces/K%22Q/pages/77">Queue "port" isn't 8443</a>`), block);
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

test('P3-c: a --kind override never bypasses historical-not-repeatable', () => {
  const hist = claim('<p>Historical measurement from the queue rollout: delivery stalled on port 8443.</p>', 'live');
  assert.deepEqual([hist.kind, hist.classifiedKind], ['live', 'historical']);
  const m: Measurement = { kind: 'live', source: 'alpha-node', sourceClass: 'target-host', command: 'ss -ltn | grep 8443',
    excerpt: 'LISTEN *:8443', measuredAt: TODAY, verdict: 'reproduces', subject: '8443', kindOverride: 'the port is still live' };
  const d = decide(hist, m, OPT);
  assert.deepEqual([d.outcome, d.reason, d.labelsAdd], ['unknown', 'historical-not-repeatable', []]);
});

// Issue #666: only the run of blocks decide appends directly before the footer is metadata.
// A block-shaped span anywhere else is author text and keeps its code claim. Synthetic bodies only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claimBody, claimSpan, classifyClaim, decide, insertBeforeFooter, MEASUREMENT_BLOCK, renderMeasurementBlock,
  type Decision, type Measurement } from './confluence-evidence.mts';
import { drainageRules } from './confluence-drainage-rules.mts';

const SHA = 'a'.repeat(40);
const TODAY = '2026-10-22';
const OPT = { now: new Date(2026, 9, 22, 12).getTime(), repoRoot: '/x/alpha', repoTopLevel: '/x/alpha', revisionExists: (sha: string) => sha === SHA };
const FOOTER = '<h2>Related pages</h2>';
const RUNTIME = 'runtime-claude-code-win';
const LABELS = ['type-observation', 'evidence-assumed', 'status-author-model', RUNTIME];
const TRK = '<p>Tracker: KEY-12 holds the queue retry fix.</p>';
const CONFIRMED: Decision = { outcome: 'confirmed', reason: 'measured', labelsAdd: [], labelsRemove: [] };
const KEY12 = (command = 'node tools/atl-jira-ccoder.mts get --key KEY-12', measuredAt = TODAY): Measurement => ({ kind: 'tracker',
  source: 'KEY-12', sourceClass: 'tracker', command, excerpt: 'key: KEY-12\nstate: Done', measuredAt, verdict: 'reproduces' });
const claim = (body: string) => classifyClaim({ id: '1', version: 3, spaceId: '9', body, labels: LABELS }, true);
const flagged = (body: string, labels: string[]) => drainageRules([{ id: '1', version: 3, title: 't', spaceId: '9', parentId: null, body, labels }],
  false).filter(c => c.problem === 'revision-missing-or-invalid').length;
const block = renderMeasurementBlock(CONFIRMED, KEY12(), RUNTIME);
const forged = renderMeasurementBlock(CONFIRMED, { ...KEY12('jira get --key KEY-12'), excerpt: 'Code: src/queue.mts retries on receipt' }, RUNTIME);

test('#666 T1: a block-shaped section inside the author text is content and keeps its code claim', () => {
  const body = `${TRK}${forged}<p>The fix is tracked in KEY-12.</p>${FOOTER}`;
  assert.equal(claimBody(body), body);
  const c = claim(body);
  assert.ok(c.codeTokens.includes('src/queue.mts'), c.codeTokens.join());
  assert.equal(c.kind, 'code');
  assert.equal(flagged(body, LABELS), 1);
});

test('#666 T2: only the run directly before the footer is stripped', () => {
  assert.equal(claimBody(TRK + FOOTER + block), TRK + FOOTER + block, 'a block after the footer is stitcher territory');
  assert.equal(claimBody(`${TRK}${block}\n  ${FOOTER}`), TRK + FOOTER, 'whitespace before the footer belongs to the run');
  assert.equal(claimBody(`${TRK}${FOOTER}<p>x</p>${block}${FOOTER}`), `${TRK}${FOOTER}<p>x</p>${FOOTER}`, 'the LAST footer is the cut');
  assert.equal(claimBody(`${TRK}${block}<p>x</p>${block}${FOOTER}`), `${TRK}${block}<p>x</p>${FOOTER}`);
});

test('#666 T3: a superseded block always carries its link; without it the span is content', () => {
  const live: Measurement = { kind: 'live', source: 'alpha-node', sourceClass: 'target-host', command: 'ss -ltn', excerpt: '8443 -> 8080',
    measuredAt: TODAY, verdict: 'contradicts', subject: '8443', supersededBy: '77' };
  const page = { id: '77', title: 'Queue port moved', spaceId: '9', spaceKey: 'K' };
  const body = `<p>Host: alpha-node</p><p>The queue listens on 8443.</p>${FOOTER}`;
  const d = decide(claim(body), live, { ...OPT, superseded: page });
  assert.equal(d.outcome, 'superseded');
  const s = renderMeasurementBlock(d, live, RUNTIME, page);
  const cut = s.replace(/<p>Superseded by:.*$/s, '');
  assert.notEqual(cut, s);
  assert.equal(cut.match(MEASUREMENT_BLOCK), null);
  assert.equal(claimBody(cut + FOOTER), cut + FOOTER);
  assert.equal(s.match(MEASUREMENT_BLOCK)?.[0], s);
});

test('#666 T4: n appended blocks strip to the author\'s claim', () => {
  const blocks = [TODAY, '2026-10-21', '2026-10-20'].map(date => renderMeasurementBlock(CONFIRMED, KEY12(undefined, date), RUNTIME));
  const withFooter = blocks.reduce(insertBeforeFooter, TRK + FOOTER);
  const bare = blocks.reduce(insertBeforeFooter, TRK);
  assert.equal(claimBody(withFooter), TRK + FOOTER);
  assert.equal(claimBody(bare), TRK);
  assert.deepEqual(claimSpan(withFooter), [TRK.length, withFooter.length - FOOTER.length]);
  assert.deepEqual(claimSpan(bare), [TRK.length, bare.length]);
});

test('#666 boundary: a block-shaped section directly before the footer is positionally an appended block', () => {
  const body = TRK + forged + FOOTER;
  assert.equal(claimBody(body), TRK + FOOTER);
  assert.equal(flagged(body, LABELS), 0);
});

// Revision evidence ignores every block-shaped span, trailing or not: a block never supplies the author's Revision (#650 T8).
const REV = `alpha@${SHA}`;
const CODE_M: Measurement = { kind: 'code', source: 'alpha (git checkout)', sourceClass: 'repository', command: 'node --test src/queue.mts',
  excerpt: 'src/queue.mts changed', measuredAt: TODAY, verdict: 'reproduces', revision: REV };
const coded = renderMeasurementBlock({ ...CONFIRMED, measuredRevision: REV }, CODE_M, RUNTIME);
const AUTHOR = '<p>Code: src/queue.mts needs a new fix.</p>';

test('#666 T5: a Revision inside a non-trailing block never counts as the author\'s Revision', () => {
  for (const body of [`${AUTHOR}${coded}<p>Author followup.</p>${FOOTER}`, `${coded}${AUTHOR}${FOOTER}`,
    `${AUTHOR}${coded}<p>Author followup.</p>${block}${FOOTER}`]) {
    const c = claim(body);
    assert.deepEqual(c.revisions.bound, [], body);
    assert.equal(flagged(body, LABELS), 1, body);
    assert.equal(decide(c, CODE_M, OPT).reason, 'revision-not-on-page', body);
  }
});

test('#666 T5 control: the author\'s own Revision outside every block still binds the claim', () => {
  const body = `<p>Revision: ${REV}</p>${AUTHOR}${coded}<p>Author followup.</p>${FOOTER}`;
  assert.deepEqual(claim(body).revisions.bound, [REV]);
  assert.equal(flagged(body, LABELS), 0);
  assert.equal(decide(claim(body), CODE_M, OPT).outcome, 'confirmed');
});

test('#666 T6: 2000 contiguous blocks followed by author text stay content; the same run before the footer is stripped', () => {
  const run = block.repeat(2000);
  const body = `${TRK}${run}<p>Author followup.</p>${FOOTER}`;
  assert.equal(claimBody(body), body);
  assert.ok(claim(body).codeTokens.includes('tools/atl-jira-ccoder.mts'));
  assert.equal(claimBody(TRK + run + FOOTER), TRK + FOOTER);
});

// Revision exclusion does not depend on the strict grammar: a block that lost its Superseded link still never binds, and
// the excluded span ends with the block, so the author's own declarations after it keep their base meaning.
const TARGET = { id: '99', title: 'Replacement', spaceId: '9', spaceKey: 'K' };
const HISTORICAL: Measurement = { ...CODE_M, verdict: 'contradicts', supersededBy: '99' };
const partial = renderMeasurementBlock(decide(claim(`<p>Revision: ${REV}</p>${AUTHOR}${FOOTER}`), HISTORICAL, { ...OPT, superseded: TARGET }),
  HISTORICAL, RUNTIME, TARGET).replace(/<p>Superseded by:.*$/s, '');
const ANY_SHA = { ...OPT, revisionExists: () => true };

test('#666 T7: a superseded code block without its link never supplies the author\'s Revision', () => {
  assert.ok(partial.includes(`<p>Revision: ${REV}</p>`) && partial.includes('Outcome: superseded') && partial.match(MEASUREMENT_BLOCK) === null);
  for (const extra of ['', block]) {
    for (const body of [`${AUTHOR}${partial}<p>Author followup.</p>${extra}${FOOTER}`, `${AUTHOR}${partial}${extra}${FOOTER}`,
      `${AUTHOR}${extra}${FOOTER}${partial}`]) {
      const c = claim(body);
      assert.deepEqual(c.revisions.bound, [], body);
      assert.equal(flagged(body, LABELS), 1, body);
      assert.equal(decide(c, CODE_M, OPT).reason, 'revision-not-on-page', body);
    }
  }
});

test('#666 T7 controls: the author\'s own declarations before or after a link-less block keep their base meaning', () => {
  const beta = `alpha@${'b'.repeat(40)}`;
  for (const extra of ['', block]) {
    for (const own of [`<p>Revision: ${REV}</p>${AUTHOR}${partial}<p>Author followup.</p>${extra}${FOOTER}`,
      `${AUTHOR}${partial}<p>Revision: ${REV}</p>${extra}${FOOTER}`]) {
      assert.deepEqual(claim(own).revisions.bound, [REV], own);
      assert.equal(flagged(own, LABELS), 0, own);
      assert.equal(decide(claim(own), CODE_M, OPT).outcome, 'confirmed', own);
    }
    const after = `${AUTHOR}${partial}<p>Revision: ${beta}</p>${extra}${FOOTER}`;
    assert.deepEqual(claim(after).revisions.bound, [beta], after);
    assert.equal(flagged(after, LABELS), 0, after);
    assert.equal(decide(claim(after), { ...CODE_M, revision: beta }, ANY_SHA).outcome, 'confirmed', after);
    // Malformed and unbound declarations stay what they were on base d5c15f4, wherever they stand.
    for (const [line, kind, flags] of [['alpha@abc123', 'malformed', 1], [SHA, 'malformed', 1], ['none (no exact binding: dirty tree)', 'unbound', 0]] as const) {
      const decl = `<p>Revision: ${line}</p>`;
      for (const body of [`${decl}${AUTHOR}${partial}${extra}${FOOTER}`, `${AUTHOR}${partial}${decl}${extra}${FOOTER}`]) {
        const c = claim(body);
        assert.deepEqual([c.revisions.bound, c.revisions[kind]], [[], [line]], body);
        assert.equal(flagged(body, LABELS), flags, body);
        assert.equal(decide(c, CODE_M, ANY_SHA).reason, 'revision-not-on-page', body);
      }
    }
  }
});

// Never more confirmable than base: only a base-form block is hidden from the Revision read, so a block-like span that lost
// its Measured via line is author text and cannot hide a later disqualifier.
const BETA = `alpha@${'b'.repeat(40)}`;
const AFTER_LABELS = ['type-observation', 'evidence-confirmed', 'status-author-model', RUNTIME];
const missingVia = partial.replace(/<p>Measured via [^<]*<\/p>/, '');
const DISQUALIFIERS = ['alpha@abc123', SHA, 'none (no exact binding: dirty tree)', `${BETA} (no exact binding: dirty tree)`];

test('#666 T8: a span hidden from binding never hides a later disqualifier', () => {
  assert.notEqual(missingVia, partial);
  for (const line of DISQUALIFIERS.filter(l => l !== SHA)) {
    const body = `<p>Revision: ${BETA}</p>${AUTHOR}${missingVia}<p>Author followup.</p><p>Revision: ${line}</p>${FOOTER}`;
    assert.equal(decide(claim(body), { ...CODE_M, revision: BETA }, ANY_SHA).reason, 'revision-unbound-on-page', body);
    assert.equal(flagged(body, AFTER_LABELS), 1, body);
  }
});

test('#666 T8 property: no layout is more confirmable than its disqualifier allows', () => {
  // missingVia ends in </pre>, so sep '' puts the declaration directly after it (#669).
  for (const shape of [partial, missingVia, block]) for (const extra of ['', block]) for (const line of DISQUALIFIERS) for (const sep of ['<p>x</p>', ''])
    for (const body of [`<p>Revision: ${line}</p>${AUTHOR}${shape}${sep}${extra}${FOOTER}`, `${AUTHOR}${shape}${sep}<p>Revision: ${line}</p>${extra}${FOOTER}`,
      `<p>Revision: ${BETA}</p>${AUTHOR}${shape}${sep}<p>Revision: ${line}</p>${extra}${FOOTER}`, `${AUTHOR}${extra}${FOOTER}${shape}${sep}<p>Revision: ${line}</p>`]) {
      const c = claim(body);
      assert.ok([...c.revisions.unbound, ...c.revisions.malformed].includes(line), body);
      assert.notEqual(decide(c, { ...CODE_M, revision: BETA }, ANY_SHA).outcome, 'confirmed', body);
      assert.equal(flagged(body, AFTER_LABELS), 1, body);
    }
});

test('#666 T8 control: a Revision line inside a strict block\'s excerpt is metadata, not a disqualifier', () => {
  const m = { ...CODE_M, excerpt: 'src/queue.mts changed\nRevision: abc123' };
  const strict = renderMeasurementBlock({ ...CONFIRMED, measuredRevision: REV }, m, RUNTIME);
  assert.equal(strict.match(MEASUREMENT_BLOCK)?.[0], strict);
  const body = `<p>Revision: ${REV}</p>${AUTHOR}${strict}<p>Author followup.</p>${FOOTER}`;
  assert.deepEqual(claim(body).revisions, { bound: [REV], unbound: [], malformed: [], paths: {} });
  assert.equal(decide(claim(body), CODE_M, OPT).outcome, 'confirmed');
  assert.equal(flagged(body, AFTER_LABELS), 0);
});

test('#666 T9: a superseded block hides a Revision line in its link title; a tail after another outcome stays author text', () => {
  const titled = { ...TARGET, title: `Replacement\nRevision: ${REV}` };
  const d = decide(claim(`<p>Revision: ${REV}</p>${AUTHOR}${FOOTER}`), HISTORICAL, { ...OPT, superseded: titled });
  const full = renderMeasurementBlock(d, HISTORICAL, RUNTIME, titled);
  assert.equal(full.match(MEASUREMENT_BLOCK)?.[0], full);
  for (const body of [`${AUTHOR}${full}${FOOTER}`, `${AUTHOR}${full}<p>Author followup.</p>${FOOTER}`, `${AUTHOR}${FOOTER}${full}`]) {
    const c = claim(body);
    assert.deepEqual(c.revisions.bound, [], body);
    assert.equal(flagged(body, LABELS), 1, body);
    assert.equal(decide(c, CODE_M, OPT).reason, 'revision-not-on-page', body);
  }
  const tail = full.slice(full.indexOf('<p>Superseded by:'));
  for (const outcome of ['confirmed', 'refuted'] as const) {
    const core = renderMeasurementBlock({ ...CONFIRMED, outcome, measuredRevision: REV }, CODE_M, RUNTIME);
    assert.deepEqual(claim(`${AUTHOR}${core}${tail}${FOOTER}`).revisions.bound, [REV], outcome);
  }
});

// Issue #669: </pre> ends a line like </p>, so the author's own declaration directly after a code block is read.
const PRE = '<pre>retry(receipt)</pre>';

test('#669: a Revision line directly after </pre> binds the claim', () => {
  const body = `${AUTHOR}${PRE}<p>Revision: ${REV}</p>${FOOTER}`;
  assert.deepEqual(claim(body).revisions, { bound: [REV], unbound: [], malformed: [], paths: {} });
  assert.equal(flagged(body, LABELS), 0);
  assert.equal(decide(claim(body), CODE_M, OPT).outcome, 'confirmed');
});

test('#669: a disqualifier directly after </pre> is read and refuses confirmation', () => {
  for (const line of DISQUALIFIERS.filter(l => l !== SHA)) {
    const body = `<p>Revision: ${BETA}</p>${AUTHOR}${PRE}<p>Revision: ${line}</p>${FOOTER}`;
    assert.ok([...claim(body).revisions.unbound, ...claim(body).revisions.malformed].includes(line), body);
    assert.equal(decide(claim(body), { ...CODE_M, revision: BETA }, ANY_SHA).reason, 'revision-unbound-on-page', body);
    assert.equal(flagged(body, AFTER_LABELS), 1, body);
  }
});

test('#669: Code:, Host: and Doc: lines directly after </pre> are read', () => {
  const coded669 = `${TRK}${PRE}<p>Code: the retry path</p>${FOOTER}`;
  assert.equal(claim(coded669).kind, 'code');
  assert.equal(flagged(coded669, LABELS), 1);
  assert.deepEqual(claim(`<p>The queue retries.</p>${PRE}<p>Host: alpha-node</p>${PRE}<p>Doc: vendor guide</p>${FOOTER}`).signals, ['live', 'doc']);
});

test('#669 guard: a Revision line that ends a block excerpt\'s <pre> never supplies the author\'s Revision', () => {
  for (const excerpt of [`Revision: ${BETA}`, `src/queue.mts changed\nRevision: ${BETA}`]) {
    const b = renderMeasurementBlock({ ...CONFIRMED, measuredRevision: REV }, { ...CODE_M, excerpt }, RUNTIME);
    assert.equal(b.match(MEASUREMENT_BLOCK)?.[0], b);
    for (const body of [`${AUTHOR}${b}<p>Author followup.</p>${FOOTER}`, `${AUTHOR}${b}${FOOTER}`, `${AUTHOR}${FOOTER}${b}`]) {
      assert.deepEqual(claim(body).revisions, { bound: [], unbound: [], malformed: [], paths: {} }, body);
      assert.equal(flagged(body, LABELS), 1, body);
      assert.equal(decide(claim(body), { ...CODE_M, revision: BETA }, ANY_SHA).reason, 'revision-not-on-page', body);
    }
  }
});

// Reviewer sentinels: base glues a <pre>'s last line to the next text, so a quoted Revision there was malformed. Ending the
// line at </pre> must not turn it into a binding; a nested <pre> cannot end its outer one early.
test('#669 sentinels: a Revision line quoted inside <pre> never newly binds', () => {
  const quoted = `<pre>quoted\nRevision: ${REV}</pre>`;
  const excerpted = renderMeasurementBlock(CONFIRMED, { ...CODE_M, excerpt: `quoted\nRevision: ${REV}` }, RUNTIME);
  for (const body of [`${AUTHOR}${quoted}<p>Author followup.</p>${FOOTER}`, `${AUTHOR}${quoted}${FOOTER}`,
    `${AUTHOR}${excerpted.replace(/<p>Measured via [^<]*<\/p>/, '')}${FOOTER}`, `${AUTHOR}${excerpted}${FOOTER}`,
    `${AUTHOR}${FOOTER}<pre>a<pre>b</pre>Revision: ${REV}</pre>`]) {
    assert.deepEqual(claim(body).revisions.bound, [], body);
    assert.equal(decide(claim(body), CODE_M, OPT).reason, 'revision-not-on-page', body);
    assert.equal(flagged(body, LABELS), 1, body);
  }
});

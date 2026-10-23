// Issue #669, PR #672 review: only a </pre> that closes a real outermost <pre> ends a line. Comment and CDATA text is
// character data, and an unclosed <pre> ends none, so neither can add a Revision line or a claim signal. Synthetic bodies only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaim, decide, type Measurement } from './confluence-evidence.mts';
import { drainageRules } from './confluence-drainage-rules.mts';

const SHA = 'a'.repeat(40);
const REV = `alpha@${SHA}`;
const BETA = `alpha@${'b'.repeat(40)}`;
const OPT = { now: new Date(2026, 9, 22, 12).getTime(), repoRoot: '/x/alpha', repoTopLevel: '/x/alpha', revisionExists: () => true };
const ASSUMED = ['type-observation', 'evidence-assumed', 'status-author-model'];
const CONFIRMED = ['type-observation', 'evidence-confirmed', 'status-author-model'];
const AUTHOR = '<p>Code: src/queue.mts retries.</p>';
const FOOTER = '<h2>Related pages</h2>';
const M = (revision: string): Measurement => ({ kind: 'code', source: 'alpha', sourceClass: 'repository', command: 'node src/queue.mts',
  excerpt: 'src/queue.mts retries', measuredAt: '2026-10-22', verdict: 'reproduces', revision });
const claim = (body: string) => classifyClaim({ id: '1', version: 3, spaceId: '9', body, labels: ASSUMED }, true);
const flagged = (body: string, labels: string[]) => drainageRules([{ id: '1', version: 3, title: 't', spaceId: '9', parentId: null, body, labels }],
  false).filter(c => c.problem === 'revision-missing-or-invalid').length;
const QUOTED = `<pre>x</pre><p>Revision: ${REV}</p>`;
const LEXICAL: Record<string, string> = {
  comment: `<!-- ${QUOTED} -->`,
  cdata: `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${QUOTED}]]></ac:plain-text-body></ac:structured-macro>`,
  pi: `<?synthetic ${QUOTED}?>`,
};
// One real <pre> whose comment and CDATA spell a fake open and a fake close (reviewer fixture Q).
const Q = '<pre><!-- <pre>fake</pre> --><![CDATA[</pre>]]>x</pre>';

test('#669 lexical: a Revision quoted in a comment or CDATA never binds', () => {
  for (const [name, fragment] of Object.entries(LEXICAL)) {
    const body = `${AUTHOR}${fragment}${FOOTER}`;
    assert.deepEqual(claim(body).revisions.bound, [], name);
    assert.equal(decide(claim(body), M(REV), OPT).reason, 'revision-not-on-page', name);
    assert.equal(flagged(body, CONFIRMED), 1, name);
    assert.equal(flagged(body, ASSUMED), 1, name);
  }
});

test('#669 lexical controls: an author Revision after the comment or CDATA still binds', () => {
  for (const [name, fragment] of Object.entries(LEXICAL)) {
    for (const body of [`${AUTHOR}${fragment}<pre>y</pre><p>Revision: ${BETA}</p>${FOOTER}`, `${AUTHOR}${fragment}<p>x</p><p>Revision: ${BETA}</p>${FOOTER}`]) {
      assert.deepEqual(claim(body).revisions, { bound: [BETA], unbound: [], malformed: [] }, `${name} ${body}`);
      assert.equal(decide(claim(body), M(BETA), OPT).outcome, 'confirmed', body);
      assert.equal(flagged(body, CONFIRMED), 0, body);
    }
  }
});

test('#669 lexical: an unclosed outer <pre> ends no line, and quoted <pre> text after a mark stays unread', () => {
  for (const body of [`${AUTHOR}<pre>a<pre>b</pre><p>Revision: ${REV}</p>${FOOTER}`, `${AUTHOR}<pre>a<pre>b</pre>Revision: ${REV}`,
    `${AUTHOR}<pre>a<!-- </pre> --><p>Revision: ${REV}</p>${FOOTER}`, `${AUTHOR}<pre>Revision: ${REV}</pre><p>tail</p>${FOOTER}`,
    `${AUTHOR}<!-- c --><pre>Revision: ${REV}</pre><p>tail</p>${FOOTER}`, `${AUTHOR}<!-- c>d --><p>Revision: ${REV}<pre>x</pre></p>${FOOTER}`,
    `${AUTHOR}<pre>x\n<!-- c>d -->Revision: ${REV}</pre><p>tail</p>${FOOTER}`]) {
    assert.deepEqual(claim(body).revisions.bound, [], body);
    assert.equal(decide(claim(body), M(REV), OPT).reason, 'revision-not-on-page', body);
    assert.equal(flagged(body, CONFIRMED), 1, body);
  }
});

test('#669 lexical: Host: and Doc: in a comment, CDATA or nested <pre> after an inner </pre> add no signal', () => {
  for (const inner of ['<p>Host: alpha-node</p>', '<p>Doc: vendor guide</p>']) {
    for (const body of [`<p>The queue retries.</p><!-- <pre>x</pre>${inner} -->${FOOTER}`, `<p>The queue retries.</p><![CDATA[<pre>x</pre>${inner}]]>${FOOTER}`,
      `<p>The queue retries.</p><pre>a<pre>b</pre>${inner}</pre>${FOOTER}`]) {
      assert.deepEqual(claim(body).signals, [], body);
    }
  }
});

test('#669 lexical: a historical phrase that spans a </pre> stays historical, as on base', () => {
  const body = `<p>The queue retried twice.</p><pre>measured at the time of</pre>writing${FOOTER}`;
  assert.equal(claim(body).kind, 'historical');
  assert.equal(decide(claim(body), M(REV), OPT).reason, 'historical-not-repeatable');
});

test('#669 lexical: a fake close inside a real <pre> ends nothing; the real close does, for positives and negatives', () => {
  const after = (line: string) => `${AUTHOR}<p>Revision: ${REV}</p>${Q}<p>Revision: ${line}</p>${FOOTER}`;
  for (const line of ['none (no exact binding: dirty tree)', 'alpha@short']) {
    assert.ok([...claim(after(line)).revisions.unbound, ...claim(after(line)).revisions.malformed].includes(line), line);
    assert.equal(decide(claim(after(line)), M(REV), OPT).reason, 'revision-unbound-on-page', line);
    assert.equal(flagged(after(line), CONFIRMED), 1, line);
  }
  for (const body of [`${AUTHOR}${Q}<p>Revision: ${REV}</p>${FOOTER}`, `${AUTHOR}<pre title="x > y">a<pre/>b</pre><p>Revision: ${REV}</p>${FOOTER}`]) {
    assert.deepEqual(claim(body).revisions, { bound: [REV], unbound: [], malformed: [] }, body);
    assert.equal(decide(claim(body), M(REV), OPT).outcome, 'confirmed', body);
  }
});

test('#669 lexical: an opaque region inside a Revision value never joins two halves into a full SHA', () => {
  for (const region of ['<![CDATA[<pre>quoted</pre>]]>', '<!-- <pre>quoted</pre> -->']) {
    const body = `${AUTHOR}<pre>x</pre><p>Revision: alpha@${'a'.repeat(20)}${region}${'a'.repeat(20)}</p>${FOOTER}`;
    assert.deepEqual(claim(body).revisions.bound, [], body);
    assert.equal(decide(claim(body), M(REV), OPT).outcome, 'unknown', body);
  }
});


// PR #672 review 2: a real </pre> followed by quoted claim text in a comment, CDATA section, PI or another <pre> adds no line-anchored signal;
// an author line after such a region does, and a signal base already read inside a region stays.
const SIGNALS: [string, string, string][] = [['Host', 'live', 'target-host'], ['Doc', 'doc', 'official-doc'], ['Code', 'code', 'repository']];
const WRAP: [string, (t: string) => string][] = [['comment', t => `<!-- ${t} -->`], ['cdata', t => `<![CDATA[${t}]]>`], ['pi', t => `<?synthetic ${t}?>`],
  ['bare pre', t => `<pre>${t.replace(/^<p>|<\/p>$/g, '')}</pre>`]];
const measured = (kind: string, sourceClass: string): Measurement => ({ kind, sourceClass, subject: 'queue', source: 'queue', command: 'inspect queue',
  excerpt: 'queue observed', measuredAt: '2026-10-22', verdict: 'reproduces', ...(kind === 'code' ? { revision: REV } : {}) } as Measurement);
const page = (fragment: string) => `<p>The queue retries.</p>${fragment}${FOOTER}`;
const observation = (body: string) => drainageRules([{ id: '1', version: 3, title: 't', spaceId: '9', parentId: null, body,
  labels: ['type-observation', 'evidence-assumed', 'status-author-model'] }], false).filter(c => c.problem === 'revision-missing-or-invalid').length;

test('#669 lexical signals: quoted claim text after a real </pre> adds no signal and confirms nothing', () => {
  for (const [label, kind, sourceClass] of SIGNALS) for (const [name, wrap] of WRAP) {
    const body = page(`<pre>x</pre>${wrap(`<p>${label}: queue</p>`)}`);
    assert.deepEqual(claim(body).signals, [], `${label} ${name}`);
    assert.notEqual(decide(claim(body), measured(kind, sourceClass), OPT).outcome, 'confirmed', `${label} ${name}`);
    assert.equal(observation(body), 0, `${label} ${name}: not code-bound, as on base`);
  }
});

test('#669 lexical signal controls: an author line after the region counts; a signal base read inside one stays', () => {
  for (const [label, kind, sourceClass] of SIGNALS.slice(0, 2)) {
    for (const body of [page(`<pre>x</pre><!-- opaque --><p>${label}: queue</p>`), page(`<!-- >\n${label}: queue\nend -->`)]) {
      assert.deepEqual(claim(body).signals, [kind], body);
      assert.equal(decide(claim(body), measured(kind, sourceClass), OPT).outcome, 'confirmed', body);
    }
  }
  assert.equal(observation(page('<pre>x</pre><!-- opaque --><p>Code: queue</p>')), 1, 'an author Code line after the region is code-bound');
});

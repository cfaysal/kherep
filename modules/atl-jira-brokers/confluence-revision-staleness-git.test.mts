// Issue #693: the git probe. Validation happens before any spawn; the real-git case runs in a temporary
// repository with synthetic files, so it measures the subcommands themselves, not a fake.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from './confluence-evidence-io.mts';
import { gitProbe, parseNameStatus, REF } from './confluence-revision-staleness-git.mts';
import { revisionStaleness } from './confluence-revision-staleness.mts';

test('name-status -z output parses exactly; anything else is a failure', () => {
  assert.deepEqual(parseNameStatus('M\0a b.mts\0D\0c\0'), [{ status: 'M', path: 'a b.mts' }, { status: 'D', path: 'c' }]);
  assert.deepEqual(parseNameStatus(''), []);
  for (const bad of ['M\0', 'R100\0a\0b\0', 'Q\0a\0', 'M\0\0']) assert.equal(parseNameStatus(bad), null, JSON.stringify(bad));
});
test('invalid commits, refs and paths never reach git', async () => {
  const calls: string[][] = [];
  const probe = gitProbe(async (_f, args) => { calls.push(args); return { stdout: '', stderr: '' }; }, '/w/alpha');
  assert.equal(await probe.commit('HEAD'), 'failed');
  assert.equal(await probe.ancestor('a'.repeat(40), 'main'), 'failed');
  assert.equal(await probe.diff('a'.repeat(40), 'b'.repeat(40), ['src/*.mts']), null);
  assert.equal(await probe.diff('a'.repeat(40), 'b'.repeat(40), []), null);
  assert.equal(await probe.pathAt('a'.repeat(40), '../x'), 'failed');
  assert.equal(await probe.resolveRef('main..x'), null);
  assert.deepEqual(calls, []);
  for (const ref of ['HEAD', 'main', 'origin/main', 'v1.2.3', 'feat/x-y_z']) assert.ok(REF.test(ref), ref);
  for (const ref of ['', '-x', 'a..b', 'HEAD@{1}', 'a b', 'main~1', 'main^', 'a:b', 'x'.repeat(201)]) assert.ok(!REF.test(ref), ref);
});
test('a rejected call is never read as unchanged', async () => {
  const probe = gitProbe(async (_f, args) => { if (args.includes('diff') || args.includes('-e')) throw new Error('Command failed: timeout'); return { stdout: '', stderr: '' }; }, '/w');
  assert.equal(await probe.diff('a'.repeat(40), 'b'.repeat(40), ['x']), null);
  assert.equal(await probe.pathAt('a'.repeat(40), 'x'), 'failed');
});

function repo(t: { after(fn: () => void): void }) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-git-')), 'alpha');
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(root, file)); else fs.writeFileSync(path.join(root, file), text);
    }
    git('add', '-A'); git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit };
}
const page = (id: string, line: string) => ({ id, version: 2, title: id, spaceId: '9', parentId: null,
  body: `<p>Revision: ${line}</p>`, labels: ['type-observation', 'evidence-confirmed'] });

test('real git: changed, deleted, renamed-away, unchanged, glob-named, missing and directory paths', async t => {
  const { root, git, commit } = repo(t);
  const first = commit({ 'src/a.mts': 'a\n', 'src/b.mts': 'b\n', 'src/c.mts': 'c\n', 'src/d.mts': 'd\n', 'keep.md': 'k\n' }, 'first');
  git('mv', 'src/d.mts', 'src/moved.mts');
  const second = commit({ 'src/a.mts': 'a2\n', 'src/b.mts': null, 'src/x1.mts': 'new\n' }, 'second');
  const pages = [
    page('1', `alpha@${first} -- src/a.mts`), page('2', `alpha@${first} -- src/b.mts`), page('3', `alpha@${first} -- src/d.mts`),
    page('4', `alpha@${first} -- keep.md`), page('5', `alpha@${first} -- src/never.mts`), page('6', `alpha@${first} -- src`),
    page('7', `alpha@${second} -- src/a.mts`), page('8', `alpha@${'f'.repeat(40)} -- src/a.mts`), page('9', `beta@${first} -- src/a.mts`),
  ];
  const r = await revisionStaleness(pages, { status: 'complete', selected: 9, read: 9 }, { probe: gitProbe(execFileAsync, path.join(root, 'src')), ref: 'HEAD' });
  const by = Object.fromEntries(r.pages.map(p => [p.pageId, `${p.outcome}/${p.reason}`]));
  assert.deepEqual(by, { 1: 'stale/paths-changed', 2: 'stale/paths-changed', 3: 'stale/paths-changed', 4: 'current/paths-unchanged',
    5: 'unknown/path-not-in-repository', 6: 'stale/paths-changed', 7: 'current/paths-unchanged', 8: 'unknown/commit-missing',
    9: 'unknown/repository-not-checked-out' });
  assert.deepEqual(r.pages[2].bindings[0].changed, [{ status: 'D', path: 'src/d.mts' }], 'a rename away is a deletion at the bound path');
  assert.deepEqual(r.pages[5].bindings[0].changed?.map(c => c.path).sort(), ['src/a.mts', 'src/b.mts', 'src/d.mts', 'src/moved.mts', 'src/x1.mts']);
  assert.equal(r.comparedSha, second);
  assert.equal(r.shallow, false);
  assert.equal(r.repository, 'alpha', 'the top level, not the subdirectory given, names the checkout');
  const back = await revisionStaleness([page('1', `alpha@${second} -- src/a.mts`)], { status: 'complete', selected: 1, read: 1 },
    { probe: gitProbe(execFileAsync, root), ref: 'no-such-branch' });
  assert.equal(back.pages[0].reason, 'ref-unresolved');
  git('branch', 'old', first);
  const older = await revisionStaleness([page('1', `alpha@${second} -- src/a.mts`)], { status: 'complete', selected: 1, read: 1 },
    { probe: gitProbe(execFileAsync, root), ref: 'old' });
  assert.equal(older.pages[0].reason, 'commit-not-ancestor');
  const none = await revisionStaleness([page('1', `alpha@${first} -- src/a.mts`)], { status: 'complete', selected: 1, read: 1 },
    { probe: gitProbe(execFileAsync, path.dirname(root)), ref: 'HEAD' });
  assert.equal(none.pages[0].reason, 'checkout-not-a-repository');
});

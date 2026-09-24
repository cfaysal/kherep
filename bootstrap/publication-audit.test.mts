import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { auditRepository } from './publication-audit.mts';

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  return root;
}

test('checks case-insensitive terms in names and contents without echoing matches', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'AcmeLegacy.md'), 'acmeLEGACY contact');
  const report = auditRepository(root, ['acmelegacy']);
  assert.equal(report.files, 1);
  assert.deepEqual(report.issues.map((issue) => issue.category), ['forbidden-path', 'forbidden-content']);
  assert.doesNotMatch(JSON.stringify(report), /acmelegacy/i);
});

test('includes ignored files when tracked, but excludes untracked local settings', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'local.json\n');
  fs.writeFileSync(path.join(root, 'local.json'), 'LegacyBrand');
  assert.equal(auditRepository(root, ['legacybrand']).issues.length, 0);
  execFileSync('git', ['-C', root, 'add', '--force', 'local.json']);
  assert.equal(auditRepository(root, ['legacybrand']).issues.length, 1);
});

test('reports private payload categories without printing values', (t) => {
  const root = fixture(t);
  const email = 'operator' + '@' + 'nonreserved-domain.com';
  const endpoint = ['https://service', 'local/'].join('.');
  const keyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  fs.writeFileSync(path.join(root, 'example.txt'), `${email}\n${endpoint}\n${keyMarker}`);
  const report = auditRepository(root, []);
  assert.deepEqual(report.issues.map((issue) => issue.category), ['email-review', 'private-endpoint', 'secret-marker']);
  assert.doesNotMatch(JSON.stringify(report), /operator|nonreserved|service\.local|BEGIN/);
});

test('accepts reserved documentation addresses and loopback', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'example.md'), 'user@example.com user@example.org https://service.example.invalid http://127.0.0.1:8080');
  assert.deepEqual(auditRepository(root, []).issues, []);
});

test('a missing tracked file is a review finding, not an unexamined clean result', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'missing.md'), 'text');
  execFileSync('git', ['-C', root, 'add', 'missing.md']);
  fs.unlinkSync(path.join(root, 'missing.md'));
  assert.ok(auditRepository(root, []).issues.some((issue) => issue.category === 'unreadable'));
});

test('does not follow a symlink to content outside the repository', (t) => {
  const root = fixture(t);
  const outside = path.join(os.tmpdir(), `publication-external-${process.pid}.txt`);
  fs.writeFileSync(outside, 'sentinel');
  t.after(() => fs.rmSync(outside, { force: true }));
  try { fs.symlinkSync(outside, path.join(root, 'linked.txt')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink creation unavailable'); return; }
    throw error;
  }
  assert.equal(auditRepository(root, []).issues[0].category, 'non-regular-file');
});

test('CLI fails closed when the external publication policy is missing', (t) => {
  const root = fixture(t);
  assert.throws(() => execFileSync(process.execPath, [
    path.join(import.meta.dirname, 'publication-audit.mts'), root,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (error: unknown) => {
    assert.equal((error as { status: number }).status, 2);
    return true;
  });
});

test('a linked parent directory cannot expose an external file', (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const folder = path.join(root, 'directory');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'tracked.md'), 'original');
  execFileSync('git', ['-C', root, 'add', 'directory/tracked.md']);
  fs.unlinkSync(path.join(folder, 'tracked.md'));
  fs.rmdirSync(folder);
  fs.writeFileSync(path.join(outside, 'tracked.md'), 'external-sentinel');
  fs.symlinkSync(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
  const report = auditRepository(root, ['external-sentinel']);
  assert.ok(report.issues.some((issue) => issue.category === 'escaping-path'));
  assert.ok(report.issues.every((issue) => issue.category !== 'forbidden-content'));
});

test('fails closed when clean working-tree bytes hide forbidden staged bytes', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'candidate.md'), 'LegacyBrand');
  execFileSync('git', ['-C', root, 'add', 'candidate.md']);
  fs.writeFileSync(path.join(root, 'candidate.md'), 'clean candidate');
  assert.ok(auditRepository(root, ['legacybrand']).issues.some((issue) => issue.category === 'forbidden-content'));
});

test('redacts sensitive extension filenames in findings', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'customer-prod.pem'), 'fixture');
  const report = auditRepository(root, []);
  assert.ok(report.issues.some((issue) => issue.category === 'sensitive-path'));
  assert.doesNotMatch(JSON.stringify(report), /customer-prod/);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`fails closed when ${flag} suppresses indexed comparisons`, (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'candidate.md'), 'LegacyBrand');
    execFileSync('git', ['-C', root, 'add', 'candidate.md']);
    execFileSync('git', ['-C', root, 'update-index', flag, 'candidate.md']);
    fs.writeFileSync(path.join(root, 'candidate.md'), 'clean candidate');
    assert.ok(auditRepository(root, ['legacybrand']).issues.some((issue) => issue.category === 'forbidden-content'));
  });
}

test('scans staged bytes even when working-tree size and mtime are unchanged', (t) => {
  const root=fixture(t);
  execFileSync('git',['-C',root,'config','core.trustctime','false']);
  execFileSync('git',['-C',root,'config','core.checkStat','minimal']);
  const file=path.join(root,'candidate.md');
  fs.writeFileSync(file,'LegacyBrand');
  const earlier=new Date(Date.now()-60000);
  fs.utimesSync(file,earlier,earlier);
  execFileSync('git',['-C',root,'add','candidate.md']);
  fs.writeFileSync(file,'clean text!');
  fs.utimesSync(file,earlier,earlier);
  assert.ok(auditRepository(root,['legacybrand']).issues.some((issue)=>issue.category==='forbidden-content'));
});

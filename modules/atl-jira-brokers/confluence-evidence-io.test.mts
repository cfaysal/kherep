// The evidence verb's atomic file write against a real temporary directory (issue #519, second review).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWrite, nodeFiles } from './confluence-evidence-io.mts';

const ops = { writeFile, rename, rm: (file: string) => rm(file, { force: true }) };
function scratch(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('atomicWrite replaces the file and leaves no temporary file', async t => {
  const dir = scratch(t);
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, 'old');
  await atomicWrite(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['r.json']);
});

test('a failed write leaves the previous file and no partial file', async t => {
  const dir = scratch(t);
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, 'old');
  const partial = { ...ops, writeFile: async (temp: string, data: string) => {
    await writeFile(temp, data.slice(0, 2));
    throw new Error('disk full');
  } };
  await assert.rejects(() => atomicWrite(file, 'complete', partial), /disk full/);
  assert.deepEqual(fs.readdirSync(dir), ['r.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  const noRename = { ...ops, rename: async () => { throw new Error('rename refused'); } };
  await assert.rejects(() => atomicWrite(path.join(dir, 'b.xml'), 'body', noRename), /rename refused/);
  assert.deepEqual(fs.readdirSync(dir), ['r.json']);
});

test('nodeFiles.exists is false only for an absent file and resolves a real directory', async t => {
  const dir = scratch(t);
  assert.equal(await nodeFiles.exists(path.join(dir, 'absent.json')), false);
  fs.writeFileSync(path.join(dir, 'present.json'), '{}');
  assert.equal(await nodeFiles.exists(path.join(dir, 'present.json')), true);
  assert.equal(await nodeFiles.realpath(dir), fs.realpathSync.native(dir));
  await assert.rejects(() => nodeFiles.realpath(path.join(dir, 'missing')));
});

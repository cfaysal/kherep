// The evidence verb's local boundary (issue #519): git, file and record I/O for
// confluence-evidence-cli.mts. Record and body files hold page content, so they
// must lie outside every git work tree and are replaced atomically.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfluenceError, type ConfluenceSession } from './confluence-contract.mts';
import type { EvidenceRecord } from './confluence-evidence-report.mts';
import type { NeighbourArgs, NeighbourCliContext } from './confluence-neighbour-cli.mts';
import type { ExecLike } from './confluence-semantic.mts';

export interface FileOps {
  // Replaces the file atomically: a failed write leaves the previous file or none, never a partial one.
  write(file: string, data: string): Promise<void>;
  // False only when the file is absent; any other failure rejects.
  exists(file: string): Promise<boolean>;
  realpath(dir: string): Promise<string>;
}
export interface Io {
  ctx: NeighbourCliContext; args: NeighbourArgs; exec: ExecLike; files: FileOps; session: () => ConfluenceSession;
}

export const TIMEOUT = { timeout: 15_000 };
// LC_ALL=C keeps git's messages untranslated: requireOutside matches one of them.
export const execFileAsync: ExecLike = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: options.timeout, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr).slice(0, 200) || error.message));
    else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});
export const fail = (message: string): never => { throw new ConfluenceError(message); };

export interface AtomicOps {
  writeFile(file: string, data: string, options: { encoding: 'utf8'; mode: number; flag: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string): Promise<void>;
}
const NODE_OPS: AtomicOps = { writeFile, rename, rm: file => rm(file, { force: true }) };
// A temporary file in the same directory, then a rename, so readers never see a partial file.
export async function atomicWrite(file: string, data: string, ops: AtomicOps = NODE_OPS): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await ops.writeFile(temp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await ops.rename(temp, file);
  } catch (error) {
    await ops.rm(temp).catch(() => undefined);
    throw error;
  }
}
export const nodeFiles: FileOps = {
  write: (file, data) => atomicWrite(file, data),
  exists: file => lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }),
  realpath: dir => realpath(dir),
};

// Outside means: git runs and says "not a git repository" at the file's resolved directory, so a
// symlinked directory cannot point into a work tree. Any other failure proves nothing and refuses.
export async function requireOutside(io: Io, flag: string): Promise<string> {
  const file = io.args[flag] ?? fail(`--${flag} is missing.`);
  const unproven = (why: string) => fail(`--${flag} cannot be shown to lie outside a repository: ${why}.`);
  await io.exec('git', ['--version'], TIMEOUT).catch(() => unproven('git does not run'));
  const dir = await io.files.realpath(path.dirname(file)).catch(() => unproven('its directory does not resolve'));
  const inside = await io.exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'], TIMEOUT)
    .then(() => true, (error: unknown) => /not a git repository/i.test(String(error)) ? false : unproven('git refused the check'));
  if (inside) fail(`out-inside-repository: --${flag} must point outside every git work tree because it holds page content.`);
  return file;
}
// A record or report is never silently replaced by a new one.
export async function requireAbsent(io: Io, file: string, flag: string): Promise<void> {
  const exists = await io.files.exists(file).catch(() => fail(`--${flag} cannot be checked for an existing file.`));
  if (exists) fail(`out-exists: --${flag} names an existing file; choose a new path.`);
}

export async function readJson(io: Io, flag: string, file = io.args[flag]): Promise<unknown> {
  if (!file) return fail(`--${flag} is missing.`);
  const text = await io.ctx.readFile(file, 'utf8').catch(() => fail(`--${flag} is not readable.`));
  try { return JSON.parse(text); } catch { return fail(`--${flag} is not valid JSON.`); }
}
const stringList = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every(v => typeof v === 'string'));
export async function readRecord(io: Io, file = io.args.record): Promise<EvidenceRecord> {
  const record = await readJson(io, 'record', file) as EvidenceRecord | null;
  if (!record || typeof record.pageId !== 'string' || !/^\d+$/.test(record.pageId) || (!record.claim && !record.excluded)) {
    return fail('--record is not an evidence record.');
  }
  if (!stringList(record.labels) || !stringList(record.labelsAfter)) fail('record malformed: labels must be a list of strings.');
  return record;
}

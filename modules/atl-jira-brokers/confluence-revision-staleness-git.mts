// Issue #693: the read-only git probe of the revision staleness check. Every argument is validated before a
// spawn, git is the only executable, and the subcommands are rev-parse, cat-file, merge-base and diff only.
// A failed or ambiguous call is reported as such; nothing here ever answers "unchanged" by default.
import { PATH } from './confluence-claim-text.mts';
import { TIMEOUT } from './confluence-evidence-io.mts';
import type { ExecLike } from './confluence-semantic.mts';

export interface ChangedPath { status: 'A' | 'M' | 'D' | 'T' | 'U' | 'X'; path: string }
export type Tri = 'yes' | 'no' | 'failed';
export interface GitProbe {
  topLevel(): Promise<string | null>;
  resolveRef(ref: string): Promise<string | null>;
  shallow(): Promise<boolean | 'UNKNOWN'>;
  // yes: a commit object; no: no such object (or not a commit); failed: git could not answer.
  commit(sha: string): Promise<Tri>;
  ancestor(sha: string, refSha: string): Promise<Tri>;
  // null when git failed; else the rows for the given paths only.
  diff(sha: string, refSha: string, paths: string[]): Promise<ChangedPath[] | null>;
  pathAt(sha: string, path: string): Promise<Tri>;
}

export const SHA = /^[0-9a-f]{40}$/;
// --ref: a branch, tag or remote-tracking name; no range, reflog or revision syntax. Passed after --end-of-options.
export const REF = /^(?!.*\.\.)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const STATUS = new Set(['A', 'M', 'D', 'T', 'U', 'X']);
// The name rule of the confirm path (confluence-evidence.mts codeGate): the last segment of <name> must equal
// the last segment of the checkout's top-level directory.
export const repositoryOf = (name: string): string => name.split('/').at(-1) ?? '';
export const checkoutName = (dir: string): string => dir.split(/[\\/]/).filter(Boolean).at(-1) ?? '';

// -z name-status output: status NUL path NUL, repeated. Anything else is unparseable, so the call failed.
export function parseNameStatus(stdout: string): ChangedPath[] | null {
  const parts = stdout.split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length % 2) return null;
  const rows: ChangedPath[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (!STATUS.has(parts[i]) || !parts[i + 1]) return null;
    rows.push({ status: parts[i] as ChangedPath['status'], path: parts[i + 1] });
  }
  return rows;
}
// A row belongs to a bound path when it is that path or lies below it (a bound directory).
export const under = (row: string, path: string): boolean => row === path || row.startsWith(`${path}/`);

export function gitProbe(exec: ExecLike, root: string): GitProbe {
  let top = root;
  const git = (args: string[]) => exec('git', ['-C', top, ...args], TIMEOUT);
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
  return {
    async topLevel() {
      const out = await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], TIMEOUT).then(r => r.stdout.trim(), () => '');
      if (!out) return null;
      top = out; // every later call runs at the top level, so repo-relative paths mean what the page says
      return out;
    },
    async resolveRef(ref) {
      if (!REF.test(ref)) return null;
      const out = await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).then(r => r.stdout.trim(), () => '');
      return SHA.test(out) ? out : null;
    },
    async shallow() {
      const out = await git(['rev-parse', '--is-shallow-repository']).then(r => r.stdout.trim(), () => '');
      return out === 'true' ? true : out === 'false' ? false : 'UNKNOWN';
    },
    async commit(sha) {
      if (!SHA.test(sha)) return 'failed';
      return git(['cat-file', '-t', sha]).then(r => r.stdout.trim() === 'commit' ? 'yes' : 'no',
        error => /could not get object info|Not a valid object name/.test(message(error)) ? 'no' : 'failed');
    },
    async ancestor(sha, refSha) {
      if (!SHA.test(sha) || !SHA.test(refSha)) return 'failed';
      // The best common ancestor is sha exactly when sha is an ancestor of refSha. ExecLike drops the exit
      // code, so --is-ancestor's exit 1 could not be told from a failure; a rejected call stays 'failed'.
      return git(['merge-base', sha, refSha]).then(r => r.stdout.trim() === sha ? 'yes' : SHA.test(r.stdout.trim()) ? 'no' : 'failed', () => 'failed');
    },
    async diff(sha, refSha, paths) {
      if (!SHA.test(sha) || !SHA.test(refSha) || !paths.length || !paths.every(p => PATH.test(p))) return null;
      const out = await git(['diff', '--name-status', '--no-renames', '-z', sha, refSha, '--', ...paths.map(p => `:(literal)${p}`)])
        .then(r => r.stdout, () => null);
      const rows = out === null ? null : parseNameStatus(out);
      return rows && rows.filter(row => paths.some(p => under(row.path, p)));
    },
    async pathAt(sha, path) {
      if (!SHA.test(sha) || !PATH.test(path)) return 'failed';
      return git(['cat-file', '-e', `${sha}:${path}`]).then(() => 'yes' as const,
        error => /does not exist in|exists on disk, but not in/.test(message(error)) ? 'no' : 'failed');
    },
  };
}

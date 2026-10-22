// The evidence verb (issue #519): the I/O around the pure gates in
// confluence-evidence.mts. Confluence is read with GET only. The record and
// body files hold page content, so they must lie outside every git work tree;
// stdout carries ids, versions, kinds, labels, reasons and counts only.
import { execFile } from 'node:child_process';
import { writeFile as nodeWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfluenceError, type ConfluenceSession } from './confluence-contract.mts';
import { findSpace, getPage } from './confluence-content.mts';
import { drainageRules } from './confluence-drainage-rules.mts';
import { drainageSnapshot } from './confluence-drainage-snapshot.mts';
import {
  BOUND_REVISION, classifyClaim, decide, evidenceLabelsOk, insertBeforeFooter, KINDS, renderMeasurementBlock,
  type DecideOptions, type Decision, type Measurement, type MeasuredKind,
} from './confluence-evidence.mts';
import { PROPOSED, renderReport, type EvidenceRecord } from './confluence-evidence-report.mts';
import type { NeighbourArgs, NeighbourCliContext } from './confluence-neighbour-cli.mts';
import { readFailure } from './confluence-pagination.mts';
import { runtimeLabel } from './confluence-runtime-label.mts';
import type { ExecLike } from './confluence-semantic.mts';
import { createSession } from './confluence-session.mts';

export interface EvidenceDeps {
  exec?: ExecLike;
  writeFile?: (file: string, data: string) => Promise<void>;
  // Injected by tests only; the broker builds the session from its context.
  session?: ConfluenceSession;
}
interface Io {
  ctx: NeighbourCliContext; args: NeighbourArgs; exec: ExecLike;
  write: (file: string, data: string) => Promise<void>; session: () => ConfluenceSession;
}

const TIMEOUT = { timeout: 15_000 };
// LC_ALL=C keeps git's messages untranslated: requireOutside matches one of them.
const execFileAsync: ExecLike = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: options.timeout, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr).slice(0, 200) || error.message));
    else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});
const fail = (message: string): never => { throw new ConfluenceError(message); };
const approved = (io: Io): boolean => Object.hasOwn(io.args, 'body-approved');
function numeric(value: string | undefined, flag: string): string {
  return value !== undefined && /^\d+$/.test(value) ? value : fail(`${flag} must be a numeric page id.`);
}

// Outside means: git runs and says "not a git repository" at the file's directory.
// Any other git failure (dubious ownership, a missing directory) proves nothing, so it refuses.
async function requireOutside(io: Io, flag: string): Promise<string> {
  const file = io.args[flag] ?? fail(`--${flag} is missing.`);
  const unproven = (why: string) => fail(`--${flag} cannot be shown to lie outside a repository: ${why}.`);
  await io.exec('git', ['--version'], TIMEOUT).catch(() => unproven('git does not run'));
  const inside = await io.exec('git', ['-C', path.dirname(file), 'rev-parse', '--show-toplevel'], TIMEOUT)
    .then(() => true, (error: unknown) => /not a git repository/i.test(String(error)) ? false : unproven('git refused the check'));
  if (inside) fail(`out-inside-repository: --${flag} must point outside every git work tree because it holds page content.`);
  return file;
}

async function readJson(io: Io, flag: string, file = io.args[flag]): Promise<unknown> {
  if (!file) return fail(`--${flag} is missing.`);
  const text = await io.ctx.readFile(file, 'utf8').catch(() => fail(`--${flag} is not readable.`));
  try { return JSON.parse(text); } catch { return fail(`--${flag} is not valid JSON.`); }
}
async function readRecord(io: Io, file = io.args.record): Promise<EvidenceRecord> {
  const record = await readJson(io, 'record', file) as EvidenceRecord | null;
  if (!record || typeof record.pageId !== 'string' || !/^\d+$/.test(record.pageId) || (!record.claim && !record.excluded)) {
    return fail('--record is not an evidence record.');
  }
  return record;
}

async function prepare(io: Io): Promise<number> {
  const { args, ctx } = io;
  if (!approved(io)) fail('Classify the page and approve its body for this session before preparing (--body-approved).');
  const id = numeric(args.id, '--id');
  if (args.kind !== undefined && !KINDS.includes(args.kind)) fail('--kind takes code, tracker, live or doc.');
  const out = await requireOutside(io, 'out');
  const session = io.session();
  const space = await findSpace(session, args.space ?? '') ?? fail('No space with that key is visible to the service account.');
  const snapshot = await drainageSnapshot(session, id, space.id)
    .catch((error: unknown) => fail(`Snapshot failed: ${readFailure(error).reason}. Nothing was written.`));
  const claim = classifyClaim(snapshot, true, args.kind as MeasuredKind | undefined);
  const record: EvidenceRecord = { pageId: id, readVersion: snapshot.version, spaceId: space.id, spaceKey: space.key,
    parentId: snapshot.parentId, title: snapshot.title, body: snapshot.body, labels: snapshot.labels, claim };
  await io.write(out, JSON.stringify(record, null, 2));
  const { bound, unbound, malformed } = claim.revisions;
  for (const line of [`id: ${id}`, `version: ${snapshot.version}`,
    `kind: ${claim.kind}${claim.classifiedKind ? ` (override; classified ${claim.classifiedKind})` : ''}`,
    `evidence: ${claim.evidenceLabel}`, `status-author: ${claim.statusAuthor}`, `passive labels: ${claim.passiveLabels.join(', ') || 'none'}`,
    `revisions: bound ${bound.length}, unbound ${unbound.length}, malformed ${malformed.length}`,
    `code tokens: ${claim.codeTokens.length}`, `tracker keys: ${claim.trackerKeys.length}`, 'record: written']) ctx.log(line);
  return 0;
}

// git sees only a validated 40-hex SHA and the operator's checkout path.
async function repository(io: Io, m: Partial<Measurement> | null): Promise<Partial<DecideOptions>> {
  const root = io.args['repo-root'];
  if (!root) return {};
  const sha = (m?.revision ?? '').slice(-40);
  if (m?.kind !== 'code' || !BOUND_REVISION.test(m.revision ?? '') || !/^[0-9a-f]{40}$/.test(sha)) return { repoRoot: root };
  const top = await io.exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], TIMEOUT).then(r => r.stdout.trim(), () => '');
  const exists = await io.exec('git', ['-C', root, 'cat-file', '-t', sha], TIMEOUT).then(r => r.stdout.trim() === 'commit', () => false);
  return { repoRoot: root, ...(top ? { repoTopLevel: top } : {}), revisionExists: (candidate: string) => candidate === sha && exists };
}

async function decideMode(io: Io): Promise<number> {
  const { args, ctx } = io;
  const raw = args['max-age-days'];
  const maxAgeDays = raw === undefined ? undefined : Number(raw);
  if (maxAgeDays !== undefined && (!Number.isInteger(maxAgeDays) || maxAgeDays < 0)) fail('--max-age-days must be a whole number.');
  if (maxAgeDays !== undefined && maxAgeDays > 7) fail('max-age-days-above-cap: --max-age-days is capped at 7.');
  const supersededBy = args['superseded-by'];
  if (supersededBy !== undefined) numeric(supersededBy, '--superseded-by');
  // The superseding page's title enters this process, so its read needs approval too.
  if (supersededBy !== undefined && !approved(io)) fail('--superseded-by reads another page; approve it first (--body-approved).');
  const outBody = await requireOutside(io, 'out-body');
  const recordPath = await requireOutside(io, 'record');
  const record = await readRecord(io);
  if (!record.claim || typeof record.body !== 'string') fail('--record holds no prepared page.');
  const measurement = await readJson(io, 'measurement');
  const m = measurement && typeof measurement === 'object' ? measurement as Partial<Measurement> : null;
  if (supersededBy !== undefined && m?.supersededBy !== undefined && m.supersededBy !== supersededBy) {
    fail('--superseded-by differs from supersededBy in the measurement.');
  }
  const options: DecideOptions = { now: ctx.now(), maxAgeDays, ...(await repository(io, m)) };
  if (supersededBy !== undefined && supersededBy !== record.pageId) {
    const page = await getPage(io.session(), supersededBy);
    options.superseded = { id: page.id, title: page.title, spaceId: page.spaceId, spaceKey: record.spaceKey ?? '' };
  }
  let decision: Decision = decide(record.claim!, measurement, options);
  const labels = record.labels ?? [];
  let body: string | undefined;
  let after = labels;
  if (PROPOSED.includes(decision.outcome)) {
    after = [...new Set([...labels.filter(l => !decision.labelsRemove.includes(l)), ...decision.labelsAdd])].sort();
    body = insertBeforeFooter(record.body!, renderMeasurementBlock(decision, m as Measurement, runtimeLabel(ctx.credEnv, ctx.env), options.superseded));
    // Defect 1, checked on the result: the next drainage scan must accept the promoted page.
    const scan = drainageRules([{ id: record.pageId, version: record.readVersion ?? 0, title: '', spaceId: record.spaceId ?? '',
      parentId: null, body, labels: after }], false);
    if (scan.some(c => c.problem === 'revision-missing-or-invalid')) {
      decision = { outcome: 'unknown', reason: 'promoted-body-revision-invalid', labelsAdd: [], labelsRemove: [] };
      [body, after] = [undefined, labels];
    }
  }
  const keep = decision.reason !== 'excerpt-secret-marker' && m ? { measurement: m as Measurement } : {};
  const updated: EvidenceRecord = { ...record, ...keep, decision, labelsAfter: after };
  if (body !== undefined) await io.write(outBody, body);
  await io.write(recordPath, JSON.stringify(updated, null, 2));
  const diff = decision.labelsAdd.length ? `${decision.labelsAdd.map(l => `+${l}`).join(', ')} / ${decision.labelsRemove.map(l => `-${l}`).join(', ')}` : 'none';
  for (const line of [`outcome: ${decision.outcome}`, `reason: ${decision.reason}`, `labels: ${diff}`,
    `body: ${body === undefined ? 'not written' : 'written'}`]) ctx.log(line);
  return body === undefined ? 2 : 0;
}

async function verify(io: Io): Promise<number> {
  const record = await readRecord(io);
  const outcome = record.decision?.outcome ?? '';
  if (!PROPOSED.includes(outcome)) fail('--record holds no proposed change to verify.');
  const file = io.args['body-file'] ?? fail('--body-file is missing.');
  const expected = await io.ctx.readFile(file, 'utf8').catch(() => fail('--body-file is not readable.'));
  const snapshot = await drainageSnapshot(io.session(), record.pageId, record.spaceId ?? '')
    .catch((error: unknown) => fail(`Readback failed: ${readFailure(error).reason}. Result UNVERIFIED.`));
  const evidence = snapshot.labels.filter(l => l.startsWith('evidence-')).sort();
  io.ctx.log(`version: ${snapshot.version}`);
  if (snapshot.body !== expected) io.ctx.log('readback: mismatch body');
  else if (!evidenceLabelsOk(snapshot.labels, outcome)) io.ctx.log(`readback: mismatch labels (${evidence.join(', ') || 'none'})`);
  else { io.ctx.log('readback: match'); return 0; }
  return 2;
}

async function report(io: Io): Promise<number> {
  const files = (io.args.records ?? '').split(',').filter(Boolean);
  if (!files.length) fail('--records is missing.');
  const records: EvidenceRecord[] = [];
  for (const file of files) records.push(await readRecord(io, file));
  io.ctx.log(renderReport(records).trimEnd());
  return 0;
}

async function recordMode(io: Io): Promise<number> {
  const id = numeric(io.args.id, '--id');
  const excluded = io.args.excluded ?? '';
  if (!['private', 'unavailable'].includes(excluded)) fail('--excluded takes private or unavailable.');
  // A slug, not prose: free text could carry page content into the report.
  const reason = io.args.reason ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(reason)) fail('--reason must be a short slug such as private-no-local-route.');
  const out = await requireOutside(io, 'out');
  await io.write(out, JSON.stringify({ pageId: id, excluded, reason }, null, 2));
  for (const line of [`id: ${id}`, `excluded: ${excluded}`, `reason: ${reason}`]) io.ctx.log(line);
  return 0;
}

const MODES: Record<string, (io: Io) => Promise<number>> = { prepare, decide: decideMode, verify, report, record: recordMode };

// Exit 0: proposed change or report; 2: unknown, reported-only or readback
// mismatch; a thrown ConfluenceError is exit 1 at the broker boundary.
export async function cmdEvidence(ctx: NeighbourCliContext, args: NeighbourArgs, deps: EvidenceDeps = {}): Promise<number> {
  const run = MODES[args.mode ?? ''];
  if (!Object.hasOwn(MODES, args.mode ?? '')) fail('--mode takes prepare, decide, verify, report or record.');
  let session = deps.session;
  return run({ ctx, args, exec: deps.exec ?? execFileAsync,
    write: deps.writeFile ?? ((file, data) => nodeWriteFile(file, data, { encoding: 'utf8', mode: 0o600 })),
    session: () => (session ??= createSession(ctx)) });
}

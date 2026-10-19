#!/usr/bin/env node
// Explicit recovery of a pending repair whose target an outside writer replaced
// (issue #507, part 2, F2). Run by an operator, never by a hook or an installer:
//   node replay-pending.mts inspect --hooks-root <root>
//   node replay-pending.mts replay --hooks-root <root> --intent <id> --desired-sha <sha256>
//     --current-dev <decimal> --current-ino <decimal> --current-sha <sha256>
//
// inspect reads the pending intent and measures its target through a checked
// read descriptor; it creates and changes nothing. replay means: write the
// already recorded bytes into the one replacement file the operator confirmed
// by identity and hash, even if that file holds another version. It binds the
// pending intent to that file (only target_dev and target_ino change; the
// recorded bytes, their hash and the original before-hash stay) and commits
// that before any write; then the ordinary replay writes in place, in the same
// inode, and clears the intent only when the target is proven. A crash after
// the binding leaves an ordinary pending intent that the next admitted process
// completes. Nothing here deletes, resets or initializes the database, picks a
// source, runs a hook or writes a heartbeat. Output: fixed codes, root-relative
// paths and hashes only. Static imports: node:* and this directory only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Id, isRefusal, type Opened, openDatabase, read, refuse, rollbackQuietly, run, sameId, schemaState, sqliteKind } from "./coordinator-db.mts";
import { applyPending, type Intent, pendingIntent, sha256, targetOf, type WriteExact, type WriteSeams } from "./coordinator-intent.mts";

export interface ReplayArgs { hooksRoot: string; intent: string; desiredSha: string; currentDev: string; currentIno: string; currentSha: string }
export interface Seams { afterRebind?: () => void; afterRebindCommit?: () => void; beforeClearCommit?: () => void; write?: WriteSeams; writer?: WriteExact }
export interface Outcome { ok: boolean; code: string; lines: string[] }

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DEC = /^(0|[1-9][0-9]{0,39})$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const BUSY_MS = 10_000;
const done = (ok: boolean, code: string, lines: string[] = []): Outcome => ({ ok, code, lines });

// A refusal whose code is printed as it is: one of the fixed kinds or codes below.
class Refused extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const stop = (code: string): never => { throw new Refused(code); };
const codeOf = (error: unknown): string => error instanceof Refused ? error.code : isRefusal(error) ? error.kherepKind : "unavailable";

function lstatOrNull(file: string): fs.BigIntStats | null {
  try { return fs.lstatSync(file, { bigint: true }); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : stop("target-unreadable");
  }
}

// The intent's target measured through a read descriptor: its root and parent are
// the recorded ones and inside the root, the leaf is one regular single-link file,
// and the path names that same file before and after it is read.
export function measureTarget(o: Opened, intent: Intent): { id: Id; sha: string } {
  const file = targetOf(o, intent.rel);
  const dir = path.dirname(file);
  const rootNow = lstatOrNull(o.root);
  if (!rootNow || !sameId(rootNow, intent.root) || !sameId(o.rootId, intent.root)) stop("root-moved");
  const parent = lstatOrNull(dir);
  if (!parent?.isDirectory() || !sameId(parent, intent.parent)) stop("parent-moved");
  let real = "";
  try { real = fs.realpathSync(dir); } catch { stop("parent-moved"); }
  const rel = path.relative(o.root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) stop("parent-outside");
  const leaf = lstatOrNull(file);
  if (!leaf) stop("target-absent");
  if (leaf!.isSymbolicLink()) stop("target-link");
  if (!leaf!.isFile()) stop("target-irregular");
  if (leaf!.nlink !== 1n) stop("target-shared");
  if (process.platform === "win32" && !leaf!.dev && !leaf!.ino) stop("target-unmeasurable");
  let fd: number | null = null;
  let bytes: Buffer;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameId(opened, leaf!) || opened.nlink !== 1n) stop("target-changed");
    bytes = fs.readFileSync(fd);
  } catch (error) {
    throw error instanceof Refused ? error : new Refused("target-unreadable");
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* measured already */ }
  }
  const after = lstatOrNull(file);
  const parentAfter = lstatOrNull(dir);
  if (!after || !sameId(after, leaf!) || !parentAfter || !sameId(parentAfter, intent.parent)) stop("target-changed");
  return { id: { dev: leaf!.dev, ino: leaf!.ino }, sha: sha256(bytes!) };
}

// BEGIN EXCLUSIVE, retried while SQLite reports busy, for a bounded time.
async function exclusive(o: Opened): Promise<void> {
  const until = Date.now() + BUSY_MS;
  for (;;) {
    try { run(o.conn, "BEGIN EXCLUSIVE"); return; } catch (error) {
      if (sqliteKind(error) !== "busy" || Date.now() >= until) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The database as it is: never created, initialized or reset here.
async function open(hooksRoot: string): Promise<Opened> {
  if (!path.isAbsolute(hooksRoot)) stop("usage");
  try { return await openDatabase(hooksRoot, { existing: true }); } catch (error) { throw new Refused(codeOf(error)); }
}

export async function inspect(hooksRoot: string): Promise<Outcome> {
  let o: Opened | null = null;
  try {
    o = await open(hooksRoot);
    run(o.conn, "BEGIN");
    const state = schemaState(o.conn);
    if (state === "foreign") stop("schema");
    const intent = state === "ready" ? pendingIntent(o) : null;
    if (!intent) return done(true, "no-pending");
    const lines = [`intent=${intent.intent}`, `target=${intent.rel}`, `desired-sha=${intent.sha}`,
      `recorded-target=${intent.target ? `${intent.target.dev}:${intent.target.ino}` : "absent"}`];
    if (!intent.target) return done(true, "pending", [...lines, "current=unsupported (the target was recorded absent)"]);
    try {
      const now = measureTarget(o, intent);
      lines.push(`current-dev=${now.id.dev}`, `current-ino=${now.id.ino}`, `current-sha=${now.sha}`);
    } catch (error) {
      lines.push(`current=${codeOf(error)}`);
    }
    return done(true, "pending", lines);
  } catch (error) {
    return done(false, codeOf(error));
  } finally {
    if (o) { rollbackQuietly(o.conn); o.conn.close(); }
  }
}

function validArgs(a: ReplayArgs): boolean {
  return typeof a.hooksRoot === "string" && path.isAbsolute(a.hooksRoot) && HEX32.test(a.intent ?? "") && HEX64.test(a.desiredSha ?? "")
    && DEC.test(a.currentDev ?? "") && DEC.test(a.currentIno ?? "") && HEX64.test(a.currentSha ?? "");
}

export async function replay(a: ReplayArgs, seams: Seams = {}): Promise<Outcome> {
  if (!validArgs(a)) return done(false, "usage");
  const confirmed: Id = { dev: BigInt(a.currentDev), ino: BigInt(a.currentIno) };
  let o: Opened | null = null;
  try {
    o = await open(a.hooksRoot);
    // 1. Bind the pending intent to the confirmed replacement file, committed before any write.
    await exclusive(o);
    if (schemaState(o.conn) !== "ready") stop("schema");
    const intent = pendingIntent(o) ?? stop("no-pending");
    if (intent.intent !== a.intent) stop("intent-mismatch");
    if (intent.sha !== a.desiredSha) stop("desired-mismatch");
    if (!intent.target) stop("absent-target-unsupported");
    const now = measureTarget(o, intent);
    if (!sameId(now.id, confirmed) || now.sha !== a.currentSha) stop("current-mismatch");
    let changed = 0;
    try {
      changed = Number(o.conn.prepare("UPDATE pending SET target_dev = ?, target_ino = ? WHERE id = 1 AND intent = ? AND sha256 = ? "
        + "AND target_dev = ? AND target_ino = ?").run(String(confirmed.dev), String(confirmed.ino), intent.intent, intent.sha,
        String(intent.target!.dev), String(intent.target!.ino)).changes);
    } catch { stop("rebind-failed"); }
    if (changed !== 1) stop("rebind-failed");
    seams.afterRebind?.();
    run(o.conn, "COMMIT");
    seams.afterRebindCommit?.();
    // 2. The ordinary replay, under a new EXCLUSIVE: the state is read again, not assumed.
    await exclusive(o);
    const current = pendingIntent(o);
    if (current && current.intent !== intent.intent) stop("successor-pending");
    let why = "";
    if (current) {
      if (!current.target || !sameId(current.target, confirmed) || current.sha !== intent.sha) stop("intent-changed");
      const writer = seams.writer ?? (await import("./recovery/restore-write.mts")).writeExact as WriteExact;
      const result = applyPending(o, writer, seams.write);
      if (result.state === "refused") why = result.why;
      seams.beforeClearCommit?.();
    }
    run(o.conn, "COMMIT");
    if (why) return done(false, "replay-refused", [`why=${why}`]);
    // 3. Success only on measurement: the intent is gone and the confirmed file holds the desired bytes.
    run(o.conn, "BEGIN");
    const left = Number(read(o.conn, "SELECT count(*) AS n FROM pending WHERE intent = ?", intent.intent)?.n);
    const proof = measureTarget(o, { ...intent, target: confirmed });
    if (left !== 0 || !sameId(proof.id, confirmed) || proof.sha !== intent.sha) stop("unproven");
    return done(true, current ? "replayed" : "replayed-elsewhere", [`target=${intent.rel}`, `sha=${proof.sha}`]);
  } catch (error) {
    return done(false, codeOf(error));
  } finally {
    if (o) { rollbackQuietly(o.conn); o.conn.close(); }
  }
}

const FLAGS: Record<string, keyof ReplayArgs> = { "--hooks-root": "hooksRoot", "--intent": "intent", "--desired-sha": "desiredSha",
  "--current-dev": "currentDev", "--current-ino": "currentIno", "--current-sha": "currentSha" };

export function parse(argv: string[]): { command: string; args: Partial<ReplayArgs> } | null {
  const [command, ...rest] = argv;
  const args: Partial<ReplayArgs> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = FLAGS[rest[i]!];
    if (!key || rest[i + 1] === undefined || args[key] !== undefined) return null;
    args[key] = rest[i + 1];
  }
  const allowed = command === "inspect" ? ["hooksRoot"] : command === "replay" ? Object.values(FLAGS) : null;
  return allowed && Object.keys(args).every((key) => allowed.includes(key)) ? { command: command!, args } : null;
}

async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2));
  const outcome = !parsed ? done(false, "usage")
    : parsed.command === "inspect" ? await inspect(parsed.args.hooksRoot ?? "") : await replay(parsed.args as ReplayArgs);
  process.stdout.write([`replay-pending: ${outcome.code}`, ...outcome.lines].join("\n") + "\n");
  if (outcome.code === "usage") process.stderr.write("usage: replay-pending.mts inspect --hooks-root <root> | replay --hooks-root <root> "
    + "--intent <id> --desired-sha <sha256> --current-dev <n> --current-ino <n> --current-sha <sha256>\n");
  return outcome.code === "usage" ? 2 : outcome.ok ? 0 : 1;
}

const self = fileURLToPath(import.meta.url);
const real = (file: string): string => { try { return fs.realpathSync(file); } catch { return file; } };
if (process.argv[1] && real(path.resolve(process.argv[1])) === real(self)) {
  main().then((code) => { process.exitCode = code; }, () => { process.stdout.write("replay-pending: unavailable\n"); process.exitCode = 1; });
}

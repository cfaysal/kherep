// Admission of one hook process to its hooks directory (issue #507, part 2).
//
// entry.mts starts every managed hook as `node --import=<preload> <main>`. The
// preload imports this file and calls preload(), which admits the process
// before Node loads the main or any of its imports, then tells the entry
// "ready" over the private IPC channel. A reader holds a read transaction for
// its whole life; a writer (only live-hook-integrity.mts) holds EXCLUSIVE. A
// pending repair intent is replayed under EXCLUSIVE before any reader is
// admitted, so no admitted process loads a half-written file. The transaction
// belongs to the process that runs the hook: it ends when that process ends,
// whatever happens to its parent. The capability on globalThis lets the main
// hand admission to its own node children (guards, the integrity writer),
// release a reader early, and run repairs through the persisted intent.
// Static imports: node:* and this directory only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  initialize, isRefusal, type Kind, openDatabase, type Opened, read, refuse, rollbackQuietly, run, schemaState, sqliteKind,
} from "./coordinator-db.mts";
import { type Applied, applyPending, recordIntent, sha256, shaOf, targetOf, type WriteExact } from "./coordinator-intent.mts";

export const PROTOCOL = 1;
export const CAPABILITY = Symbol.for("kherep.hook-runtime");
export type Mode = "reader" | "writer";
// root: the hooks directory this installation repairs, <home>/hooks beside <home>/kherep/hook-runtime.
// Every process of one installation is admitted on that one root's database, a main in a
// subdirectory of it included; the root is never derived from the main's own directory.
export interface Config { v: number; mode: Mode; root: string; target: string; deadline: number }
export const HOOKS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");
export interface Restored { proven: boolean; sha?: string; why?: string }
interface Common { root: string; deadline: number; childArgs: (file: string) => string[]; writerArgs: (file: string) => string[] }
export interface ReaderCapability extends Common { mode: "reader"; release: () => void }
export interface WriterCapability extends Common {
  mode: "writer";
  holding: () => boolean;
  begin: () => Promise<boolean>;
  end: () => void;
  repair: (rel: string, bytes: Uint8Array, probe?: { afterPrepare?: () => unknown }) => Promise<Restored>;
}

// Drops exactly the runtime's own experimental warnings (node:sqlite, type stripping of
// its .mts files) and hands every other warning to Node's own listeners. Node prints a
// warning on a later tick, so this also catches the one this process's load emitted.
const QUIET = "{const q=new Set([\"SQLite is an experimental feature and might change at any time\",\"Type Stripping is an "
  + "experimental feature and might change at any time\"]),d=process.listeners(\"warning\");process.removeAllListeners("
  + "\"warning\");process.on(\"warning\",w=>{if(!(w&&w.name===\"ExperimentalWarning\"&&q.has(w.message)))for(const l "
  + "of d)l.call(process,w)})}";

// Identical in entry.mts (a test compares them): the --import argument that admits a node process.
export function preloadArg(coordinatorUrl: string, config: Config): string {
  const program = `${QUIET}try{const m=await import(${JSON.stringify(coordinatorUrl)});await m.preload(${JSON.stringify(config)})}`
    + "catch(e){const k=e&&e.kherepKind;process.stderr.write(\"[hook-runtime] not admitted (\"+(typeof k===\"string\"&&"
    + "/^[a-z-]{1,24}$/.test(k)?k:\"bootstrap failed\")+\")\\n\");process.exit(70)}";
  return `--import=data:text/javascript,${encodeURIComponent(program)}`;
}

// The reasons a target refuses its repair, worded as restore-write.mts words them.
const REFUSED: Partial<Record<Kind, string>> = {
  "target-link": "target is a symbolic link; refusing to write through it",
  "target-irregular": "target is not a regular file; refusing to write",
  "target-shared": "target has more than one link; refusing to write through a shared inode",
  "target-outside": "hooks directory or its subdirectory resolves outside the hooks root",
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (): Promise<void> => sleep(10 + Math.floor(Math.random() * 20));
const recoveryWriter = async (): Promise<WriteExact> => {
  try { return (await import("./recovery/restore-write.mts")).writeExact as WriteExact; } catch { throw refuse("recovery"); }
};

// Retries attempt while SQLite reports busy, until the clock passes `until`.
async function retrying<T>(until: number, attempt: () => Promise<T> | T, conn: Opened["conn"]): Promise<T> {
  for (;;) {
    try { return await attempt(); } catch (error) {
      rollbackQuietly(conn);
      const kind = sqliteKind(error);
      if (kind !== "busy" || Date.now() >= until) throw refuse(kind);
    }
    await backoff();
  }
}

// Under one EXCLUSIVE transaction: replays a pending intent and commits.
async function recoverOnce(o: Opened): Promise<void> {
  run(o.conn, "BEGIN EXCLUSIVE");
  const result = applyPending(o, await recoveryWriter());
  run(o.conn, "COMMIT");
  if (result.state === "refused" && !result.cleared) throw refuse("recovery");
}

// A read transaction over a ready schema without a pending intent, held on return.
async function admitReader(o: Opened, until: number): Promise<void> {
  await retrying(until, async () => {
    for (;;) {
      run(o.conn, "BEGIN");
      const state = schemaState(o.conn); // an actual read: SQLite takes the shared lock here
      if (state === "foreign") throw refuse("schema");
      if (state === "ready" && Number(read(o.conn, "SELECT count(*) AS n FROM pending")?.n) === 0) return;
      rollbackQuietly(o.conn);
      if (state === "empty") initialize(o.conn);
      else await recoverOnce(o);
    }
  }, o.conn);
}

// EXCLUSIVE over a ready schema without a pending intent, held on return.
async function admitWriter(o: Opened, until: number, seen: Applied[] = []): Promise<void> {
  await retrying(until, async () => {
    for (;;) {
      if (schemaState(o.conn) === "empty") initialize(o.conn);
      run(o.conn, "BEGIN EXCLUSIVE");
      if (schemaState(o.conn) !== "ready") throw refuse("schema");
      const result = applyPending(o, await recoveryWriter());
      if (result.state === "none") return;
      run(o.conn, "COMMIT");
      seen.push(result);
      if (result.state === "refused" && !result.cleared) throw refuse("recovery");
    }
  }, o.conn);
}

// The main must be a non-empty regular file directly in or below the root.
function checkMain(root: string, target: string, mode: Mode): void {
  let real: string;
  try { real = fs.realpathSync(target); } catch { throw refuse("main-missing"); }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw refuse("main-outside");
  const st = fs.statSync(real);
  if (!st.isFile()) throw refuse("main-missing");
  if (st.size === 0) throw refuse("main-empty");
  if (mode === "writer" && (path.basename(real) !== "live-hook-integrity.mts" || path.dirname(real) !== root)) throw refuse("mode");
}

function validConfig(config: Config): boolean {
  return !!config && config.v === PROTOCOL && (config.mode === "reader" || config.mode === "writer")
    && typeof config.root === "string" && path.resolve(config.root) === HOOKS_ROOT
    && typeof config.target === "string" && path.isAbsolute(config.target) && Number.isFinite(config.deadline);
}

export async function admit(config: Config): Promise<ReaderCapability | WriterCapability> {
  if (!validConfig(config)) throw refuse("mode");
  const until = Math.min(config.deadline - 1000, Date.now() + (config.mode === "writer" ? 3000 : 10_000));
  // Reading the journal mode while a writer holds EXCLUSIVE is busy as well.
  let o: Opened;
  for (;;) {
    try { o = await openDatabase(config.root); break; } catch (error) {
      if (sqliteKind(error) !== "busy" || Date.now() >= until) throw error;
    }
    await backoff();
  }
  try {
    if (config.mode === "reader") await admitReader(o, until);
    else await admitWriter(o, until);
    checkMain(o.root, config.target, config.mode);
  } catch (error) {
    rollbackQuietly(o.conn);
    o.conn.close();
    throw isRefusal(error) ? error : refuse("unavailable");
  }
  const args = (mode: Mode) => (file: string): string[] =>
    [preloadArg(import.meta.url, { v: PROTOCOL, mode, root: config.root, target: file, deadline: config.deadline }), file];
  const common = { root: o.root, deadline: config.deadline, childArgs: args("reader"), writerArgs: args("writer") };
  if (config.mode === "reader") {
    let open = true;
    return { ...common, mode: "reader", release: () => { if (open) { open = false; rollbackQuietly(o.conn); o.conn.close(); } } };
  }
  return writerCapability(o, common, config.deadline);
}

function writerCapability(o: Opened, common: Common, deadline: number): WriterCapability {
  let holding = true;
  let seen: Applied[] = [];
  const begin = async (): Promise<boolean> => {
    if (holding) return true;
    seen = [];
    try { await admitWriter(o, Math.min(deadline - 1000, Date.now() + 3000), seen); } catch { return false; }
    holding = true;
    return true;
  };
  return {
    ...common, mode: "writer", holding: () => holding, begin,
    end: () => { if (holding) { holding = false; rollbackQuietly(o.conn); } },
    repair: async (rel, bytes, probe = {}) => {
      // Gives up this attempt: the transaction is rolled back and the hold taken again.
      const reacquire = async (why: string): Promise<Restored> => {
        rollbackQuietly(o.conn);
        holding = false;
        await begin();
        return { proven: false, why };
      };
      if (!holding) return { proven: false, why: "no exclusive hold on the hooks directory" };
      let intent: string;
      try {
        intent = recordIntent(o, rel, bytes).intent;
      } catch (error) {
        // Refused before anything was recorded: the hold stays as it was.
        const kind = (error as { kherepKind?: Kind }).kherepKind ?? "unavailable";
        if (kind !== "unavailable") return { proven: false, why: REFUSED[kind] ?? `the repair could not be recorded (${kind})` };
        return reacquire("the repair could not be recorded (unavailable)");
      }
      try {
        run(o.conn, "COMMIT");
      } catch {
        return reacquire("the repair could not be committed");
      }
      holding = false;
      await probe.afterPrepare?.();
      if (!(await begin())) return { proven: false, why: "busy after the repair was recorded; the next admitted run completes it" };
      const mine = seen.find((item) => item.state !== "none" && item.intent === intent);
      if (mine?.state === "applied") return { proven: true, sha: mine.sha };
      if (mine?.state === "refused") return { proven: false, why: mine.why };
      // Another admitted process replayed this intent in the gap: measured here, not assumed.
      const want = sha256(bytes);
      return shaOf(targetOf(o, rel)) === want ? { proven: true, sha: want }
        : { proven: false, why: "the recorded repair was replaced before it was applied here" };
    },
  };
}

// Called by the preload: admit, publish the capability, then tell the entry.
export async function preload(config: Config): Promise<void> {
  const capability = await admit(config);
  (globalThis as Record<symbol, unknown>)[CAPABILITY] = capability;
  if (typeof process.send !== "function") throw refuse("ipc");
  await new Promise<void>((resolve, reject) => {
    process.send!({ kherep: "ready", v: PROTOCOL, pid: process.pid }, undefined, {}, (error) => (error ? reject(refuse("ipc")) : resolve()));
  });
  process.channel?.unref();
}

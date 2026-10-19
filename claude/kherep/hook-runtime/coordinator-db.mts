// The coordination database of one hooks directory (issue #507, part 2).
//
// <real hooks root>/.kherep-integrity/run.sqlite is permanent: it is created
// once, never unlinked, renamed, replaced or opened as a plain file while a
// connection holds it. A directory link at .kherep-integrity, a database that
// is a link or has a second name, or a root whose identity moves while the
// database opens is refused. The journal mode must read DELETE: only there does
// an EXCLUSIVE transaction exclude readers (WAL would not). Readers hold a read
// transaction, writers an EXCLUSIVE one; busy_timeout is 0, the callers retry.
//
// The schema is created only when SQLite itself shows an uninitialized file
// (no objects, user_version 0, application_id 0), inside BEGIN EXCLUSIVE, with
// the version in the same commit, so a crash leaves either nothing or all of it.
// Anything else that is not the exact schema is foreign and never touched.
// Static imports: node:* only; node:sqlite is imported when needed.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;
export const APPLICATION_ID = 0x4b485250; // "KHRP"
export const SCHEMA_SQL = "CREATE TABLE pending (id INTEGER PRIMARY KEY CHECK (id = 1), intent TEXT NOT NULL, "
  + "root_dev TEXT NOT NULL, root_ino TEXT NOT NULL, rel TEXT NOT NULL, parent_dev TEXT NOT NULL, parent_ino TEXT NOT NULL, "
  + "target_dev TEXT, target_ino TEXT, absent INTEGER NOT NULL CHECK (absent IN (0, 1)), before_sha256 TEXT NOT NULL, "
  + "bytes BLOB NOT NULL, sha256 TEXT NOT NULL)";

// Fixed reasons only: no path, SQL or SQLite text ever leaves this module.
export type Kind = "busy" | "unavailable" | "root" | "database" | "schema" | "pending-invalid" | "recovery"
  | "main-missing" | "main-empty" | "main-outside" | "mode" | "ipc" | "not-holding"
  | "target-link" | "target-irregular" | "target-shared" | "target-outside";
export type Refusal = Error & { kherepKind: Kind };
export const refuse = (kind: Kind): Refusal => Object.assign(new Error(`hook runtime: ${kind}`), { kherepKind: kind });
export const isRefusal = (error: unknown): error is Refusal => typeof (error as Refusal)?.kherepKind === "string";

export interface Id { dev: bigint; ino: bigint }
export interface Opened { conn: DatabaseSync; root: string; rootId: Id; file: string }

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const idOf = (st: fs.BigIntStats): Id => ({ dev: st.dev, ino: st.ino });
const sameId = (a: Id, b: Id): boolean => a.dev === b.dev && a.ino === b.ino;

// SQLITE_BUSY (5) and SQLITE_LOCKED (6), by Node's numeric field; everything else fails closed.
export function sqliteKind(error: unknown): Kind {
  if (isRefusal(error)) return error.kherepKind;
  const code = (error as { errcode?: unknown })?.errcode;
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6) ? "busy" : "unavailable";
}

export function run(conn: DatabaseSync, sql: string): void {
  try { conn.exec(sql); } catch (error) { throw refuse(sqliteKind(error)); }
}

export function rollbackQuietly(conn: DatabaseSync): void {
  try { conn.exec("ROLLBACK"); } catch { /* no transaction, or SQLite rolled it back itself */ }
}

// The directory or file at p, not through a link, or null when it does not exist.
function plain(p: string, want: "dir" | "file"): fs.BigIntStats | null {
  let st: fs.BigIntStats;
  try { st = fs.lstatSync(p, { bigint: true }); } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw refuse("database");
  }
  if (st.isSymbolicLink() || (want === "dir" ? !st.isDirectory() : !st.isFile())) throw refuse("database");
  if (want === "file" && st.nlink !== 1n) throw refuse("database");
  if (process.platform === "win32" && !st.dev && !st.ino) throw refuse("database");
  return st;
}

export function canonicalRoot(dir: string): { root: string; rootId: Id } {
  try {
    const root = fs.realpathSync(dir);
    const st = fs.statSync(root, { bigint: true });
    if (!st.isDirectory()) throw refuse("root");
    return { root, rootId: idOf(st) };
  } catch (error) {
    throw isRefusal(error) ? error : refuse("root");
  }
}

// Opens the database of the hooks directory dir, creating only it and its directory.
export async function openDatabase(dir: string): Promise<Opened> {
  const { root, rootId } = canonicalRoot(dir);
  const home = path.join(root, ".kherep-integrity");
  if (!plain(home, "dir")) {
    try { fs.mkdirSync(home, { mode: 0o700 }); } catch (error) { if (codeOf(error) !== "EEXIST") throw refuse("database"); }
    plain(home, "dir");
  }
  if (fs.realpathSync(home) !== home) throw refuse("database");
  const file = path.join(home, "run.sqlite");
  if (!plain(file, "file")) {
    try { fs.closeSync(fs.openSync(file, "wx", 0o600)); } catch (error) { if (codeOf(error) !== "EEXIST") throw refuse("database"); }
  }
  const before = plain(file, "file")!;
  let DatabaseSyncCtor: typeof DatabaseSync;
  try { ({ DatabaseSync: DatabaseSyncCtor } = await import("node:sqlite")); } catch { throw refuse("unavailable"); }
  let conn: DatabaseSync;
  try { conn = new DatabaseSyncCtor(file); } catch { throw refuse("unavailable"); }
  try {
    const after = plain(file, "file");
    if (!after || !sameId(idOf(after), idOf(before)) || !sameId(canonicalRoot(root).rootId, rootId)) throw refuse("database");
    run(conn, "PRAGMA busy_timeout = 0");
    run(conn, "PRAGMA synchronous = FULL");
    const mode = read(conn, "PRAGMA journal_mode")?.journal_mode;
    if (mode !== "delete") throw refuse("database");
  } catch (error) {
    conn.close();
    throw isRefusal(error) ? error : refuse("database");
  }
  return { conn, root, rootId, file };
}

export function read(conn: DatabaseSync, sql: string, ...params: (string | number | bigint | Uint8Array)[]): Record<string, unknown> | undefined {
  try { return conn.prepare(sql).get(...params) as Record<string, unknown> | undefined; } catch (error) { throw refuse(sqliteKind(error)); }
}

function readAll(conn: DatabaseSync, sql: string): Record<string, unknown>[] {
  try { return conn.prepare(sql).all() as Record<string, unknown>[]; } catch (error) { throw refuse(sqliteKind(error)); }
}

// What SQLite shows: the exact schema, an uninitialized file, or anything else.
export function schemaState(conn: DatabaseSync): "ready" | "empty" | "foreign" {
  const objects = readAll(conn, "SELECT type, name, sql FROM sqlite_schema ORDER BY name");
  const version = read(conn, "PRAGMA user_version")?.user_version;
  const app = read(conn, "PRAGMA application_id")?.application_id;
  if (objects.length === 0 && version === 0 && app === 0) return "empty";
  const [only] = objects;
  const exact = objects.length === 1 && only.type === "table" && only.name === "pending" && only.sql === SCHEMA_SQL;
  return exact && version === SCHEMA_VERSION && app === APPLICATION_ID ? "ready" : "foreign";
}

// Creates the schema on an uninitialized database; a no-op on a ready one.
// Test seam: afterCreate runs after the DDL and before the COMMIT.
export function initialize(conn: DatabaseSync, probe: { afterCreate?: () => void } = {}): void {
  run(conn, "BEGIN EXCLUSIVE");
  try {
    const state = schemaState(conn);
    if (state === "foreign") throw refuse("schema");
    if (state === "empty") {
      run(conn, SCHEMA_SQL);
      run(conn, `PRAGMA user_version = ${SCHEMA_VERSION}`);
      run(conn, `PRAGMA application_id = ${APPLICATION_ID}`);
      probe.afterCreate?.();
    }
    run(conn, "COMMIT");
  } catch (error) {
    rollbackQuietly(conn);
    throw isRefusal(error) ? error : refuse("unavailable");
  }
  if (schemaState(conn) !== "ready") throw refuse("schema");
}

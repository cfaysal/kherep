// The persisted repair intent of the hook runtime (issue #507, part 2).
//
// A repair of a hook file is first recorded, complete, as the one `pending`
// row: the root-relative target, the identity of its parent and of the target
// (or its absence), the hash of what it held, and the complete desired bytes.
// Only after that row is committed is the target written, in place and in the
// same inode (owner, mode and ACLs stay), or, when absent, published complete
// through a hard link. The row is deleted only after the target is measured to
// hold every desired byte. A crash in between leaves the row, and the next
// admitted process replays exactly those bytes before anything loads the file.
// A write refused before it touched the target (the file still holds what it
// held, or is still absent) clears the row, so one unwritable file cannot keep
// every reader out; one that may have touched it stays pending.
// Every function here expects its caller to hold an EXCLUSIVE transaction.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type Id, type Opened, read, refuse } from "./coordinator-db.mts";

export type WriteExact = (file: string, bytes: Uint8Array, hooksDir: string, probe: object, expect: Id | "absent") => string;
export interface Intent {
  intent: string; root: Id; rel: string; parent: Id; target: Id | null; beforeSha: string; bytes: Uint8Array; sha: string;
}
export type Applied = { state: "none" } | { state: "applied"; intent: string; rel: string; sha: string }
  | { state: "refused"; intent: string; rel: string; why: string; cleared: boolean };

const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const DEC = /^(0|[1-9][0-9]{0,39})$/;
const HEX64 = /^[0-9a-f]{64}$/;

// A root-relative path of plain segments: no absolute path, drive, .., empty segment or backslash.
export function safeRel(rel: unknown): rel is string {
  if (typeof rel !== "string" || !rel || rel.length > 512 || rel.includes("\\") || rel.includes("\0")) return false;
  return rel.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":"));
}

const lstatOrNull = (file: string): fs.BigIntStats | null => {
  try { return fs.lstatSync(file, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw refuse("pending-invalid");
  }
};

const shaOf = (file: string): string | null => {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
};

const idText = (id: Id | null): [string | null, string | null] => (id ? [String(id.dev), String(id.ino)] : [null, null]);
const idFrom = (dev: unknown, ino: unknown): Id | null =>
  typeof dev === "string" && typeof ino === "string" && DEC.test(dev) && DEC.test(ino) ? { dev: BigInt(dev), ino: BigInt(ino) } : null;

// The one pending row, validated in full, or null when there is none.
export function pendingIntent(o: Opened): Intent | null {
  const count = Number(read(o.conn, "SELECT count(*) AS n FROM pending")?.n);
  if (count === 0) return null;
  const row = read(o.conn, "SELECT * FROM pending WHERE id = 1");
  if (count !== 1 || !row) throw refuse("pending-invalid");
  const root = idFrom(row.root_dev, row.root_ino);
  const parent = idFrom(row.parent_dev, row.parent_ino);
  const target = row.absent === 1 ? null : idFrom(row.target_dev, row.target_ino);
  const bytes = row.bytes instanceof Uint8Array ? row.bytes : null;
  const valid = typeof row.intent === "string" && /^[0-9a-f]{32}$/.test(row.intent) && root && parent && safeRel(row.rel)
    && (row.absent === 1 ? row.target_dev === null && row.target_ino === null : target)
    && typeof row.before_sha256 === "string" && (HEX64.test(row.before_sha256) || row.before_sha256 === "absent")
    && bytes && bytes.length > 0 && typeof row.sha256 === "string" && HEX64.test(row.sha256) && sha256(bytes) === row.sha256;
  if (!valid) throw refuse("pending-invalid");
  return { intent: row.intent as string, root: root!, rel: row.rel as string, parent: parent!, target,
    beforeSha: row.before_sha256 as string, bytes: bytes!, sha: row.sha256 as string };
}

const targetOf = (o: Opened, rel: string): string => path.join(o.root, ...rel.split("/"));
const inside = (root: string, p: string): boolean => {
  try {
    const rel = path.relative(root, fs.realpathSync(p));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch { return false; }
};
const clear = (o: Opened, intent: string): void => {
  try { o.conn.prepare("DELETE FROM pending WHERE id = 1 AND intent = ?").run(intent); } catch { throw refuse("unavailable"); }
};

// Records the repair of rel to bytes. The caller commits; nothing is written here
// except the directory the target needs, created inside the root.
export function recordIntent(o: Opened, rel: string, bytes: Uint8Array): Intent {
  if (!safeRel(rel) || !bytes.length) throw refuse("pending-invalid");
  if (pendingIntent(o)) throw refuse("recovery");
  const file = targetOf(o, rel);
  const dir = path.dirname(file);
  // The nearest existing ancestor must resolve inside the root before anything is created under it.
  let probe = dir;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!inside(o.root, probe)) throw refuse("pending-invalid");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { throw refuse("pending-invalid"); }
  if (!inside(o.root, dir)) throw refuse("pending-invalid");
  const parent = lstatOrNull(dir);
  const existing = lstatOrNull(file);
  if (!parent?.isDirectory() || (existing && (!existing.isFile() || existing.nlink !== 1n))) throw refuse("pending-invalid");
  const intent: Intent = {
    intent: crypto.randomBytes(16).toString("hex"), root: o.rootId, rel, parent: { dev: parent.dev, ino: parent.ino },
    target: existing ? { dev: existing.dev, ino: existing.ino } : null,
    beforeSha: existing ? shaOf(file) ?? "unreadable" : "absent", bytes, sha: sha256(bytes),
  };
  if (intent.beforeSha === "unreadable") throw refuse("pending-invalid");
  try {
    o.conn.prepare("INSERT INTO pending (id, intent, root_dev, root_ino, rel, parent_dev, parent_ino, target_dev, target_ino, "
      + "absent, before_sha256, bytes, sha256) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(intent.intent, ...idText(intent.root), rel, ...idText(intent.parent), ...idText(intent.target),
        intent.target ? 0 : 1, intent.beforeSha, bytes, intent.sha);
  } catch { throw refuse("unavailable"); }
  return intent;
}

// Replays the pending intent, if any, and deletes it once the target is proven.
export function applyPending(o: Opened, writeExact: WriteExact): Applied {
  const intent = pendingIntent(o);
  if (!intent) return { state: "none" };
  const file = targetOf(o, intent.rel);
  const parent = lstatOrNull(path.dirname(file));
  const rootNow = lstatOrNull(o.root);
  if (!rootNow || rootNow.dev !== intent.root.dev || rootNow.ino !== intent.root.ino
    || !parent || parent.dev !== intent.parent.dev || parent.ino !== intent.parent.ino) {
    return refused(o, intent, file, "the target's directory is not the one that was recorded", false);
  }
  let why = "";
  const now = lstatOrNull(file);
  if (!intent.target && now) {
    // A complete publication the crash interrupted after its link, or something else.
    if (!(now.isFile() && shaOf(file) === intent.sha)) why = "something else appeared at the absent target";
  } else {
    why = writeExact(file, intent.bytes, o.root, {}, intent.target ?? "absent");
  }
  if (!why && shaOf(file) !== intent.sha) why = "the target does not hold the recorded bytes after the write";
  if (!why && intent.target) {
    const after = lstatOrNull(file);
    if (!after || after.dev !== intent.target.dev || after.ino !== intent.target.ino) why = "the target's identity changed";
  }
  if (why) return refused(o, intent, file, why);
  clear(o, intent.intent);
  return { state: "applied", intent: intent.intent, rel: intent.rel, sha: intent.sha };
}

// A refusal that left the target as it was clears the row; any other keeps it pending.
// A moved directory never clears: the file found there may not be the target.
function refused(o: Opened, intent: Intent, file: string, why: string, mayClear = true): Applied {
  const untouched = mayClear && (intent.beforeSha === "absent" ? lstatOrNull(file) === null : shaOf(file) === intent.beforeSha);
  if (untouched) clear(o, intent.intent);
  return { state: "refused", intent: intent.intent, rel: intent.rel, why, cleared: untouched };
}

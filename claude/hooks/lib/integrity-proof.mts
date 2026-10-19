// The final, read-only proof of an integrity run (issue #507, part 2).
//
// After the repair passes, and still under the same EXCLUSIVE hold on the hooks
// directory, the closure is walked once more from the live wired files only:
// no versioned source stands in for a missing file here. Every file is read
// once into a snapshot (bytes, SHA-256, identity), its imports come from that
// snapshot, and its syntax is checked; before and after each check, and once
// more for all of them at the end, the bytes on disk must still be the
// snapshot. A file whose real path leaves the hooks directory is not covered by
// the hold and counts as unchecked. The wiring must read the same at the end.
// Only then may the heartbeat be written. What this proves is the supported
// inventory and syntax checks, not that every module can execute.
//
// The syntax verdict is bound to the snapshot: it parses the string built from
// the snapshot's bytes, in process, and opens no path (P2). A .js file gets the
// grammar Node loads it with: its package scope is the nearest package.json from
// the file's real directory upward, stopping at a directory named node_modules
// and before the file system root. Inside the hooks root every candidate is
// present (snapshotted like a hook file and re-checked at the end), proven absent
// (and still absent at the end), or not proven, which proves nothing. Limits: a
// package.json above the hooks root is outside the hold and read once; a read
// error, or a package.json that is not a regular file, is not proven although
// Node would pass it over; the accepted forms are those Node 26.10 accepts
// (measured): a JSON object whose `type` and `name`, when present, are strings.
// "CommonJS, else ESM" follows Node's syntax detection on every measured case.
// Static imports: node:* only; the libs arrive as a parameter.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HookFile } from "./hook-inventory.mts";
import type { SyntaxVerdict } from "./hook-syntax.mts";

export type ProofLibs = Pick<typeof import("./hook-inventory.mts"), "hookInventory" | "wiredFiles">
  & Pick<typeof import("./hook-syntax.mts"), "syntaxVerdict" | "esmParses" | "cjsParses">;
export type Scope = "module" | "commonjs" | "none" | "invalid";
interface Snap { buf: Buffer; sha: string; dev: bigint; ino: bigint }

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

function inside(root: string, file: string): boolean {
  try {
    const rel = path.relative(root, fs.realpathSync(file));
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function snapshot(file: string, root: string): Snap | null {
  if (!inside(root, file)) return null;
  try {
    const st = fs.statSync(file, { bigint: true });
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(file);
    return { buf, sha: sha256(buf), dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

const unchanged = (file: string, root: string, snap: Snap): boolean => {
  const now = snapshot(file, root);
  return !!now && now.sha === snap.sha && now.dev === snap.dev && now.ino === snap.ino;
};

// true only for a name that is proven not to exist; any other failure proves nothing.
function absentName(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return codeOf(error) === "ENOENT";
  }
}

// The scope a package.json text gives, in the forms Node 26.10 accepts (measured).
function configScope(text: string): Scope {
  let config: unknown;
  try { config = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return "invalid"; }
  if (!config || typeof config !== "object" || Array.isArray(config)) return "invalid";
  const { type, name } = config as Record<string, unknown>;
  if ((type !== undefined && typeof type !== "string") || (name !== undefined && typeof name !== "string")) return "invalid";
  return type === "module" || type === "commonjs" ? type : "none";
}

// The package scope of the .js file `file`, as the header describes it; `absent`
// collects the candidates inside the root that were proven absent.
function scopeOf(file: string, root: string, take: (file: string) => Snap | null, absent: Set<string>): Scope {
  let dir: string;
  try { dir = path.dirname(fs.realpathSync(file)); } catch { return "invalid"; }
  for (; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir) === "node_modules") return "none";
    const candidate = path.join(dir, "package.json");
    const rel = path.relative(root, dir);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      if (absentName(candidate)) { absent.add(candidate); continue; }
      const snap = take(candidate);
      if (!snap) return "invalid";
      return configScope(snap.buf.toString("utf8"));
    }
    let text: string;
    try { text = fs.readFileSync(candidate, "utf8"); } catch (error) {
      if (codeOf(error) === "ENOENT") continue;
      return "invalid";
    }
    return configScope(text);
  }
  return "none";
}

// The verdict over exactly `source`: `file` picks the grammar by its extension and
// names the source in errors, nothing reads it. `scope` matters for .js only.
export async function boundVerdict(lib: Pick<ProofLibs, "syntaxVerdict" | "esmParses" | "cjsParses">, file: string, source: string,
  scope: Scope): Promise<SyntaxVerdict> {
  const ext = path.extname(file).toLowerCase();
  if (!source.length || (ext !== ".js" && ext !== ".cjs")) return lib.syntaxVerdict(file, source); // .mts/.mjs parse the string
  if (ext === ".cjs") return lib.cjsParses(source, file);
  if (scope === "invalid") return { state: "UNGEPRUEFT", detail: "the package scope could not be read" };
  if (scope === "module") return lib.esmParses(source);
  const cjs = lib.cjsParses(source, file);
  if (scope === "commonjs" || cjs.state === "OK") return cjs;
  // Node's detection: a module only where CommonJS failed.
  return (await lib.esmParses(source)).state === "OK" ? { state: "OK" } : cjs;
}

const sameFiles = (a: HookFile[], b: HookFile[]): boolean =>
  a.length === b.length && a.every((file, index) => file.file === b[index]?.file);

// "" with the file count when the live closure passed, otherwise why it did not.
export async function finalProof(lib: ProofLibs, home: string, root: string, files: HookFile[]): Promise<{ why: string; count: number }> {
  const snaps = new Map<string, Snap | null>();
  const absent = new Set<string>();
  const take = (file: string): Snap | null => {
    if (!snaps.has(file)) snaps.set(file, snapshot(file, root));
    return snaps.get(file)!;
  };
  const inventory = lib.hookInventory(files, `${home}/hooks`, (file) => {
    const snap = take(file);
    return snap && snap.buf.length ? snap.buf.toString("utf8") : null;
  });
  const count = inventory.length;
  for (const { file, rel } of inventory) {
    const snap = take(file);
    if (!snap || !snap.buf.length) return { why: `${rel} could not be proven in the final check`, count };
    const scope = path.extname(file).toLowerCase() === ".js" ? scopeOf(file, root, take, absent) : "none";
    const verdict = await boundVerdict(lib, file, snap.buf.toString("utf8"), scope);
    if (verdict.state !== "OK") return { why: `${rel} is not OK in the final check`, count };
    if (!unchanged(file, root, snap)) return { why: `${rel} changed during the final check`, count };
  }
  for (const [file, snap] of snaps) {
    if (snap && !unchanged(file, root, snap)) return { why: "a file changed during the final check", count };
  }
  for (const file of absent) {
    if (!absentName(file)) return { why: "a file changed during the final check", count };
  }
  const again = lib.wiredFiles(home);
  if (again.notes.length || again.uncoordinated.length || !sameFiles(again.files, files)) {
    return { why: "the wiring changed during the final check", count };
  }
  return { why: "", count };
}

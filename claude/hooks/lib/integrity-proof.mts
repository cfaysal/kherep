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
// Static imports: node:* only; the libs arrive as a parameter.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HookFile } from "./hook-inventory.mts";

export type ProofLibs = Pick<typeof import("./hook-inventory.mts"), "hookInventory" | "wiredFiles">
  & Pick<typeof import("./hook-syntax.mts"), "syntaxVerdict">;
interface Snap { buf: Buffer; sha: string; dev: bigint; ino: bigint }

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

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

const sameFiles = (a: HookFile[], b: HookFile[]): boolean =>
  a.length === b.length && a.every((file, index) => file.file === b[index]?.file);

// "" with the file count when the live closure passed, otherwise why it did not.
export async function finalProof(lib: ProofLibs, home: string, root: string, files: HookFile[]): Promise<{ why: string; count: number }> {
  const snaps = new Map<string, Snap | null>();
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
    const verdict = await lib.syntaxVerdict(file, snap.buf.toString("utf8"));
    if (verdict.state !== "OK") return { why: `${rel} is not OK in the final check`, count };
    if (!unchanged(file, root, snap)) return { why: `${rel} changed during the final check`, count };
  }
  for (const [file, snap] of snaps) {
    if (snap && !unchanged(file, root, snap)) return { why: "a file changed during the final check", count };
  }
  const again = lib.wiredFiles(home);
  if (again.notes.length || again.uncoordinated.length || !sameFiles(again.files, files)) {
    return { why: "the wiring changed during the final check", count };
  }
  return { why: "", count };
}

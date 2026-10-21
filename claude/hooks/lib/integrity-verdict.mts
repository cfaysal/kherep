// The verdict on one inventoried hook file, its restore and the incident journal
// of live-hook-integrity.mts (issue #507, part 2: moved out of that hook).
//
// Static imports come from node:* only. The libs these functions call arrive as
// a parameter, so this file loads even when one of them is broken, and the hook
// can still restore lib/hook-syntax.mts with it. A broken copy of THIS file is
// reported by the hook but not restored until the next install. Since #507
// part 2 the write itself belongs to the hook runtime: the restore hands the
// complete bytes to its capability, which records them durably first.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type VerdictLibs = typeof import("./hook-syntax.mts") & typeof import("./workspace-scope.mts");
// What kherep/hook-runtime/coordinator.mts gives the admitted integrity writer.
export interface Repairer { repair: (rel: string, bytes: Uint8Array) => Promise<Restored> }
export type Before = { size?: number; mtime?: string; ino?: number };
export type Verdict = { state: "OK" | "DEFEKT" | "UNGEPRUEFT"; reason?: string; before?: Before };
export type Restored = { proven: boolean; sha?: string; why?: string };

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const errorCode = (error: unknown): string | undefined => (error ? (error as NodeJS.ErrnoException).code : undefined);

// `kind` only words the absent case: "wired but" or "imported but" not present.
export async function classify(lib: Pick<VerdictLibs, "syntaxVerdict">, file: string, kind: string): Promise<Verdict> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    const code = errorCode(error) || "unknown";
    if (code === "ENOENT") return { state: "DEFEKT", reason: `${kind} but not present on disk` };
    return { state: "UNGEPRUEFT", reason: `stat failed (${code})` };
  }
  // Before the size test on purpose: a directory reports size 0 on Windows and
  // would otherwise be mistaken for the 0-byte incident.
  if (!stat.isFile()) return { state: "UNGEPRUEFT", reason: "not a regular file" };
  const before = { size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), ino: stat.ino };
  if (stat.size === 0) {
    return { state: "DEFEKT", reason: "0 bytes - it runs, enforces nothing and exits 0 (fail-open)", before };
  }
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { state: "UNGEPRUEFT", reason: `unreadable (${errorCode(error) || "unknown"})`, before };
  }
  const verdict = await lib.syntaxVerdict(file, source);
  if (verdict.state === "OK") return { state: "OK", before };
  return { state: verdict.state, reason: verdict.state === "DEFEKT" ? verdict.detail : `syntax unchecked (${verdict.detail})`, before };
}

export async function restore(
  lib: Pick<VerdictLibs, "joinPathLike">, repairer: Repairer | null, file: string, rel: string, repoRoot: string,
): Promise<Restored> {
  if (!repairer) return { proven: false, why: "this run is not coordinated by the hook runtime" };
  if (!repoRoot) return { proven: false, why: "no checkout resolved via workspace, KHEREP_WORKSPACE or install note" };
  const source = lib.joinPathLike(repoRoot, `claude/hooks/${rel}`);
  let wanted: Buffer;
  try {
    wanted = fs.readFileSync(source);
  } catch (error) {
    return { proven: false, why: `versioned source claude/hooks/${rel} unreadable (${errorCode(error) || "unknown"})` };
  }
  if (!wanted.length) return { proven: false, why: `versioned source claude/hooks/${rel} is itself 0 bytes` };
  const result = await repairer.repair(rel, wanted);
  if (!result.proven) return result;
  // Measured at the target here as well. The runtime reporting success is not this run's measurement.
  let landed: Buffer;
  try {
    landed = fs.readFileSync(file);
  } catch (error) {
    return { proven: false, why: `target unreadable after the write (${errorCode(error) || "unknown"})` };
  }
  const sha = sha256(landed);
  if (!landed.length || sha !== sha256(wanted)) {
    return { proven: false, sha, why: "the target does not match the versioned source after the write" };
  }
  return { proven: true, sha };
}

export function journal(home: string, entry: Record<string, unknown>): void {
  try {
    const dir = path.join(home, ".cache", "hook-integrity");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "incidents.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* a journal we cannot write must never break a session start */
  }
}

/**
 * hook-integrity-repair.mts  -  the repair of one inventoried file for the Codex
 * hook-integrity hook (hook-integrity.mts): which checkout it restores from, the
 * restore, counted only when MEASURED at the target (size > 0, SHA-256 equal to the
 * checkout bytes), and the incident journal. Issue #533: the libs and
 * the run state arrive as parameters, so this file imports only node:* modules; the
 * hook loads it as an own step after the four libs a restore needs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { InventoryEntry, SourceText } from "../../claude/hooks/lib/hook-inventory.mts";
import type { RunLock } from "../../claude/hooks/lib/integrity-heartbeat.mts";
import type { Outcome } from "../../claude/hooks/lib/integrity-passes.mts";
import type { ScopePayload } from "../../claude/hooks/lib/workspace-scope.mts";
import type { Libs } from "./hook-integrity.mts";
import type { COMPUTED, computedImports, sourceOf } from "./hook-integrity-sources.mts";

export type Restored = { proven: boolean; sha?: string; why?: string };
// The run state of one check under run.lock.
export interface Ctx {
  home: string; hooksDir: string; repoRoot: string; lock: RunLock; trigger: string; lines: string[]; lost: string;
  sourceOf: typeof sourceOf; COMPUTED: typeof COMPUTED; computedImports: typeof computedImports;
  outcome: (result: Restored) => string; realOrNull: (p: string) => string | null;
}

const DELIVER_HOOK = "/modules/control-plane/node/deliver-hook.mts";

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code || "unknown";
// The bytes, or the error code that stopped the read.
function read(file: string | number): Buffer | string {
  try { return fs.readFileSync(file); } catch (error) { return errorCode(error); }
}

// Issue #503. The source root the installer recorded for the Control Plane
// hooks under <home>/orchestra, or "" when the pointer is absent or invalid.
// The same schema check as readPointer() in control-plane-hook.mts, which this
// file cannot import by a fixed name; hook-integrity.test.mts runs both on the
// same pointers.
function pointerRoot(lib: Libs, home: string): string {
  let value: { version?: unknown; root?: unknown; kind?: unknown; verified?: unknown; commit?: unknown } | null;
  try { value = JSON.parse(fs.readFileSync(path.join(home, "orchestra", "control-plane-source.json"), "utf8")) as typeof value; }
  catch { return ""; }
  if (!value || value.version !== 1 || typeof value.root !== "string" || !path.isAbsolute(value.root)
    || (value.kind !== "pin" && value.kind !== "checkout") || typeof value.verified !== "boolean"
    || (value.commit !== undefined && (typeof value.commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.commit)))) return "";
  return lib.normalizePathLike(value.root);
}

// The source the Control Plane pointer of home names, else the checkout an
// older deliver-hook command runs from, else the Claude-side chain.
export function checkoutOf(lib: Libs, parts: string[], payload: ScopePayload | null, env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const pointed = home ? pointerRoot(lib, home) : "";
  if (pointed && lib.isCheckout(pointed)) return pointed;
  const deliver = parts.map(lib.normalizePathLike).find((part) => part.toLowerCase().endsWith(DELIVER_HOOK));
  const root = deliver ? deliver.slice(0, -DELIVER_HOOK.length) : "";
  if (lib.isCheckout(root)) return root;
  return lib.checkoutFor(payload, lib.normalizePathLike(env.CLAUDE_HOME || path.join(os.homedir(), ".claude")), env);
}

export function restore(lib: Libs, file: string, from: string, repoRoot: string, hooksDir: string): Restored {
  if (!repoRoot) return { proven: false, why: "no checkout resolved via the control-plane pointer, the deliver-hook command, workspace, KHEREP_WORKSPACE or install note" };
  const source = lib.joinPathLike(repoRoot, from);
  const wanted = read(source);
  if (typeof wanted === "string") return { proven: false, why: `versioned source ${source} unreadable (${wanted})` };
  if (!wanted.length) return { proven: false, why: `versioned source ${source} is itself 0 bytes` };
  const refusal = lib.writeExact(file, wanted, hooksDir);
  if (refusal) return { proven: false, why: refusal };
  // Measured at the target. The write call reporting success is not a measurement.
  const landed = read(file);
  if (typeof landed === "string") return { proven: false, why: `target unreadable after the write (${landed})` };
  const sha = sha256(landed);
  if (!landed.length || sha !== sha256(wanted)) return { proven: false, sha, why: "the target does not match the versioned source after the write" };
  return { proven: true, sha };
}

export function journal(home: string, entry: Record<string, unknown>): void {
  const dir = path.join(home, ".cache", "hook-integrity");
  // A journal we cannot write must never break a session start.
  try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, "incidents.jsonl"), `${JSON.stringify(entry)}\n`, "utf8"); } catch { /* ignored */ }
}

export function sourceReaders(lib: Libs, { repoRoot, sourceOf, COMPUTED, computedImports, realOrNull }: Ctx) {
  // The live file, named by its real path: Node loads its imports from there (issue #524).
  const liveOnly = (file: string, rel: string): SourceText | null => {
    const live = read(file);
    if (typeof live === "string" || !live.length) return null;
    const text = live.toString("utf8");
    return { text: COMPUTED[rel] ? text + computedImports(rel) : text, real: realOrNull(file) ?? undefined };
  };
  // The live file, else the versioned one, so one broken file does not hide the files behind it.
  const readSource = (file: string, rel: string): string | SourceText | null => {
    const live = liveOnly(file, rel);
    if (live) return live;
    const source = sourceOf(rel);
    const versioned = repoRoot && "from" in source ? read(lib.joinPathLike(repoRoot, source.from)) : "";
    const text = typeof versioned === "string" ? "" : versioned.toString("utf8");
    return COMPUTED[rel] ? text + computedImports(rel) : text || null;
  };
  return { liveOnly, readSource };
}

// The check of one inventoried file, restoring it from the checkout under run.lock.
export function entryChecker(lib: Libs, { home, hooksDir, repoRoot, lock, trigger: TRIGGER, lines, lost: LOST, sourceOf, outcome }: Ctx) {
  const state = { invalidated: false, blocked: "" };
  // A journal line is a mutation too: only while this run holds the lock.
  const record = (entry: Record<string, unknown>): void => { if (lock.holding()) journal(home, entry); };
  return async ({ file, rel, wired: isWired, importedBy }: InventoryEntry): Promise<Outcome> => {
    const { state: verdict, reason, before = {} } = await lib.classify(lib, file, isWired ? "wired" : "imported");
    if (verdict === "OK") return { unproven: "", restored: false };
    const label = importedBy.length ? `${rel} (imported by ${importedBy.join(", ")})` : rel;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(), trigger: TRIGGER, file: rel, path: file, state: verdict, reason, kind: isWired ? "wired" : "import", importedBy,
      sizeBefore: before.size ?? null, mtimeBefore: before.mtime || null, inoBefore: before.ino ?? null,
      sha256After: null, restoreProven: false,
    };
    const source = sourceOf(rel);
    if (verdict === "UNGEPRUEFT") {
      lines.push(`${label}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
      record(entry);
      return { unproven: `${rel} is unchecked`, restored: false };
    }
    if ("hint" in source) {
      entry.restoreDetail = source.hint;
      lines.push(`${label}: ${reason} -> NOT restored, report only (${source.hint}). ENFORCEMENT IS OFF for this hook.`);
      record(entry);
      return { unproven: `${rel} is not restored`, restored: false };
    }
    let result: Restored = { proven: false, why: LOST };
    if (lock.holding()) {
      // Once per run, before the first repair; a heartbeat that stays blocks every repair.
      if (!state.invalidated) { state.invalidated = true; state.blocked = lib.invalidateHeartbeat(home); }
      result = state.blocked ? { proven: false, why: state.blocked } : restore(lib, file, source.from, repoRoot, hooksDir);
    }
    Object.assign(entry, { sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why });
    lines.push(`${label}: ${reason} -> ${outcome(result)}`);
    record(entry);
    if (!result.proven) return { unproven: `${rel} is not restored`, restored: false };
    const after = (await lib.classify(lib, file, "restored")).state;
    if (after !== "OK") lines.push(`${label}: still ${after} after the restore`);
    return { unproven: after === "OK" ? "" : `${rel} is not OK after the restore`, restored: true };
  };
}

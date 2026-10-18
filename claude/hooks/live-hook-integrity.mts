#!/usr/bin/env node
/**
 * live-hook-integrity.mts  -  SessionStart hook, and the re-check of guard-dispatch
 *
 * Proves that every hook file wired in the LIVE settings, plus the transitive
 * closure of their relative imports under hooks/ (lib/hook-inventory.mts), can
 * load, and restores it from the versioned source when it cannot. A missing or
 * 0-byte lib kills its importer at import with exit 1, which Claude Code treats
 * as non-blocking (issue #273); a 0-byte guard runs, enforces nothing, exits 0.
 *
 * States, never merged (goldene Regel 12): OK, DEFEKT (absent, 0 bytes, rejected
 * by Node's parser, lib/hook-syntax.mts, issue #278), UNGEPRUEFT (the read or the
 * check failed). A restore counts only when MEASURED at the target: SHA-256 equal
 * to the source (goldene Regel 13). The source comes from lib/orchestra-checkout,
 * not the session cwd; the write (lib/restore-write.mts) lands in the checked
 * regular file or nowhere. A restore changes what the file imports, so the walk
 * is repeated, at most three passes, until it finds nothing new.
 * Own libs load dynamically (loadLibs, issue #279), so a broken one is reported.
 *
 * Heartbeat (issue #507, part 2, lib/integrity-heartbeat.mts): only a run in
 * which every file of the final closure ended OK or restored with proof, with
 * the live settings read completely, writes <home>/.cache/hook-integrity/
 * heartbeat.json. run.lock keeps a second run out; it prints only the holder.
 * `--trigger <source>` (guard-dispatch.mts) prints plain lines, one per finding
 * plus one on the heartbeat, instead of the SessionStart JSON. Any unexpected
 * error is reported, exit 0; silent at session start when everything is OK.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HookFile, InventoryEntry } from "./lib/hook-inventory.mts";
import type { Lock } from "./lib/integrity-heartbeat.mts";
import type { Restored } from "./lib/integrity-verdict.mts";
import type { ScopePayload } from "./lib/workspace-scope.mts";

type Libs = typeof import("./lib/integrity-verdict.mts") & typeof import("./lib/workspace-scope.mts") &
  typeof import("./lib/orchestra-checkout.mts") & typeof import("./lib/restore-write.mts") &
  typeof import("./lib/hook-inventory.mts") & typeof import("./lib/hook-syntax.mts") &
  typeof import("./lib/integrity-heartbeat.mts");
// The first lib that did not load or lacks a used function; `loaded` libs did.
type LoadFailure = { rel: string; why: string; loaded: number };

// Filled by loadLibs. restore() needs only the first RESTORE_LIBS of its steps.
const lib = {} as Libs;
const RESTORE_LIBS = 4;
const TRIGGER_AT = process.argv.indexOf("--trigger");
const PLAIN = TRIGGER_AT >= 0;
const TRIGGER = PLAIN ? process.argv[TRIGGER_AT + 1] || "unnamed" : "session-start";

// Dependency order, so a broken lib is named before the libs importing it.
// String literals on purpose: lib/hook-inventory.mts and the install manifest
// test see exactly this form. null when all are in.
async function loadLibs(): Promise<LoadFailure | null> {
  const steps: [string, () => Promise<object>, string[]][] = [
    ["lib/integrity-verdict.mts", () => import("./lib/integrity-verdict.mts"), ["classify", "restore", "journal"]],
    ["lib/workspace-scope.mts", () => import("./lib/workspace-scope.mts"), ["joinPathLike", "normalizePathLike"]],
    ["lib/orchestra-checkout.mts", () => import("./lib/orchestra-checkout.mts"), ["checkoutFor"]],
    ["lib/restore-write.mts", () => import("./lib/restore-write.mts"), ["writeExact"]],
    ["lib/hook-inventory.mts", () => import("./lib/hook-inventory.mts"), ["hookInventory", "wiredFiles"]],
    ["lib/hook-syntax.mts", () => import("./lib/hook-syntax.mts"), ["quietStripWarning", "syntaxVerdict"]],
    ["lib/integrity-heartbeat.mts", () => import("./lib/integrity-heartbeat.mts"), ["acquireLock", "writeHeartbeat"]],
  ];
  for (const [index, [rel, load, used]] of steps.entries()) {
    let mod: Record<string, unknown>;
    try {
      mod = (await load()) as Record<string, unknown>;
    } catch (error) {
      return { rel, why: String((error as Error)?.message || error).split(/\r?\n/)[0], loaded: index };
    }
    const missing = used.filter((fn) => typeof mod[fn] !== "function");
    if (missing.length) return { rel, why: `no function ${missing.join(", ")}`, loaded: index };
    Object.assign(lib, mod);
  }
  return null;
}

function emit(lines: string[]): void {
  if (!lines.length) return;
  if (PLAIN) return void process.stdout.write(lines.map((line) => `${line}\n`).join(""));
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `ORCHESTRA LIVE-HOOK-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
      },
    })
  );
}

// This hook without one of its libs: one line, journalled as kind "self". The
// lib is restored next to this file only when the libs restore() needs loaded.
function ownImportFailed({ rel, why, loaded }: LoadFailure, payload: ScopePayload | null, home: string): void {
  const hooksDir = import.meta.dirname.replace(/\\/g, "/");
  const file = `${hooksDir}/${rel}`;
  const result: Restored = loaded >= RESTORE_LIBS
    ? lib.restore(lib, file, rel, lib.checkoutFor(payload, lib.normalizePathLike(home)), hooksDir)
    : { proven: false, why: "the restore itself needs integrity-verdict, workspace-scope, orchestra-checkout and restore-write" };
  // Without integrity-verdict there is no journal function to call.
  if (loaded > 0) lib.journal(home, {
    ts: new Date().toISOString(), trigger: TRIGGER, file: rel, path: file, state: "DEFEKT", reason: why, kind: "self",
    importedBy: ["live-hook-integrity.mts"],
    sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why,
  });
  const outcome = result.proven
    ? `RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)}); the next session checks again`
    : `NOT restored (${result.why})`;
  emit([`own import ${rel} cannot be loaded (${why}); nothing was verified this session -> ${outcome}`,
    ...(PLAIN ? [`heartbeat not written (own import ${rel} cannot be loaded)`] : [])]);
}

async function main(): Promise<void> {
  let payload: ScopePayload | null = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}") as ScopePayload | null;
  } catch {
    payload = {};
  }
  const rawHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const failed = await loadLibs();
  if (failed) return ownImportFailed(failed, payload, rawHome);
  lib.quietStripWarning();
  const home = lib.normalizePathLike(rawHome);
  const { files, notes, readAny } = lib.wiredFiles(home);
  const lines = notes.slice();
  if (!readAny && !files.length) {
    lines.push(`no live settings could be read under ${home}, so WHICH hooks are wired is UNKNOWN here`);
  }
  if (!files.length) {
    if (PLAIN) lines.push(`heartbeat not written (no hook file is wired under ${home})`);
    return emit(lines);
  }
  let lock: Lock | undefined;
  try {
    lock = lib.acquireLock(home);
  } catch (error) {
    lines.push(`run lock unavailable (${(error as Error)?.message || error}); checked without it`);
  }
  if (lock && "holder" in lock) {
    return emit([`re-check already running (pid ${lock.holder.pid ?? "unknown"}, since ${lock.holder.ts ?? "unknown"})`]);
  }
  try {
    const unproven = notes.length ? "the live settings were not read completely" : lock ? "" : "no run lock";
    await checkAll(files, lines, unproven, payload, home);
  } finally {
    lock?.release();
  }
}

// Every inventoried file, then the heartbeat when nothing stood in the way.
async function checkAll(
  files: HookFile[], lines: string[], unprovenAtStart: string, payload: ScopePayload | null, home: string,
): Promise<void> {
  let unproven = unprovenAtStart;
  let restored = 0;
  const repoRoot = lib.checkoutFor(payload, home);
  const hooksDir = `${home}/hooks`;
  // The walk reads the live file, and the versioned one when the live file is
  // gone or empty, so one broken link does not hide the files behind it.
  const readSource = (file: string, rel: string): string | null => {
    for (const candidate of [file, repoRoot && lib.joinPathLike(repoRoot, `claude/hooks/${rel}`)]) {
      try {
        const text = candidate ? fs.readFileSync(candidate, "utf8") : "";
        if (text) return text;
      } catch {
        /* next candidate */
      }
    }
    return null;
  };

  const seen = new Set<string>();
  let inventory: ReturnType<Libs["hookInventory"]> = [];
  // Pass 2 and 3 walk what restores of the pass before brought in; a fourth walk only checks.
  for (let pass = 0; ; pass++) {
    inventory = lib.hookInventory(files, hooksDir, readSource);
    const fresh = inventory.filter((entry) => !seen.has(entry.rel));
    if (!fresh.length) break;
    if (pass === 3) { unproven ||= "the import closure did not settle"; break; }
    for (const entry of fresh) {
      seen.add(entry.rel);
      const outcome = await checkOne(entry, lines, repoRoot, home);
      unproven ||= outcome.unproven;
      if (outcome.restored) restored++;
    }
  }
  unproven ||= lib.writeHeartbeat(home, { trigger: TRIGGER, runtime: "claude", files: inventory.length });
  if (PLAIN) {
    lines.push(unproven ? `heartbeat not written (${unproven})`
      : `all ${inventory.length} files OK (${restored} restored), heartbeat refreshed`);
  }
  emit(lines);
}

// One file: its verdict, a restore when DEFEKT, the journal; `unproven` is "" when it ended OK.
type Outcome = { unproven: string; restored: boolean };
async function checkOne(entry: InventoryEntry, lines: string[], repoRoot: string, home: string): Promise<Outcome> {
  const { file, rel, wired, importedBy } = entry;
  const hooksDir = `${home}/hooks`;
  const { state, reason, before = {} } = await lib.classify(lib, file, wired ? "wired" : "imported");
  if (state === "OK") return { unproven: "", restored: false };
  const label = importedBy.length ? `${rel} (imported by ${importedBy.join(", ")})` : rel;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(), trigger: TRIGGER, file: rel, path: file, state, reason,
    kind: wired ? "wired" : "import", importedBy,
    sizeBefore: before.size === undefined ? null : before.size,
    mtimeBefore: before.mtime || null,
    inoBefore: before.ino === undefined ? null : before.ino,
    sha256After: null, restoreProven: false,
  };
  if (state === "UNGEPRUEFT") {
    lines.push(`${label}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
    lib.journal(home, record);
    return { unproven: `${rel} is unchecked`, restored: false };
  }
  const result = lib.restore(lib, file, rel, repoRoot, hooksDir);
  record.sha256After = result.sha || null;
  record.restoreProven = result.proven;
  if (!result.proven) record.restoreDetail = result.why;
  lib.journal(home, record);
  lines.push(
    result.proven
      ? `${label}: ${reason} -> RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)})`
      : `${label}: ${reason} -> NOT restored (${result.why}). ENFORCEMENT IS OFF for this hook.`
  );
  if (!result.proven) return { unproven: `${rel} is not restored`, restored: false };
  // Proven bytes, re-checked as the loader will see them.
  const after = (await lib.classify(lib, file, "restored")).state;
  return { unproven: after === "OK" ? "" : `${rel} is not OK after the restore`, restored: true };
}

main()
  .catch((error: unknown) => {
    try {
      emit([`the integrity check itself failed (${(error && (error as Error).message) || "unknown"}); nothing was verified`]);
    } catch {
      /* never break session start */
    }
  })
  .finally(() => process.exit(0));

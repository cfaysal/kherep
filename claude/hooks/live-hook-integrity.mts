#!/usr/bin/env node
/**
 * live-hook-integrity.mts  -  SessionStart hook
 *
 * Proves that every hook file wired in the LIVE settings can enforce anything at
 * all, and repairs it from the versioned source when it cannot. "Every file" is
 * what Node loads to run them: the wired files plus the transitive closure of
 * their relative imports under hooks/ (lib/hook-inventory.mts). A missing
 * or 0-byte lib passes the syntax check of its importer and still kills the hook
 * at import with exit 1, which Claude Code treats as non-blocking (issue #273).
 *
 * GRUND: since 2026-08-05 ~/.claude/hooks/commit-guard.js has repeatedly fallen
 * back to 0 bytes (three repair-and-relapse cycles on record). A 0-byte .js file
 * runs, does nothing and exits 0: fail-open, indistinguishable from "checked,
 * nothing to report", and the writer is UNKNOWN, so this holds against anyone.
 *
 * Three states, never merged (goldene Regel 12): OK (present, non-empty, parses),
 * DEFEKT (absent, 0 bytes, rejected by Node's parser), UNGEPRUEFT (the read path
 * or the syntax check itself failed). A restore counts only when MEASURED at the
 * target: size > 0 and the SHA-256 there equals the source, because reporting
 * one's own write is not a measurement (goldene Regel 13). The source comes from
 * lib/orchestra-checkout.mts, NOT the session cwd: these hooks are global, so a
 * wiped guard must be repairable from a session started anywhere.
 * The write (lib/restore-write.mts, issue #279) lands in the regular
 * file that was checked or nowhere, never through a link at the file or at a
 * subdirectory leading elsewhere. A linked <CLAUDE_HOME>/hooks is intended:
 * Claude Code loads the hooks through that link, so its target IS the live file.
 *
 * Own imports (issue #279): statically imported, a missing or broken lib killed
 * this hook with exit 1 before it could say so, and critical-file-integrity
 * shares two of them. So loadLibs() imports them dynamically and checks the
 * functions used, because a 0-byte .mts imports as an empty namespace.
 *
 * Syntax: lib/hook-syntax.mts, in-process and without running the file.
 * GRUND (issue #278): `node --check` never type-strips a .mts; it exited 0 for
 * `export const x = ;` and rejected valid typed code without import/export. A
 * .mts now goes through module.stripTypeScriptTypes and a V8 module parse, ~1 ms
 * per file; .js keeps vm.Script, confirmed by a child `node --check`.
 *
 * Fail-safe: any unexpected error is caught, reported, exit 0. Silent when
 * everything is OK. No network, no child process beyond that `node --check`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ScopePayload } from "./lib/workspace-scope.mts";

type Libs = typeof import("./lib/workspace-scope.mts") & typeof import("./lib/orchestra-checkout.mts") &
  typeof import("./lib/restore-write.mts") & typeof import("./lib/hook-inventory.mts") & typeof import("./lib/hook-syntax.mts");
type Before = { size?: number; mtime?: string; ino?: number };
type Verdict = { state: "OK" | "DEFEKT" | "UNGEPRUEFT"; reason?: string; before?: Before };
type Restored = { proven: boolean; sha?: string; why?: string };
// The first lib that did not load or lacks a used function; `loaded` libs did.
type LoadFailure = { rel: string; why: string; loaded: number };

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const errorCode = (error: unknown): string | undefined => (error ? (error as NodeJS.ErrnoException).code : undefined);
// Filled by loadLibs. restore() needs only the first RESTORE_LIBS of its steps.
const lib = {} as Libs;
const RESTORE_LIBS = 3;

// Dependency order, so a broken lib is named before the libs importing it.
// String literals on purpose: lib/hook-inventory.mts and the install manifest
// test see exactly this form. null when all five are in.
async function loadLibs(): Promise<LoadFailure | null> {
  const steps: [string, () => Promise<object>, string[]][] = [
    ["lib/workspace-scope.mts", () => import("./lib/workspace-scope.mts"), ["joinPathLike", "normalizePathLike"]],
    ["lib/orchestra-checkout.mts", () => import("./lib/orchestra-checkout.mts"), ["checkoutFor"]],
    ["lib/restore-write.mts", () => import("./lib/restore-write.mts"), ["writeExact"]],
    ["lib/hook-inventory.mts", () => import("./lib/hook-inventory.mts"), ["hookInventory", "wiredFiles"]],
    ["lib/hook-syntax.mts", () => import("./lib/hook-syntax.mts"), ["quietStripWarning", "syntaxVerdict"]],
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

// `kind` only words the absent case: "wired but" or "imported but" not present.
async function classify(file: string, kind: string): Promise<Verdict> {
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

function restore(file: string, rel: string, repoRoot: string, hooksDir: string): Restored {
  if (!repoRoot) return { proven: false, why: "no checkout resolved via workspace, KHEREP_WORKSPACE or install note" };
  const source = lib.joinPathLike(repoRoot, `claude/hooks/${rel}`);
  let wanted: Buffer;
  try {
    wanted = fs.readFileSync(source);
  } catch (error) {
    return { proven: false, why: `versioned source ${source} unreadable (${errorCode(error) || "unknown"})` };
  }
  if (!wanted.length) return { proven: false, why: `versioned source ${source} is itself 0 bytes` };
  const refusal = lib.writeExact(file, wanted, hooksDir);
  if (refusal) return { proven: false, why: refusal };
  // Measured at the target. The write call reporting success is not a measurement.
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

function journal(home: string, entry: Record<string, unknown>): void {
  try {
    const dir = path.join(home, ".cache", "hook-integrity");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "incidents.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* a journal we cannot write must never break a session start */
  }
}

function emit(lines: string[]): void {
  if (!lines.length) return;
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
    ? restore(file, rel, lib.checkoutFor(payload, lib.normalizePathLike(home)), hooksDir)
    : { proven: false, why: "the restore itself needs workspace-scope, orchestra-checkout and restore-write" };
  journal(home, {
    ts: new Date().toISOString(), file: rel, path: file, state: "DEFEKT", reason: why, kind: "self", importedBy: ["live-hook-integrity.mts"],
    sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why,
  });
  const outcome = result.proven
    ? `RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)}); the next session checks again`
    : `NOT restored (${result.why})`;
  emit([`own import ${rel} cannot be loaded (${why}); nothing was verified this session -> ${outcome}`]);
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
  const repoRoot = lib.checkoutFor(payload, home);
  const hooksDir = `${home}/hooks`;
  const { files, notes, readAny } = lib.wiredFiles(home);
  const lines = notes.slice();
  if (!readAny && !files.length) {
    lines.push(`no live settings could be read under ${home}, so WHICH hooks are wired is UNKNOWN here`);
  }
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

  for (const { file, rel, wired, importedBy } of lib.hookInventory(files, hooksDir, readSource)) {
    const { state, reason, before = {} } = await classify(file, wired ? "wired" : "imported");
    if (state === "OK") continue;
    const label = importedBy.length ? `${rel} (imported by ${importedBy.join(", ")})` : rel;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(), file: rel, path: file, state, reason,
      kind: wired ? "wired" : "import", importedBy,
      sizeBefore: before.size === undefined ? null : before.size,
      mtimeBefore: before.mtime || null,
      inoBefore: before.ino === undefined ? null : before.ino,
      sha256After: null, restoreProven: false,
    };
    if (state === "UNGEPRUEFT") {
      lines.push(`${label}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
      journal(home, entry);
      continue;
    }
    const result = restore(file, rel, repoRoot, hooksDir);
    entry.sha256After = result.sha || null;
    entry.restoreProven = result.proven;
    if (!result.proven) entry.restoreDetail = result.why;
    journal(home, entry);
    lines.push(
      result.proven
        ? `${label}: ${reason} -> RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)})`
        : `${label}: ${reason} -> NOT restored (${result.why}). ENFORCEMENT IS OFF for this hook.`
    );
  }

  emit(lines);
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

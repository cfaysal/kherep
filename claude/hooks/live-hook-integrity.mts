#!/usr/bin/env node
/**
 * live-hook-integrity.mts  -  SessionStart hook
 *
 * Proves that every hook file wired in the LIVE settings can enforce anything at
 * all, and repairs it from the versioned source when it cannot. "Every file" is
 * what Node loads to run them: the wired files plus the transitive closure of
 * their relative static imports under hooks/ (lib/hook-inventory.mts). A missing
 * or 0-byte lib passes the syntax check of its importer and still kills the hook
 * at import with exit 1, which Claude Code treats as non-blocking (issue #273).
 *
 * GRUND: since 2026-08-05 ~/.claude/hooks/commit-guard.js has repeatedly fallen
 * back to 0 bytes (three repair-and-relapse cycles on record). A 0-byte .js file
 * runs, does nothing and exits 0 - the hook layer cannot tell it apart from
 * "checked, nothing to report". That is fail-open, and the writer is UNKNOWN, so
 * this has to hold regardless of who does the writing.
 *
 * Three states, never merged (goldene Regel 12): OK (present, non-empty, parses),
 * DEFEKT (absent, 0 bytes, rejected by Node's parser), UNGEPRUEFT (the read path
 * or the syntax check itself failed). A failed read must never look like a
 * healthy file. A restore counts only when MEASURED at the target: size > 0 and
 * the SHA-256 there equals the source, because reporting one's own copy action
 * is not a measurement (goldene Regel 13). That source is resolved through
 * lib/orchestra-checkout.mts and NOT through the session cwd: these hooks are
 * global, so a wiped guard has to be repairable from a session started
 * anywhere. A restore never writes
 * through a symbolic link or into a directory that resolves outside the real
 * hooks directory.
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

import { isWithinPath, joinPathLike, normalizePathLike, type ScopePayload } from "./lib/workspace-scope.mts";
import { checkoutFor } from "./lib/orchestra-checkout.mts";
import { hookInventory, wiredFiles } from "./lib/hook-inventory.mts";
import { quietStripWarning, syntaxVerdict } from "./lib/hook-syntax.mts";

type Before = { size?: number; mtime?: string; ino?: number };
type Verdict = { state: "OK" | "DEFEKT" | "UNGEPRUEFT"; reason?: string; before?: Before };
type Restored = { proven: boolean; sha?: string; why?: string };

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const errorCode = (error: unknown): string | undefined => (error ? (error as NodeJS.ErrnoException).code : undefined);

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
  const verdict = await syntaxVerdict(file, source);
  if (verdict.state === "OK") return { state: "OK", before };
  return { state: verdict.state, reason: verdict.state === "DEFEKT" ? verdict.detail : `syntax unchecked (${verdict.detail})`, before };
}

// Every target already lies under hooksDir as a string. This proves it on disk:
// copyFileSync follows a symlink at the target, and a symlinked hooks/lib would
// carry the write elsewhere. "" means the write may go ahead.
function writeRefusal(file: string, hooksDir: string): string {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return "target is a symbolic link; refusing to write through it";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return `target lstat failed (${errorCode(error) || "unknown"})`;
  }
  // No hooks directory yet: nothing under it can be a link, mkdirSync creates it.
  if (!fs.existsSync(hooksDir)) return "";
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    if (isWithinPath(fs.realpathSync(dir), fs.realpathSync(hooksDir))) return "";
  } catch (error) {
    return `realpath failed (${errorCode(error) || "unknown"})`;
  }
  return `hooks directory or its subdirectory resolves outside ${hooksDir}`;
}

function restore(file: string, rel: string, repoRoot: string, hooksDir: string): Restored {
  if (!repoRoot) return { proven: false, why: "no checkout resolved via workspace, KHEREP_WORKSPACE or install note" };
  const source = joinPathLike(repoRoot, `claude/hooks/${rel}`);
  let wanted: Buffer;
  try {
    wanted = fs.readFileSync(source);
  } catch (error) {
    return { proven: false, why: `versioned source ${source} unreadable (${errorCode(error) || "unknown"})` };
  }
  if (!wanted.length) return { proven: false, why: `versioned source ${source} is itself 0 bytes` };
  const refusal = writeRefusal(file, hooksDir);
  if (refusal) return { proven: false, why: refusal };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(source, file);
  } catch (error) {
    return { proven: false, why: `copy failed (${errorCode(error) || "unknown"})` };
  }
  // Measured at the target. The copy call reporting success is not a measurement.
  let landed: Buffer;
  try {
    landed = fs.readFileSync(file);
  } catch (error) {
    return { proven: false, why: `target unreadable after the copy (${errorCode(error) || "unknown"})` };
  }
  const sha = sha256(landed);
  if (!landed.length || sha !== sha256(wanted)) {
    return { proven: false, sha, why: "the target does not match the versioned source after the copy" };
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

async function main(): Promise<void> {
  quietStripWarning();
  let payload: ScopePayload | null = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}") as ScopePayload | null;
  } catch {
    payload = {};
  }
  const home = normalizePathLike(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
  const repoRoot = checkoutFor(payload, home);
  const hooksDir = `${home}/hooks`;
  const { files, notes, readAny } = wiredFiles(home);
  const lines = notes.slice();
  if (!readAny && !files.length) {
    lines.push(`no live settings could be read under ${home}, so WHICH hooks are wired is UNKNOWN here`);
  }
  // The walk reads the live file, and the versioned one when the live file is
  // gone or empty, so one broken link does not hide the files behind it.
  const readSource = (file: string, rel: string): string | null => {
    for (const candidate of [file, repoRoot && joinPathLike(repoRoot, `claude/hooks/${rel}`)]) {
      try {
        const text = candidate ? fs.readFileSync(candidate, "utf8") : "";
        if (text) return text;
      } catch {
        /* next candidate */
      }
    }
    return null;
  };

  for (const { file, rel, wired, importedBy } of hookInventory(files, hooksDir, readSource)) {
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

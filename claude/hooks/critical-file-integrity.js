#!/usr/bin/env node
/**
 * critical-file-integrity.js  -  SessionStart hook
 *
 * live-hook-integrity.js proves that every hook file WIRED IN SETTINGS can
 * still enforce something. Its scope is deliberately narrow: `.js` under
 * <CLAUDE_HOME>/hooks/. That leaves the one file that actually binds every
 * runtime completely unguarded - ~/.claude/kherep/githooks/commit-msg, the
 * git hook behind the work-item rule. It is not wired in settings, it is not
 * a .js, and it sits in the same tree where a file was repeatedly replaced by
 * a 0-byte version (OP-664, writer still UNKNOWN).
 *
 * A 0-byte commit-msg is fail-open in exactly the same way a 0-byte
 * commit-guard.js is: sh runs it, it does nothing, it exits 0, and git reads
 * exit 0 as "message accepted". Nothing in the chain can tell that apart from
 * a real pass.
 *
 * Deliberately a SEPARATE file rather than an extension of
 * live-hook-integrity.js: that one sits at exactly 250 LOC, the CLAUDE.md
 * ceiling (goldene Regel 6), and it currently works. Adding a second concern
 * to it would force a split of a load-bearing file for no gain. This hook is
 * itself a wired .js under hooks/, so live-hook-integrity covers IT - the two
 * guard each other.
 *
 * Same three states as its sibling, never merged (goldene Regel 12): OK,
 * DEFEKT, UNGEPRUEFT. A restore counts only when MEASURED at the target
 * (goldene Regel 13). Silent when everything is OK. Any error exits 0.
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { joinPathLike, normalizePathLike } = require("./lib/workspace-scope.mts");
const { checkoutFor } = require("./lib/orchestra-checkout.mts");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Live path relative to CLAUDE_HOME -> source path relative to the checkout.
// Non-.js, security-bearing files that no other integrity layer looks at.
const CRITICAL = [
  {
    rel: "kherep/githooks/commit-msg",
    source: "claude/kherep/githooks/commit-msg",
    // git skips a hook without the mode bit SILENTLY, so restoring the bytes
    // without the bit would look repaired and enforce nothing.
    executable: true,
    why: "git commit-msg hook: the only work-item enforcement that binds every runtime",
  },
  // OP-734, 2026-08-10. Both run or are trusted at SessionStart and no other
  // layer looks at them: live-hook-integrity.js covers only .js under hooks/,
  // and drift-check.sh only reports when a human runs it.
];

function classify(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    const code = (error && error.code) || "unknown";
    if (code === "ENOENT") return { state: "DEFEKT", reason: "wired but not present on disk" };
    return { state: "UNGEPRUEFT", reason: `stat failed (${code})` };
  }
  // Before the size test: a directory reports size 0 on Windows and would
  // otherwise be mistaken for the 0-byte incident.
  if (!stat.isFile()) return { state: "UNGEPRUEFT", reason: "not a regular file" };
  const before = { size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), ino: stat.ino };
  if (stat.size === 0) {
    return { state: "DEFEKT", reason: "0 bytes - sh runs it, it enforces nothing and exits 0 (fail-open)", before };
  }
  return { state: "OK", before };
}

// OP-734. Emptiness is only the loud half of the problem. A file that was
// SWAPPED keeps a plausible size and passes classify(), which is precisely the
// dangerous case for a pinned trust anchor: verification still runs, against
// the attacker's certificate. Every file in CRITICAL is repo-managed, so live
// content that differs from the checkout is a defect by definition - the same
// assertion drift-check.sh makes, just self-triggered here.
// Returns null when the comparison itself could not be made; the caller must
// not turn that into a verdict (goldene Regel 12).
function contentMismatch(file, entry, repoRoot) {
  if (!repoRoot) return null;
  const source = joinPathLike(repoRoot, entry.source);
  let live;
  let want;
  try {
    live = fs.readFileSync(file);
    want = fs.readFileSync(source);
  } catch {
    return null;
  }
  if (live.equals(want)) return false;
  return {
    liveSha: crypto.createHash("sha256").update(live).digest("hex").slice(0, 16),
    wantSha: crypto.createHash("sha256").update(want).digest("hex").slice(0, 16),
  };
}

function restore(file, entry, repoRoot) {
  if (!repoRoot) return { proven: false, why: "no kherep checkout resolved" };
  const source = joinPathLike(repoRoot, entry.source);
  let wanted;
  try {
    wanted = fs.readFileSync(source);
  } catch (error) {
    return { proven: false, why: `versioned source ${source} unreadable (${(error && error.code) || "unknown"})` };
  }
  if (!wanted.length) return { proven: false, why: `versioned source ${source} is itself 0 bytes` };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(source, file);
    if (entry.executable) fs.chmodSync(file, 0o755);
  } catch (error) {
    return { proven: false, why: `copy failed (${(error && error.code) || "unknown"})` };
  }
  // Measured at the target. Reporting one's own copy call is not a measurement.
  let landed;
  try {
    landed = fs.readFileSync(file);
  } catch (error) {
    return { proven: false, why: `target unreadable after the copy (${(error && error.code) || "unknown"})` };
  }
  const sha = sha256(landed);
  if (!landed.length || sha !== sha256(wanted)) {
    return { proven: false, sha, why: "the target does not match the versioned source after the copy" };
  }
  return { proven: true, sha };
}

function journal(home, entry) {
  try {
    const dir = path.join(home, ".cache", "hook-integrity");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "incidents.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* a journal we cannot write must never break a session start */
  }
}

function emit(lines) {
  if (!lines.length) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `ORCHESTRA CRITICAL-FILE-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
      },
    })
  );
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    payload = {};
  }
  const home = normalizePathLike(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
  const repoRoot = checkoutFor(payload, home);
  const lines = [];

  for (const entry of CRITICAL) {
    const file = joinPathLike(home, entry.rel);
    let { state, reason, before = {} } = classify(file);
    if (state === "OK") {
      const swapped = contentMismatch(file, entry, repoRoot);
      if (swapped === null) continue;      // comparison impossible -> say nothing, claim nothing
      if (swapped === false) continue;     // proven identical to its source
      state = "DEFEKT";
      reason = `content differs from source (live ${swapped.liveSha}..., source ${swapped.wantSha}...)`;
    }
    const record = {
      ts: new Date().toISOString(), file: entry.rel, path: file, state, reason,
      sizeBefore: before.size === undefined ? null : before.size,
      mtimeBefore: before.mtime || null,
      inoBefore: before.ino === undefined ? null : before.ino,
      sha256After: null, restoreProven: false, guard: "critical-file-integrity",
    };
    if (state === "UNGEPRUEFT") {
      lines.push(`${entry.rel}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
      journal(home, record);
      continue;
    }
    const result = restore(file, entry, repoRoot);
    record.sha256After = result.sha || null;
    record.restoreProven = result.proven;
    if (!result.proven) record.restoreDetail = result.why;
    journal(home, record);
    lines.push(
      result.proven
        ? `${entry.rel}: ${reason} -> RESTORED from the repo, verified at the target (sha256 ${result.sha.slice(0, 12)})`
        : `${entry.rel}: ${reason} -> NOT restored (${result.why}). ${entry.why} IS OFF.`
    );
  }

  emit(lines);
}

try {
  main();
} catch (error) {
  try {
    emit([`the critical-file check itself failed (${(error && error.message) || "unknown"}); nothing was verified`]);
  } catch {
    /* never break session start */
  }
}
process.exit(0);

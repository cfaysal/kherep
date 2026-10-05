#!/usr/bin/env node
/**
 * live-hook-integrity.js  -  SessionStart hook
 *
 * Proves that every hook file wired in the LIVE settings can enforce anything at
 * all, and repairs it from the versioned source when it cannot.
 *
 * GRUND: since 2026-08-05 ~/.claude/hooks/commit-guard.js has repeatedly fallen
 * back to 0 bytes (three repair-and-relapse cycles on record). A 0-byte .js file
 * runs, does nothing and exits 0 - the hook layer cannot tell it apart from
 * "checked, nothing to report". That is fail-open, and the writer is UNKNOWN, so
 * this has to hold regardless of who does the writing.
 *
 * Three states, never merged (goldene Regel 12): OK (present, non-empty, parses),
 * DEFEKT (absent, 0 bytes, rejected by `node --check`), UNGEPRUEFT (the read path
 * itself failed). A failed read must never look like a healthy file. A restore
 * counts only when MEASURED at the target: size > 0 and the SHA-256 there equals
 * the source, because reporting one's own copy action is not a measurement
 * (goldene Regel 13). That source is resolved through lib/orchestra-checkout.mts
 * and NOT through the session cwd: these hooks are global, so a wiped guard has
 * to be repairable from a session started anywhere.
 *
 * Speed: `node --check` over all wired files costs ~2s per session start, an
 * in-process parse ~5ms. The child `node --check` runs only to CONFIRM a file the
 * in-process parse rejected, so the DEFEKT verdict is still node's own.
 *
 * Fail-safe: any unexpected error is caught, reported, exit 0. Silent when
 * everything is OK. No network, no child process beyond that `node --check`.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const { isWithinPath, joinPathLike, normalizePathLike } = require("./lib/workspace-scope.mts");
const { checkoutFor } = require("./lib/orchestra-checkout.mts");

const SETTINGS_FILES = ["settings.json", "settings.user.json"];
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Every hook event, not just SessionStart: a dead PreToolUse guard is the whole
// reason this exists.
function commandsIn(settings) {
  const out = [];
  const events = (settings && typeof settings.hooks === "object" && settings.hooks) || {};
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const entry of (group && Array.isArray(group.hooks) && group.hooks) || []) {
        if (entry && typeof entry.command === "string") out.push(entry.command);
      }
    }
  }
  return out;
}

function expandToken(token, home) {
  let raw = String(token).replace(/^['"]+|['"]+$/g, "").replace(/\$\{?CLAUDE_HOME\}?/g, home);
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) raw = os.homedir() + raw.slice(1);
  return normalizePathLike(raw);
}

// Only .js and .mts under <CLAUDE_HOME>/hooks/ are in scope: an extension-less
// wrapper carries no syntax contract, files elsewhere are not this hook's business.
function wiredFiles(home) {
  const hooksDir = `${home}/hooks`;
  const found = new Map();
  const notes = [];
  let readAny = false;
  for (const name of SETTINGS_FILES) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(home, name), "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) notes.push(`${name}: not valid JSON, its wiring is UNKNOWN from here`);
      else if (error && error.code !== "ENOENT") notes.push(`${name}: unreadable (${error.code})`);
      continue;
    }
    readAny = true;
    for (const command of commandsIn(parsed)) {
      for (const token of command.split(/\s+/)) {
        const file = expandToken(token, home);
        if (!/\.(?:js|mts)$/i.test(file) || !isWithinPath(file, hooksDir)) continue;
        if (!found.has(file.toLowerCase())) {
          found.set(file.toLowerCase(), { file, rel: file.slice(hooksDir.length + 1) });
        }
      }
    }
  }
  return { files: [...found.values()], notes, readAny };
}

function parsesInProcess(source, filename) {
  try {
    new vm.Script(source, { filename });
    return true;
  } catch {
    return false;
  }
}

// The verdict, not the fast path. Returns "" when node itself accepts the file.
function nodeCheckDetail(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 });
    return "";
  } catch (error) {
    const lines = String((error && error.stderr) || "").split(/\r?\n/).map((l) => l.trim());
    return lines.find((l) => /Error|error:/.test(l)) || "rejected by node --check";
  }
}

function classify(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    const code = (error && error.code) || "unknown";
    if (code === "ENOENT") return { state: "DEFEKT", reason: "wired but not present on disk" };
    return { state: "UNGEPRUEFT", reason: `stat failed (${code})` };
  }
  // Before the size test on purpose: a directory reports size 0 on Windows and
  // would otherwise be mistaken for the 0-byte incident.
  if (!stat.isFile()) return { state: "UNGEPRUEFT", reason: "not a regular file" };
  const before = { size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), ino: stat.ino };
  if (stat.size === 0) {
    return { state: "DEFEKT", reason: "0 bytes - it runs, enforces nothing and exits 0 (fail-open)", before };
  }
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { state: "UNGEPRUEFT", reason: `unreadable (${(error && error.code) || "unknown"})`, before };
  }
  if (parsesInProcess(source, file)) return { state: "OK", before };
  // node accepting what the in-process parse rejected (top-level return in CJS,
  // for instance) means the file is fine. node --check has the last word.
  const detail = nodeCheckDetail(file);
  return detail ? { state: "DEFEKT", reason: `rejected by node --check: ${detail}`, before } : { state: "OK", before };
}

function restore(file, rel, repoRoot) {
  if (!repoRoot) return { proven: false, why: "no checkout resolved via workspace, KHEREP_WORKSPACE or install note" };
  const source = joinPathLike(repoRoot, `claude/hooks/${rel}`);
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
  } catch (error) {
    return { proven: false, why: `copy failed (${(error && error.code) || "unknown"})` };
  }
  // Measured at the target. The copy call reporting success is not a measurement.
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
        additionalContext: `ORCHESTRA LIVE-HOOK-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
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
  const { files, notes, readAny } = wiredFiles(home);
  const lines = notes.slice();
  if (!readAny && !files.length) {
    lines.push(`no live settings could be read under ${home}, so WHICH hooks are wired is UNKNOWN here`);
  }

  for (const { file, rel } of files) {
    const { state, reason, before = {} } = classify(file);
    if (state === "OK") continue;
    const entry = {
      ts: new Date().toISOString(), file: rel, path: file, state, reason,
      sizeBefore: before.size === undefined ? null : before.size,
      mtimeBefore: before.mtime || null,
      inoBefore: before.ino === undefined ? null : before.ino,
      sha256After: null, restoreProven: false,
    };
    if (state === "UNGEPRUEFT") {
      lines.push(`${rel}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
      journal(home, entry);
      continue;
    }
    const result = restore(file, rel, repoRoot);
    entry.sha256After = result.sha || null;
    entry.restoreProven = result.proven;
    if (!result.proven) entry.restoreDetail = result.why;
    journal(home, entry);
    lines.push(
      result.proven
        ? `${rel}: ${reason} -> RESTORED from the repo, verified at the target (sha256 ${result.sha.slice(0, 12)})`
        : `${rel}: ${reason} -> NOT restored (${result.why}). ENFORCEMENT IS OFF for this hook.`
    );
  }

  emit(lines);
}

try {
  main();
} catch (error) {
  try {
    emit([`the integrity check itself failed (${(error && error.message) || "unknown"}); nothing was verified`]);
  } catch {
    /* never break session start */
  }
}
process.exit(0);

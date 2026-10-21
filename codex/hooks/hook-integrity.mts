#!/usr/bin/env node
/**
 * hook-integrity.mts  -  Codex SessionStart hook (issue #275), the counterpart of
 * claude/hooks/live-hook-integrity.mts, which runs only when a Claude session
 * starts. Wired LAST in the Maestro SessionStart group: trust keys are positional.
 * Checks every .mts/.js file a config.toml hook command names under
 * <CODEX_HOME>/hooks, their import closure and ALWAYS_CHECK; restores a broken
 * one from the checkout and counts it only when MEASURED (size > 0, SHA-256 equal
 * to the checkout bytes). Own libs load dynamically, so a broken one is reported
 * (kind "self"). Cannot block: silent when OK, always exit 0.
 *
 * Issue #507, part 3. Codex has no hook runtime, so before anything is restored
 * or journalled, own libs included, the hook takes run.lock (lib/integrity-
 * heartbeat.mts: an EXCLUSIVE SQLite transaction the OS releases with this
 * process); without it, it reports and changes nothing. It removes the heartbeat
 * before its first repair, walks the closure again after each repair pass
 * (lib/integrity-passes.mts, at most three), checks the live closure once more
 * read-only and writes <CODEX_HOME>/.cache/hook-integrity/heartbeat.json only
 * when all of that passed, with the fd-bound record of the three dispatcher files
 * (issue #507, part 4). `--trigger <source>` (the re-check of the hook adapter or
 * the shell dispatcher) prints plain lines instead of the SessionStart JSON.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { HookFile, InventoryEntry, SourceText } from "../../claude/hooks/lib/hook-inventory.mts";
import type { PeerTuple, RunLock } from "../../claude/hooks/lib/integrity-heartbeat.mts";
import type { Outcome } from "../../claude/hooks/lib/integrity-passes.mts";
import type { ScopePayload } from "../../claude/hooks/lib/workspace-scope.mts";

type Libs = typeof import("../../claude/hooks/lib/workspace-scope.mts") & typeof import("../../claude/hooks/lib/orchestra-checkout.mts") &
  typeof import("../../claude/hooks/lib/restore-write.mts") & typeof import("../../claude/hooks/lib/integrity-heartbeat.mts") &
  typeof import("../../claude/hooks/lib/hook-inventory.mts") & typeof import("../../claude/hooks/lib/hook-syntax.mts") &
  typeof import("../../claude/hooks/lib/integrity-verdict.mts") & typeof import("../../claude/hooks/lib/integrity-passes.mts");
type Restored = { proven: boolean; sha?: string; why?: string };
// The first lib that did not load or lacks a used function; `loaded` libs did.
type LoadFailure = { rel: string; why: string; loaded: number };

const SELF = "kherep-maestro/codex-hook-integrity.mts";
// privacy-boundary-guard.mts requires workspace-scope and private-path-policy by a
// computed path the walk cannot see (the other two are the latter's imports), and
// dispatch-contract-guard.mts requires obs-brief-policy the same way (issue #331),
// so the walk reads them as imports of the guard that loads them.
const COMPUTED: Record<string, string[]> = {
  // Registers the child guard edges appended by computedImports below; its re-check lib
  // is loaded by a computed path like the adapter's (issue #507, part 4).
  "kherep-maestro/codex-shell-checks.mts": ["guard-recheck"],
  "kherep-maestro/codex-privacy-boundary-guard.mts": ["workspace-scope", "private-path-policy", "private-path-rules", "real-path-policy"],
  "kherep-maestro/codex-dispatch-contract-guard.mts": ["obs-brief-policy"],
  // The adapter loads its re-check lib by a computed path (issue #507, part 3).
  "kherep-maestro/codex-hook-adapter.mts": ["guard-recheck"],
  "kherep-maestro/hook-adapter.mts": ["guard-recheck"],
};
export const ALWAYS_CHECK = Object.values(COMPUTED).flat().map((name) => `./lib/${name}.mts`);
const computedImports = (rel: string): string => (COMPUTED[rel] || []).map((name) => `\nimport "./lib/${name}.mts";`).join("")
  + (rel === "kherep-maestro/codex-shell-checks.mts"
    ? ["commit-guard", "deploy-guard", "main-checkout-guard"].map(name => `\nimport "./${name}.mts";`).join("") : "");
// Issue #507, part 4. Files no hook checks for itself; each dispatcher compares the other's stat
// with the record a proven run leaves in heartbeat.json "peers" (lib/integrity-heartbeat.mts provenPeer).
const DISPATCHERS = new Set(["kherep-maestro/codex-hook-adapter.mts", "kherep-maestro/hook-adapter.mts", "kherep-maestro/codex-shell-checks.mts"]);
const RENDERED = new Set(["kherep-maestro/codex-observation-stop.mts", "kherep-maestro/codex-observation-turn-completion.mts"]);
// Copied from codex/hooks under their own name; every other plain name is a shared Claude guard.
const CODEX_HELPERS = new Set(["acceptance-policy.mts", "obs-candidate-policy.mts", "research-common.mts", "research-exec-parser.mts",
  "research-transcript.mts", "post-edit-tool-calls.mts", "hook-adapter.mts", "hook-adapter-payload.mts", "hook-adapter-verdict.mts",
  "hook-adapter-run.mts"]);
const DELIVER_HOOK = "/modules/control-plane/node/deliver-hook.mts";

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code || "unknown";
// The bytes, or the error code that stopped the read.
function read(file: string | number): Buffer | string {
  try { return fs.readFileSync(file); } catch (error) { return errorCode(error); }
}
// Filled by loadLibs. A restore needs only the first RESTORE_LIBS of its steps, run.lock included.
export const lib = {} as Libs;
const RESTORE_LIBS = 4;
const LIB_DIR = fs.existsSync(path.join(import.meta.dirname, "lib"))
  ? path.join(import.meta.dirname, "lib") : path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "lib");
const TRIGGER_AT = process.argv.indexOf("--trigger");
const PLAIN = TRIGGER_AT >= 0;
const TRIGGER = PLAIN ? process.argv[TRIGGER_AT + 1] || "unnamed" : "session-start";
const LOST = "the run lock was lost";

// Dependency order, so a broken lib is named before the libs importing it.
export async function loadLibs(): Promise<LoadFailure | null> {
  const steps: [string, string[]][] = [
    ["workspace-scope.mts", ["isWithinPath", "joinPathLike", "normalizePathLike"]], ["orchestra-checkout.mts", ["checkoutFor", "isCheckout"]],
    ["restore-write.mts", ["writeExact"]], ["integrity-heartbeat.mts", ["takeRunLock", "invalidateHeartbeat", "writeHeartbeat", "provenPeer"]],
    ["hook-inventory.mts", ["hookInventory"]], ["hook-syntax.mts", ["syntaxVerdict"]],
    ["integrity-verdict.mts", ["classify"]], ["integrity-passes.mts", ["repairPasses", "finalPass"]],
  ];
  for (const [index, [name, used]] of steps.entries()) {
    const rel = `lib/${name}`;
    let mod: Record<string, unknown>;
    try { mod = (await import(pathToFileURL(path.join(LIB_DIR, name)).href)) as Record<string, unknown>; } catch (error) {
      return { rel, why: String((error as Error)?.message || error).split(/\r?\n/)[0], loaded: index };
    }
    const missing = used.filter((fn) => typeof mod[fn] !== "function");
    if (missing.length) return { rel, why: `no function ${missing.join(", ")}`, loaded: index };
    Object.assign(lib, mod);
  }
  return null;
}

// The double-quoted parts of every `command` in a [[hooks.<event>.hooks]] table:
// a basic string is decoded as JSON, a literal string taken raw. Needs no lib.
export function hookCommandParts(config: string): string[] {
  const parts: string[] = [];
  let inHook = false;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inHook = /^\s*\[\[\s*hooks\.[^\]]+\.hooks\s*\]\]/.test(line);
    const value = inHook ? /^\s*command\s*=\s*(.*)$/.exec(line)?.[1] : undefined;
    if (!value) continue;
    let text = /^'([^']*)'/.exec(value)?.[1] || "";
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value)?.[1];
    try { if (basic !== undefined) text = JSON.parse(`"${basic}"`) as string; } catch { continue; }
    for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) parts.push(match[1].replace(/\\"/g, '"'));
  }
  return parts;
}

// config.toml may name the home through a symlink (macOS /var -> /private/var) while
// hooksDir comes from this file's real path: a part under another spelling of the
// same directory is mapped onto hooksDir by the real path of its directory.
const realOrNull = (p: string): string | null => { try { return lib.normalizePathLike(fs.realpathSync(p)); } catch { return null; } };
function underHooksDir(part: string, hooksDir: string, realHooks: string | null): string {
  if (lib.isWithinPath(part, hooksDir) || !realHooks) return part;
  const realDir = realOrNull(path.dirname(part));
  const real = realDir && `${realDir}/${path.basename(part)}`;
  return real && lib.isWithinPath(real, realHooks) ? `${hooksDir}${real.slice(realHooks.length)}` : part;
}

export function wiredHookFiles(parts: string[], hooksDir: string): HookFile[] {
  const found = new Map<string, HookFile>();
  const realHooks = realOrNull(hooksDir);
  for (const file of parts.map((part) => underHooksDir(lib.normalizePathLike(part), hooksDir, realHooks))) {
    if (!/\.(?:js|mts)$/i.test(file) || !lib.isWithinPath(file, hooksDir) || file.length <= hooksDir.length) continue;
    found.set(file.toLowerCase(), { file, rel: file.slice(hooksDir.length + 1) });
  }
  return [...found.values()];
}

// The checkout path of the versioned source of an installed file (rel to
// <CODEX_HOME>/hooks), or why there is none.
export function sourceOf(rel: string): { from: string } | { hint: string } {
  if (RENDERED.has(rel)) return { hint: "rendered by the installer, no byte-identical source; run codex/install.mts" };
  if (rel === "kherep-maestro-context.mts") return { from: "codex/hooks/kherep-maestro-context.mts" };
  const own = /^kherep-maestro\/(.+)$/.exec(rel)?.[1];
  if (own?.startsWith("lib/")) return { from: `claude/hooks/${own}` };
  if (!own || own.includes("/")) return { hint: "not installed by Kherep, so there is no versioned source" };
  if (own.startsWith("codex-")) return { from: `codex/hooks/${own.slice("codex-".length)}` };
  return { from: `${CODEX_HELPERS.has(own) ? "codex" : "claude"}/hooks/${own}` };
}

// Issue #503. The source root the installer recorded for the Control Plane
// hooks under <home>/orchestra, or "" when the pointer is absent or invalid.
// The same schema check as readPointer() in control-plane-hook.mts, which this
// file cannot import by a fixed name; hook-integrity.test.mts runs both on the
// same pointers.
function pointerRoot(home: string): string {
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
export function checkoutOf(parts: string[], payload: ScopePayload | null, env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const pointed = home ? pointerRoot(home) : "";
  if (pointed && lib.isCheckout(pointed)) return pointed;
  const deliver = parts.map(lib.normalizePathLike).find((part) => part.toLowerCase().endsWith(DELIVER_HOOK));
  const root = deliver ? deliver.slice(0, -DELIVER_HOOK.length) : "";
  if (lib.isCheckout(root)) return root;
  return lib.checkoutFor(payload, lib.normalizePathLike(env.CLAUDE_HOME || path.join(os.homedir(), ".claude")), env);
}

function restore(file: string, from: string, repoRoot: string, hooksDir: string): Restored {
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

function journal(home: string, entry: Record<string, unknown>): void {
  const dir = path.join(home, ".cache", "hook-integrity");
  // A journal we cannot write must never break a session start.
  try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, "incidents.jsonl"), `${JSON.stringify(entry)}\n`, "utf8"); } catch { /* ignored */ }
}

function emit(lines: string[]): void {
  if (!lines.length) return;
  if (PLAIN) return void process.stdout.write(lines.map((line) => `${line}\n`).join(""));
  const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : "";
  const additionalContext = `KHEREP CODEX HOOK-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`;
  process.stdout.write(JSON.stringify({ systemMessage: `Kherep hook integrity: ${lines[0]}${more}`,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
}

const outcome = (result: Restored): string => result.proven
  ? `RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)})`
  : `NOT restored (${result.why}). ENFORCEMENT IS OFF for this hook`;

// This hook without one of its libs: one line. The lib is restored, after the
// heartbeat is gone, and journalled as kind "self" (with this file's own journal:
// integrity-verdict.mts may be the broken one) only under run.lock, and only when
// the libs the restore needs loaded. It never writes a heartbeat.
function ownImportFailed({ rel, why, loaded }: LoadFailure, payload: ScopePayload | null, home: string, parts: string[],
  lock: RunLock | string | null): string[] {
  const file = path.join(LIB_DIR, path.basename(rel)).replace(/\\/g, "/");
  let result: Restored;
  if (!lock || loaded < RESTORE_LIBS) {
    result = { proven: false, why: "the restore itself needs workspace-scope, orchestra-checkout, restore-write and integrity-heartbeat (run.lock)" };
  } else if (typeof lock === "string") {
    result = { proven: false, why: lock };
  } else {
    const blocked = lock.holding() ? lib.invalidateHeartbeat(home) : LOST;
    result = blocked ? { proven: false, why: blocked }
      : restore(file, `claude/hooks/${rel}`, checkoutOf(parts, payload, process.env, home), `${lib.normalizePathLike(home)}/hooks`);
    if (lock.holding()) journal(home, {
      ts: new Date().toISOString(), trigger: TRIGGER, file: `kherep-maestro/${rel}`, path: file, state: "DEFEKT", reason: why, kind: "self",
      importedBy: [SELF], sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why,
    });
  }
  return [`own import ${rel} cannot be loaded (${why}); nothing was verified this session -> ${outcome(result)}`,
    ...(PLAIN ? [`heartbeat not written (own import ${rel} cannot be loaded)`] : [])];
}

// The install this file belongs to; run from anywhere else, CODEX_HOME or ~/.codex.
function codexHome(): string {
  const dir = import.meta.dirname;
  if (path.basename(dir) === "kherep-maestro" && path.basename(path.dirname(dir)) === "hooks") return path.dirname(path.dirname(dir));
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// One run under run.lock: the repair passes, the final read-only pass, the heartbeat.
async function check(lock: RunLock, payload: ScopePayload | null, home: string, parts: string[]): Promise<string[]> {
  const hooksDir = `${lib.normalizePathLike(home)}/hooks`;
  const realHooks = realOrNull(hooksDir) ?? hooksDir;
  const repoRoot = checkoutOf(parts, payload, process.env, home);
  const wired = wiredHookFiles(parts, hooksDir);
  const lines = wired.length ? [] : [`no hook file under ${hooksDir} is wired in config.toml, so WHICH hooks run is UNKNOWN here`];
  let unproven = wired.length ? "" : "no wired file";
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
  const state = { invalidated: false, blocked: "" };
  // A journal line is a mutation too: only while this run holds the lock.
  const record = (entry: Record<string, unknown>): void => { if (lock.holding()) journal(home, entry); };
  const checkOne = async ({ file, rel, wired: isWired, importedBy }: InventoryEntry): Promise<Outcome> => {
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
      result = state.blocked ? { proven: false, why: state.blocked } : restore(file, source.from, repoRoot, hooksDir);
    }
    Object.assign(entry, { sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why });
    lines.push(`${label}: ${reason} -> ${outcome(result)}`);
    record(entry);
    if (!result.proven) return { unproven: `${rel} is not restored`, restored: false };
    const after = (await lib.classify(lib, file, "restored")).state;
    if (after !== "OK") lines.push(`${label}: still ${after} after the restore`);
    return { unproven: after === "OK" ? "" : `${rel} is not OK after the restore`, restored: true };
  };
  const walk = (reader: typeof readSource) => (): InventoryEntry[] => lib.hookInventory(wired, hooksDir, reader, realHooks);
  const passes = await lib.repairPasses({ walk: walk(readSource), checkOne });
  unproven ||= passes.unproven;
  // A dispatcher's record comes from its own fd-bound snapshot of the bytes judged, never from
  // classify's stat; a dispatcher without one is re-checked by the other on its next call.
  const peers: Record<string, PeerTuple> = {};
  if (!unproven) unproven = await lib.finalPass({ walk: walk(liveOnly), expected: passes.inventory, classify: async (entry) => {
    const verdict = await lib.classify(lib, entry.file, entry.wired ? "wired" : "imported");
    const peer = verdict.state === "OK" && DISPATCHERS.has(entry.rel) ? await lib.provenPeer(entry.file, lib.syntaxVerdict) : null;
    if (peer) peers[path.basename(entry.rel)] = peer;
    return verdict;
  } });
  if (!unproven && !lock.holding()) unproven = LOST;
  const files = passes.inventory.length;
  if (!unproven) unproven = lib.writeHeartbeat(home, { trigger: TRIGGER, runtime: "codex", files, peers });
  if (PLAIN) lines.push(unproven ? `heartbeat not written (${unproven})` : `all ${files} files OK (${passes.restored} restored), heartbeat refreshed`);
  return lines;
}

async function main(): Promise<void> {
  let payload: ScopePayload | null = {};
  try { payload = JSON.parse(String(read(0)) || "{}") as ScopePayload | null; } catch { /* no payload: no cwd */ }
  const home = codexHome();
  const config = read(path.join(home, "config.toml"));
  const parts = typeof config === "string" ? [] : hookCommandParts(config.toString("utf8"));
  const failed = await loadLibs();
  // Ownership before any mutation: without run.lock nothing is restored, journalled or published.
  const lock = failed && failed.loaded < RESTORE_LIBS ? null : lib.takeRunLock(home);
  let lines: string[] = [];
  try {
    if (failed) lines = ownImportFailed(failed, payload, home, parts, lock);
    else if (typeof lock === "string" || !lock) lines = [`${lock}; nothing checked, heartbeat not written`];
    else if (typeof config === "string") {
      lines = [`config.toml under ${home} unreadable (${config}), so WHICH hooks are wired is UNKNOWN here`,
        ...(PLAIN ? ["heartbeat not written (config.toml unreadable)"] : [])];
    } else lines = await check(lock, payload, home, parts);
  } finally {
    const why = lock && typeof lock !== "string" ? lock.release() : "";
    if (why) lines.push(why);
  }
  emit(lines);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory matches only after realpath; both spellings count.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try { return [path.resolve(entry), fs.realpathSync(entry)].some((file) => import.meta.url === pathToFileURL(file).href); } catch { return false; }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    try { emit([`the integrity check itself failed (${(error as Error)?.message || "unknown"}); nothing was verified`]); } catch { /* never break session start */ }
  }).finally(() => process.exit(0));
}

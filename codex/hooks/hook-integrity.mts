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
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { HookFile } from "../../claude/hooks/lib/hook-inventory.mts";
import type { ScopePayload } from "../../claude/hooks/lib/workspace-scope.mts";

type Libs = typeof import("../../claude/hooks/lib/workspace-scope.mts") & typeof import("../../claude/hooks/lib/orchestra-checkout.mts") &
  typeof import("../../claude/hooks/lib/restore-write.mts") & typeof import("../../claude/hooks/lib/hook-inventory.mts") &
  typeof import("../../claude/hooks/lib/hook-syntax.mts");
type Verdict = { state: "OK" | "DEFEKT" | "UNGEPRUEFT"; reason?: string; before?: { size?: number; mtime?: string; ino?: number } };
type Restored = { proven: boolean; sha?: string; why?: string };
// The first lib that did not load or lacks a used function; `loaded` libs did.
type LoadFailure = { rel: string; why: string; loaded: number };

const SELF = "kherep-maestro/codex-hook-integrity.mts";
// privacy-boundary-guard.mts requires workspace-scope and private-path-policy by a
// computed path the walk cannot see (the other two are the latter's imports), and
// dispatch-contract-guard.mts requires obs-brief-policy the same way (issue #331),
// so the walk reads them as imports of the guard that loads them.
const COMPUTED: Record<string, string[]> = {
  "kherep-maestro/codex-privacy-boundary-guard.mts": ["workspace-scope", "private-path-policy", "private-path-rules", "real-path-policy"],
  "kherep-maestro/codex-dispatch-contract-guard.mts": ["obs-brief-policy"],
};
export const ALWAYS_CHECK = Object.values(COMPUTED).flat().map((name) => `./lib/${name}.mts`);
const computedImports = (rel: string): string => (COMPUTED[rel] || []).map((name) => `\nimport "./lib/${name}.mts";`).join("");
const RENDERED = new Set(["kherep-maestro/codex-observation-stop.mts", "kherep-maestro/codex-observation-turn-completion.mts"]);
// Copied from codex/hooks under their own name; every other plain name is a shared Claude guard.
const CODEX_HELPERS = new Set(["acceptance-policy.mts", "obs-candidate-policy.mts", "research-common.mts", "research-exec-parser.mts",
  "research-transcript.mts"]);
const DELIVER_HOOK = "/modules/control-plane/node/deliver-hook.mts";

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code || "unknown";
// The bytes, or the error code that stopped the read.
function read(file: string | number): Buffer | string {
  try { return fs.readFileSync(file); } catch (error) { return errorCode(error); }
}
// Filled by loadLibs. A restore needs only the first RESTORE_LIBS of its steps.
export const lib = {} as Libs;
const RESTORE_LIBS = 3;
const LIB_DIR = fs.existsSync(path.join(import.meta.dirname, "lib"))
  ? path.join(import.meta.dirname, "lib") : path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "lib");

// Dependency order, so a broken lib is named before the libs importing it.
export async function loadLibs(): Promise<LoadFailure | null> {
  const steps: [string, string[]][] = [
    ["workspace-scope.mts", ["isWithinPath", "joinPathLike", "normalizePathLike"]], ["orchestra-checkout.mts", ["checkoutFor", "isCheckout"]],
    ["restore-write.mts", ["writeExact"]], ["hook-inventory.mts", ["hookInventory"]], ["hook-syntax.mts", ["syntaxVerdict"]],
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

// The checkout the deliver-hook command runs from, else the Claude-side chain.
export function checkoutOf(parts: string[], payload: ScopePayload | null, env: NodeJS.ProcessEnv = process.env): string {
  const deliver = parts.map(lib.normalizePathLike).find((part) => part.toLowerCase().endsWith(DELIVER_HOOK));
  const root = deliver ? deliver.slice(0, -DELIVER_HOOK.length) : "";
  if (lib.isCheckout(root)) return root;
  return lib.checkoutFor(payload, lib.normalizePathLike(env.CLAUDE_HOME || path.join(os.homedir(), ".claude")), env);
}

// `kind` only words the absent case: "wired but" or "imported but" not present.
async function classify(file: string, kind: string): Promise<Verdict> {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? { state: "DEFEKT", reason: `${kind} but not present on disk` } : { state: "UNGEPRUEFT", reason: `stat failed (${code})` };
  }
  // A directory reports size 0 on Windows; it is not the 0-byte incident.
  if (!stat.isFile()) return { state: "UNGEPRUEFT", reason: "not a regular file" };
  const before = { size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), ino: stat.ino };
  if (stat.size === 0) return { state: "DEFEKT", reason: "0 bytes - it runs, enforces nothing and exits 0 (fail-open)", before };
  const source = read(file);
  if (typeof source === "string") return { state: "UNGEPRUEFT", reason: `unreadable (${source})`, before };
  const verdict = await lib.syntaxVerdict(file, source.toString("utf8"));
  if (verdict.state === "OK") return { state: "OK", before };
  return { state: verdict.state, reason: verdict.state === "DEFEKT" ? verdict.detail : `syntax unchecked (${verdict.detail})`, before };
}

function restore(file: string, from: string, repoRoot: string, hooksDir: string): Restored {
  if (!repoRoot) return { proven: false, why: "no checkout resolved via the deliver-hook command, workspace, KHEREP_WORKSPACE or install note" };
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
  const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : "";
  const additionalContext = `KHEREP CODEX HOOK-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`;
  process.stdout.write(JSON.stringify({ systemMessage: `Kherep hook integrity: ${lines[0]}${more}`,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
}

const outcome = (result: Restored): string => result.proven
  ? `RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)})`
  : `NOT restored (${result.why}). ENFORCEMENT IS OFF for this hook`;

// This hook without one of its libs: one line, journalled as kind "self". The
// lib is restored only when the libs the restore needs loaded.
function ownImportFailed({ rel, why, loaded }: LoadFailure, payload: ScopePayload | null, home: string, parts: string[]): void {
  const file = path.join(LIB_DIR, path.basename(rel)).replace(/\\/g, "/");
  const result: Restored = loaded >= RESTORE_LIBS
    ? restore(file, `claude/hooks/${rel}`, checkoutOf(parts, payload), `${lib.normalizePathLike(home)}/hooks`)
    : { proven: false, why: "the restore itself needs workspace-scope, orchestra-checkout and restore-write" };
  journal(home, {
    ts: new Date().toISOString(), file: `kherep-maestro/${rel}`, path: file, state: "DEFEKT", reason: why, kind: "self",
    importedBy: [SELF], sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why,
  });
  emit([`own import ${rel} cannot be loaded (${why}); nothing was verified this session -> ${outcome(result)}`]);
}

// The install this file belongs to; run from anywhere else, CODEX_HOME or ~/.codex.
function codexHome(): string {
  const dir = import.meta.dirname;
  if (path.basename(dir) === "kherep-maestro" && path.basename(path.dirname(dir)) === "hooks") return path.dirname(path.dirname(dir));
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

async function main(): Promise<void> {
  let payload: ScopePayload | null = {};
  try { payload = JSON.parse(String(read(0)) || "{}") as ScopePayload | null; } catch { /* no payload: no cwd */ }
  const home = codexHome();
  const config = read(path.join(home, "config.toml"));
  const parts = typeof config === "string" ? [] : hookCommandParts(config.toString("utf8"));
  const failed = await loadLibs();
  if (failed) return ownImportFailed(failed, payload, home, parts);
  if (typeof config === "string") return emit([`config.toml under ${home} unreadable (${config}), so WHICH hooks are wired is UNKNOWN here`]);
  const hooksDir = `${lib.normalizePathLike(home)}/hooks`;
  const repoRoot = checkoutOf(parts, payload);
  const wired = wiredHookFiles(parts, hooksDir);
  const lines = wired.length ? [] : [`no hook file under ${hooksDir} is wired in config.toml, so WHICH hooks run is UNKNOWN here`];
  // The live file, else the versioned one, so one broken file does not hide the files behind it.
  const readSource = (file: string, rel: string): string | null => {
    const source = sourceOf(rel);
    const text = [file, repoRoot && "from" in source ? lib.joinPathLike(repoRoot, source.from) : ""]
      .map((candidate) => (candidate ? read(candidate) : "")).find((bytes) => typeof bytes !== "string" && bytes.length)?.toString("utf8");
    return COMPUTED[rel] ? `${text || ""}${computedImports(rel)}` : text || null;
  };

  for (const { file, rel, wired: isWired, importedBy } of lib.hookInventory(wired, hooksDir, readSource)) {
    const { state, reason, before = {} } = await classify(file, isWired ? "wired" : "imported");
    if (state === "OK") continue;
    const label = importedBy.length ? `${rel} (imported by ${importedBy.join(", ")})` : rel;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(), file: rel, path: file, state, reason, kind: isWired ? "wired" : "import", importedBy,
      sizeBefore: before.size ?? null, mtimeBefore: before.mtime || null, inoBefore: before.ino ?? null,
      sha256After: null, restoreProven: false,
    };
    const source = sourceOf(rel);
    if (state === "UNGEPRUEFT") {
      lines.push(`${label}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
    } else if ("hint" in source) {
      entry.restoreDetail = source.hint;
      lines.push(`${label}: ${reason} -> NOT restored, report only (${source.hint}). ENFORCEMENT IS OFF for this hook.`);
    } else {
      const result = restore(file, source.from, repoRoot, hooksDir);
      Object.assign(entry, { sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why });
      lines.push(`${label}: ${reason} -> ${outcome(result)}`);
    }
    journal(home, entry);
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

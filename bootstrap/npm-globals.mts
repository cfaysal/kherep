#!/usr/bin/env node
// Idempotent npm global reconciliation for bootstrap/install.sh (OP-1085).
// Manifest lines are `name` or `name@version`. Unpinned entries are installed
// only when missing: a bare `npm i -g <name>` silently upgraded pinned tools
// on every run. Child processes always use argv form.
// Several manifests may be given; a later one overrides by package name, and a
// `?` prefix marks a manifest optional (OP-1087).
// Manifest reading and per-host merging live in ./npm-globals-manifest.mts (OP-1087).

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { productEnv } from "../lib/product-env.mts";
import { GlobalsError, fail, mergeManifests, safeString, type MergedEntry } from "./npm-globals-manifest.mts";
import { isArgvList, isRecord } from "./shape.mts";

const MAX_OUTPUT = 16 * 1024 * 1024;
const WIN = process.platform === "win32";

interface NpmCommand {
  executable: string;
  prefixArgs: string[];
}

interface NpmResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

type SkipItem = MergedEntry & { action: "skip"; reason: string };
type InstallItem = MergedEntry & { action: "install"; reason: string; spec: string };
type PlanItem = SkipItem | InstallItem;

const pathDirs = (env: NodeJS.ProcessEnv): string[] => String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Windows resolves `npm` on PATH to `npm.cmd`, and Node refuses to spawn a
// .cmd without a shell (CVE-2024-27980). `shell: true` was rejected: it would
// push every package spec through cmd.exe quoting. npm's own entry script run
// by THIS node keeps the call pure argv with no shell anywhere.
function getNpmCommand(env: NodeJS.ProcessEnv): NpmCommand {
  const executable = productEnv(env, "NPM_BIN");
  if (executable !== undefined) {
    if (!safeString(executable)) fail("invalid npm executable configuration");
    let prefixArgs: unknown = [];
    try {
      const rawArgs = productEnv(env, "NPM_BIN_ARGS_JSON");
      if (rawArgs !== undefined) prefixArgs = JSON.parse(rawArgs);
    } catch { prefixArgs = null; /* fail-closed via the shape check below */ }
    if (!isArgvList(prefixArgs)) fail("invalid npm executable argument configuration");
    return { executable, prefixArgs };
  }
  if (!WIN) return { executable: "npm", prefixArgs: [] };
  for (const dir of [path.dirname(process.execPath), ...pathDirs(env)]) {
    const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    if (isFile(cli)) return { executable: process.execPath, prefixArgs: [cli] };
  }
  return fail("npm entry script not found (npm-cli.js); set KHEREP_NPM_BIN");
}

function runNpm(command: NpmCommand, args: string[], capture: boolean): NpmResult {
  try {
    const out = childProcess.execFileSync(command.executable, [...command.prefixArgs, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
      shell: false,
      stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"],
      windowsHide: true,
    });
    return { ok: true, stdout: capture ? out : "", stderr: "" };
  } catch (error) {
    const failed = isRecord(error) ? error : {};
    return {
      ok: false,
      stdout: capture && typeof failed.stdout === "string" ? failed.stdout : "",
      stderr: typeof failed.stderr === "string" ? failed.stderr : "",
    };
  }
}

// `npm ls -g` exits nonzero on unrelated extraneous/invalid globals but still
// prints the tree, so the parsed payload decides, not the exit code.
function readInstalled(command: NpmCommand): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runNpm(command, ["ls", "-g", "--depth=0", "--json"], true).stdout);
  } catch {
    fail("npm ls -g returned malformed JSON");
  }
  const deps = isRecord(parsed) ? parsed.dependencies : null;
  const map = new Map<string, string>();
  if (isRecord(deps)) {
    for (const [name, info] of Object.entries(deps)) {
      map.set(name, isRecord(info) && typeof info.version === "string" ? info.version : "");
    }
  }
  return map;
}

// Bare-name heuristic: `@scope/name` -> `name`. A hit only ever turns an
// install into a skip, so a miss costs nothing while a hit avoids the EEXIST
// that aborted the whole install on the Mac (Homebrew bun, 2026-09-02).
// Deliberately NO exclusion of npm's own bin directory: this runs only for
// packages npm does not track, and with Homebrew-installed Node `npm prefix -g`
// IS /opt/homebrew, the directory Homebrew links its own binaries into. An
// exclusion there would hide exactly the bun that caused OP-1085 (Review).
function findForeignBinary(name: string, env: NodeJS.ProcessEnv): string {
  const base = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  const exts = WIN
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).concat("")
    : [""];
  for (const dir of pathDirs(env)) {
    const resolved = path.resolve(dir);
    for (const ext of exts) {
      const candidate = path.join(resolved, base + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return "";
}

function planEntry(entry: MergedEntry, installed: Map<string, string>, env: NodeJS.ProcessEnv): PlanItem {
  const current = installed.get(entry.name);
  const pinned = entry.pin ? `${entry.name}@${entry.pin}` : entry.name;
  if (current === undefined) {
    const foreign = findForeignBinary(entry.name, env);
    return foreign
      ? { ...entry, action: "skip", reason: `present outside npm (${foreign})` }
      : { ...entry, action: "install", spec: pinned, reason: "not installed" };
  }
  if (!entry.pin) {
    return productEnv(env, "INSTALL_UPGRADE_GLOBALS") === "1"
      ? { ...entry, action: "install", spec: entry.name, reason: "upgrade requested (latest)" }
      : { ...entry, action: "skip", reason: `unpinned, ${current || "unknown"} installed (no silent upgrade)` };
  }
  if (current === entry.pin) return { ...entry, action: "skip", reason: `pinned ${entry.pin} already installed` };
  const direction = current && current < entry.pin ? "upgrade" : "downgrade";
  const found = `found ${current || "unknown"} (${direction} to pin)`;
  return { ...entry, action: "install", spec: pinned, reason: `pinned ${entry.pin}, ${found}` };
}

export function run(manifestPaths: string[], planOnly: boolean, env: NodeJS.ProcessEnv): number {
  const entries = mergeManifests(manifestPaths);
  const command = getNpmCommand(env);
  const installed = readInstalled(command);
  const plan = entries.map((entry) => planEntry(entry, installed, env));
  for (const item of plan) {
    const suffix = item.override ? ` (override from ${item.override})` : "";
    process.stdout.write(`npm-globals: ${item.name} ${item.action} (${item.reason})${suffix}\n`);
  }
  const wanted = plan.filter((item): item is InstallItem => item.action === "install");
  if (planOnly) {
    process.stdout.write(`npm-globals: plan-only ${plan.length} entries, ${wanted.length} would install\n`);
    return 0;
  }
  // One failing package must not hide the rest: every entry is attempted and
  // the nonzero exit is reported once, at the end.
  let failures = 0;
  for (const item of wanted) {
    const result = runNpm(command, ["i", "-g", item.spec], false);
    if (result.ok) continue;
    failures += 1;
    // npm schreibt die Ursache (EEXIST, EACCES, Netz) nach stderr; ohne sie ist
    // "FAILED" fuer den Operator wertlos (Review OP-1085). Erste Zeile, gedeckelt.
    const why = result.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
    const detail = why ? `: ${why.slice(0, 200)}` : "";
    process.stdout.write(`npm-globals: ${item.name} FAILED (npm i -g ${item.spec})${detail}\n`);
  }
  process.stdout.write(`npm-globals: ${plan.length} entries, ${wanted.length - failures} installed, ` +
    `${plan.length - wanted.length} skipped, ${failures} failed\n`);
  return failures > 0 ? 1 : 0;
}

function cli(argv: string[], env: NodeJS.ProcessEnv): number {
  const planOnly = argv.includes("--plan-only");
  const args = argv.filter((value) => value !== "--plan-only");
  if (args.length === 0) fail("usage: npm-globals.mts <manifest> [<override>|?<override> ...] [--plan-only]");
  return run(args, planOnly, env);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) only matches after realpath.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = cli(process.argv.slice(2), process.env);
  } catch (error) {
    const message = error instanceof GlobalsError ? error.message : "unexpected internal error";
    process.stderr.write(`npm-globals: FATAL: ${message}\n`);
    process.exitCode = 1;
  }
}

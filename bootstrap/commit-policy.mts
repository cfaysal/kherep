#!/usr/bin/env node
/**
 * commit-policy.mts  -  called by bootstrap/install.sh and bootstrap/drift-check.sh
 *
 * OP-1426. Renders the commit-policy file that claude/kherep/githooks/commit-msg
 * reads next to itself, so the work-item rule binds every runtime (PowerShell,
 * Codex, IDE, terminal) and not only a process that carries the KHEREP_* variables.
 *
 * Format: LF-terminated `key=value` lines, read literally by POSIX sh (no eval).
 *   workspace=<canonical workspace path, forward slashes>
 *   work_item_required=0|1
 *   work_item_pattern=<extended regex>   (only when configured)
 *
 * Precedence per value: a non-empty install-time environment variable
 * (KHEREP_WORK_ITEM_REQUIRED / KHEREP_WORK_ITEM_PATTERN), else the value in the
 * existing live file, else the product default (required=0, no pattern). Keeping
 * the live value means a later install from a shell without the variables does
 * not silently switch enforcement off. The workspace always comes from the
 * installer. An existing file that does not parse is replaced by the defaults.
 *
 * Usage: node commit-policy.mts render <workspace> <existing-file> <out-file>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface CommitPolicy { workspace: string; required: "0" | "1"; pattern: string }
type Existing = Partial<Pick<CommitPolicy, "required" | "pattern">>;

// Mirrors read_policy in the hook: unknown keys, lines without "=" and a
// required value other than 0/1 make the whole file invalid.
export function parsePolicy(text: string): Existing | null {
  const out: Existing = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 0) return null;
    const key = line.slice(0, at), value = line.slice(at + 1);
    if (key === "workspace") continue;
    if (key === "work_item_required") {
      if (value !== "0" && value !== "1") return null;
      out.required = value;
    } else if (key === "work_item_pattern") out.pattern = value;
    else return null;
  }
  return out;
}

export function renderPolicy(policy: CommitPolicy): string {
  const lines = [
    "# Kherep commit policy (OP-1426). Managed by bootstrap/install.sh; do not edit.",
    "# Change it by re-running the installer with KHEREP_WORK_ITEM_REQUIRED / KHEREP_WORK_ITEM_PATTERN.",
    `workspace=${policy.workspace}`,
    `work_item_required=${policy.required}`,
  ];
  if (policy.pattern) lines.push(`work_item_pattern=${policy.pattern}`);
  return `${lines.join("\n")}\n`;
}

export function resolvePolicy(workspace: string, existing: Existing | null, env: NodeJS.ProcessEnv): CommitPolicy {
  const required = env.KHEREP_WORK_ITEM_REQUIRED || existing?.required || "0";
  if (required !== "0" && required !== "1") throw new Error(`KHEREP_WORK_ITEM_REQUIRED must be 0 or 1, got '${required}'`);
  const pattern = env.KHEREP_WORK_ITEM_PATTERN || existing?.pattern || "";
  let resolved = path.resolve(workspace);
  try { resolved = fs.realpathSync(resolved); } catch { /* not created yet: the hook canonicalizes again */ }
  const canonical = resolved.replace(/\\/g, "/");
  for (const [name, value] of [["workspace", canonical], ["KHEREP_WORK_ITEM_PATTERN", pattern]]) {
    if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain a line break`);
  }
  return { workspace: canonical, required, pattern };
}

function main(argv: string[]): void {
  const [command, workspace, existingFile, outFile] = argv;
  if (command !== "render" || !workspace || !existingFile || !outFile) {
    throw new Error("usage: render <workspace> <existing-file> <out-file>");
  }
  let existing: Existing | null = null;
  if (fs.existsSync(existingFile)) {
    existing = parsePolicy(fs.readFileSync(existingFile, "utf8"));
    if (!existing) console.error(`commit-policy: existing ${existingFile} is malformed and is replaced by the defaults`);
  }
  fs.writeFileSync(outFile, renderPolicy(resolvePolicy(workspace, existing, process.env)));
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`commit-policy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

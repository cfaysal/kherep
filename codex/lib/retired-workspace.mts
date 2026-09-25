import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { InstallTransaction } from "./install-transaction.mts";

// #44. The Codex half of bootstrap/install-retired.sh. Both installers read the
// one declaration bootstrap/manifest/retired.txt in the same line format, and
// the whole manifest is refused before anything moves when one line is invalid.
// Codex places nothing in the Claude home, so it retires only the project/
// entries, which name files in the workspace.
//
// A project/ entry is gated (#45): the workspace belongs to the operator, so a
// file is parked only while its content, with CRLF folded to LF, still hashes to
// one of the versions the installer placed. Anything else is kept in place and
// reported as KEEP, without backup, and the install goes on.

export interface RetiredWorkspaceEntry {
  entry: string;
  relative: string;
  hashes: string[];
}

const PROJECT_PREFIX = "project/";
const HASHES = /^sha256:[0-9a-f]{64}(,[0-9a-f]{64})*$/;

// Same rule as kherep_validate_manifest_relative_path in bootstrap/profile.sh.
function strictRelative(value: string): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

export function parseRetiredManifest(text: string): RetiredWorkspaceEntry[] {
  const entries: RetiredWorkspaceEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith("#")) continue;
    const space = line.indexOf(" ");
    const entry = space < 0 ? line : line.slice(0, space);
    const hashes = space < 0 ? "" : line.slice(space + 1);
    if (!strictRelative(entry)) {
      throw new Error(`retirement manifest entry must be a strict traversal-free relative path: ${entry}`);
    }
    if (!entry.startsWith(PROJECT_PREFIX)) {
      if (hashes) throw new Error(`retirement manifest entry ${entry} is a Claude-home entry and takes no hashes`);
      continue;
    }
    if (!HASHES.test(hashes)) {
      throw new Error(`retirement manifest entry ${entry} needs 'sha256:<hex>[,<hex>...]' of every version the installer placed`);
    }
    entries.push({
      entry,
      relative: entry.slice(PROJECT_PREFIX.length),
      hashes: hashes.slice("sha256:".length).split(","),
    });
  }
  return entries;
}

export function readRetiredWorkspaceEntries(manifest: string): RetiredWorkspaceEntry[] {
  if (!fs.existsSync(manifest)) throw new Error(`retirement manifest missing: ${manifest}`);
  return parseRetiredManifest(fs.readFileSync(manifest, "utf8"));
}

// SHA-256 of the file with CRLF folded to LF, byte for byte as the bash side.
export function foldedSha256(file: string): string {
  const folded = fs.readFileSync(file).toString("latin1").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(folded, "latin1").digest("hex");
}

export function retireWorkspaceEntries(
  entries: RetiredWorkspaceEntry[],
  workspace: string,
  transaction: InstallTransaction,
  log: (line: string) => void,
): void {
  for (const { entry, relative, hashes } of entries) {
    const live = path.join(workspace, ...relative.split("/"));
    const stat = fs.lstatSync(live, { throwIfNoEntry: false });
    if (!stat) {
      log(`retire: SKIP ${entry} (nothing at ${live})`);
      continue;
    }
    if (!stat.isFile() || !hashes.includes(foldedSha256(live))) {
      log(`retire: KEEP ${entry} (content not placed by the installer)`);
      continue;
    }
    log(`retire: ${entry} -> ${transaction.park(live)}`);
  }
}

#!/usr/bin/env node
// PostToolUse hook: surfaces a warning when an Edit/Write produces a code file >250 LOC.
// Soft warning within the configured workspace; never blocks.

import fs from "node:fs";
import path from "node:path";
import { configuredWorkspace, isWithinPath } from "./lib/workspace-scope.mts";

const CODE_EXT = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|java|go|rs|rb|php|cs|kt|swift|scala|c|cc|cpp|h|hpp)$/i;
const SKIP_DIRS = /(?:^|[\\/])(?:node_modules|dist|build|target|\.next|\.nuxt|out|coverage|_deprecated)[\\/]/;
const LIMIT = 250;
const TOOLS = ["Edit", "Write", "MultiEdit"];

// The two fields this hook reads. The rest of a PostToolUse payload stays
// unread and is therefore not typed here.
interface WatchPayload {
  tool_name?: unknown;
  tool_input?: { file_path?: unknown } | null;
}

function finding(payload: WatchPayload | null): string | null {
  if (!payload || !TOOLS.includes(String(payload.tool_name))) return null;
  const filePath = typeof payload.tool_input?.file_path === "string" ? payload.tool_input.file_path : "";
  if (!filePath) return null;
  if (!CODE_EXT.test(filePath)) return null;
  if (SKIP_DIRS.test(filePath)) return null;

  // Only flag files inside the configured workspace.
  if (!isWithinPath(filePath, configuredWorkspace())) return null;

  let loc: number;
  try {
    loc = fs.readFileSync(filePath, "utf8").split("\n").length;
  } catch {
    return null;
  }
  if (loc <= LIMIT) return null;

  return `[loc-watch] ${path.basename(filePath)} now at ${loc} LOC (limit ${LIMIT}). `
    + "Project rule: split candidates above 250 LOC. Consider extracting modules.\n";
}

function main(): void {
  try {
    const message = finding(JSON.parse(fs.readFileSync(0, "utf8")) as WatchPayload | null);
    if (message) process.stdout.write(message);
  } catch {
    // Fail-open, like every nudge in this directory: a hook that cannot answer
    // says nothing and exits 0 rather than putting a stack trace in the session.
  }
}

if (import.meta.main) main();

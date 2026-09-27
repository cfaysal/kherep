import path from "node:path";

import { configRoot, nodePaths } from "../../modules/control-plane/node/config.mts";

// Issue #72. The Control Plane outbox becomes an extra writable root of the
// Codex workspace-write sandbox, so the first `msg send` of a Codex session
// writes its outbox record without an escalated retry. The configuration
// reference documents `sandbox_workspace_write.writable_roots` (array<string>)
// as "Additional writable roots when `sandbox_mode = "workspace-write"`"
// (developers.openai.com/codex/config-reference). Only the outbox is added,
// never the node directory with its key and policy.
//
// TOML allows one definition of a table. Where it lives:
// - The operator defines none: the managed block carries the table and owns it.
// - The operator has `[sandbox_workspace_write]` or top-level dotted
//   `sandbox_workspace_write.*` keys: the managed block carries no table, and
//   the outbox is merged into the operator's `writable_roots` (appended when
//   missing, the key added when absent). Operator entries are never removed.
// - Anything that cannot be merged without rewriting operator text (an inline
//   table, a value this scanner does not understand) or `default_permissions`,
//   which the reference says not to combine with `[sandbox_workspace_write]`:
//   nothing is written, and the status says why.

export type OutboxRootStatus =
  | "managed" | "operator-merged" | "operator-present"
  | "skipped-default-permissions" | "skipped-inline-table" | "skipped-unparseable";

export interface OutboxRootResult {
  config: string;
  status: OutboxRootStatus;
  // true when the managed block has to carry the table.
  managedTable: boolean;
}

const KEY = `["']?sandbox_workspace_write["']?`;
const ROOTS = `["']?writable_roots["']?`;
const TABLE_HEADER = new RegExp(`^[ \\t]*\\[[ \\t]*${KEY}[ \\t]*\\][ \\t]*(?:#.*)?$`, "m");
const ANY_HEADER = /^[ \t]*\[/m;

export function controlPlaneOutbox(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  return nodePaths(configRoot(env, platform as NodeJS.Platform)).outbox;
}

export function renderOutboxWritableRoot(outbox: string): string {
  return `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(outbox)}]`;
}

// The outbox a block written by renderOutboxWritableRoot names, so a block from
// an install with another config directory is still recognised as managed.
export function managedOutboxRoots(config: string, startMarker: string, endMarker: string): string[] {
  const start = config.indexOf(startMarker);
  const end = config.indexOf(endMarker);
  if (start < 0 || end < start) return [];
  const pattern = /^\[sandbox_workspace_write\]\r?\nwritable_roots = \[("(?:[^"\\\r\n]|\\.)*")\]$/gm;
  return [...config.slice(start, end).matchAll(pattern)].flatMap((match) => {
    try { return [JSON.parse(match[1]) as string]; } catch { return []; }
  });
}

interface ArrayScan { values: string[]; insertAt: number; trailingComma: boolean }

// Scans a TOML array of strings that starts at `from` (after the `=`). Returns
// null for anything else, so the caller leaves the text alone.
export function scanStringArray(text: string, from: number): ArrayScan | null {
  let index = from;
  while (text[index] === " " || text[index] === "\t") index += 1;
  if (text[index] !== "[") return null;
  let insertAt = index + 1;
  let trailingComma = false;
  const values: string[] = [];
  index += 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "]") return { values, insertAt, trailingComma };
    if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === ",") {
      if (values.length === 0 || trailingComma) return null;
      trailingComma = true;
      insertAt = index + 1;
      index += 1;
    } else if (char === '"' || char === "'") {
      if (text.startsWith(char.repeat(3), index) || (values.length > 0 && !trailingComma)) return null;
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") end += char === '"' && text[end] === "\\" ? 2 : 1;
      if (text[end] !== char) return null;
      const raw = text.slice(index + 1, end);
      let value = raw;
      if (char === '"') {
        try { value = JSON.parse(`"${raw}"`) as string; } catch { /* kept raw; it then matches nothing */ }
      }
      values.push(value);
      trailingComma = false;
      insertAt = end + 1;
      index = end + 1;
    } else if (/\s/.test(char)) {
      index += 1;
    } else {
      return null;
    }
  }
  return null;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

type Merge = { text: string; status: "operator-merged" | "operator-present" } | null;

// Adds the outbox to the array whose value starts at `valueStart`.
function mergeInto(text: string, valueStart: number, outbox: string): Merge {
  const scan = scanStringArray(text, valueStart);
  if (!scan) return null;
  if (scan.values.some((value) => samePath(value, outbox))) return { text, status: "operator-present" };
  const entry = JSON.stringify(outbox);
  let insert = `, ${entry}`;
  if (scan.values.length === 0) insert = entry;
  else if (scan.trailingComma) insert = ` ${entry},`;
  return { text: text.slice(0, scan.insertAt) + insert + text.slice(scan.insertAt), status: "operator-merged" };
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// The text before the first table header, where top-level keys live.
function topLevelHead(text: string): string {
  const firstHeader = text.search(ANY_HEADER);
  return firstHeader < 0 ? text : text.slice(0, firstHeader);
}

// One operator segment (the text before or after the managed block).
function mergeSegment(segment: string, outbox: string, topLevel: boolean): Merge | "none" | "inline" {
  const newline = newlineOf(segment);
  if (topLevel) {
    const head = topLevelHead(segment);
    if (new RegExp(`^[ \\t]*${KEY}[ \\t]*=`, "m").test(head)) return "inline";
    const dotted = new RegExp(`^[ \\t]*${KEY}[ \\t]*\\.[ \\t]*${ROOTS}[ \\t]*=`, "m").exec(head);
    if (dotted) return mergeInto(segment, dotted.index + dotted[0].length, outbox);
    const anyDotted = new RegExp(`^[ \\t]*${KEY}[ \\t]*\\.`, "m").exec(head);
    if (anyDotted) {
      const line = `sandbox_workspace_write.writable_roots = [${JSON.stringify(outbox)}]${newline}`;
      return { text: segment.slice(0, anyDotted.index) + line + segment.slice(anyDotted.index), status: "operator-merged" };
    }
  }
  const header = TABLE_HEADER.exec(segment);
  if (!header) return "none";
  const headerLineEnd = segment.indexOf("\n", header.index);
  const bodyStart = headerLineEnd < 0 ? segment.length : headerLineEnd + 1;
  const nextHeader = segment.slice(bodyStart).search(ANY_HEADER);
  const bodyEnd = nextHeader < 0 ? segment.length : bodyStart + nextHeader;
  const roots = new RegExp(`^[ \\t]*${ROOTS}[ \\t]*=`, "m").exec(segment.slice(bodyStart, bodyEnd));
  if (roots) return mergeInto(segment, bodyStart + roots.index + roots[0].length, outbox);
  const prefix = bodyStart === segment.length && !segment.endsWith("\n") ? newline : "";
  const line = `${prefix}writable_roots = [${JSON.stringify(outbox)}]${newline}`;
  return { text: segment.slice(0, bodyStart) + line + segment.slice(bodyStart), status: "operator-merged" };
}

export function projectOutboxWritableRoot(
  config: string, outbox: string, startMarker: string, endMarker: string,
): OutboxRootResult {
  const start = config.indexOf(startMarker);
  const end = config.indexOf(endMarker);
  const managed = start >= 0 && end > start;
  const before = managed ? config.slice(0, start) : config;
  const block = managed ? config.slice(start, end + endMarker.length) : "";
  const after = managed ? config.slice(end + endMarker.length) : "";
  const skip = (status: OutboxRootStatus): OutboxRootResult => ({ config, status, managedTable: false });

  const head = topLevelHead(before);
  if (/^[ \t]*["']?default_permissions["']?[ \t]*=/m.test(head)) return skip("skipped-default-permissions");

  const segments: Array<[string, boolean]> = [[before, true], [after, false]];
  for (const [index, [segment, topLevel]] of segments.entries()) {
    const merged = mergeSegment(segment, outbox, topLevel);
    if (merged === "none") continue;
    if (merged === "inline") return skip("skipped-inline-table");
    if (merged === null) return skip("skipped-unparseable");
    const next = index === 0 ? merged.text + block + after : before + block + merged.text;
    return { config: next, status: merged.status, managedTable: false };
  }
  return { config, status: "managed", managedTable: true };
}

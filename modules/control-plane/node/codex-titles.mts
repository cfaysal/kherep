import fs from "node:fs";
import path from "node:path";

import { isTitle, MAX_TITLE_CHARS, type SessionInfo } from "../protocol.mts";
import { CODEX_RUNTIME } from "./codex-sessions.mts";

// Codex thread titles (issue #88). The Codex app shows threads only by title;
// <codex home>/session_index.jsonl holds one JSON line per thread with id,
// thread_name and updated_at (measured with Codex app 0.158 alpha). Only those
// three keys are read, nothing else of the Codex history. The read is bounded
// and fail-soft: a missing, unreadable or garbled index gives no titles.

export const CODEX_INDEX = "session_index.jsonl";
// Only the end of a larger index is read; the latest entries are appended there.
export const INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const INDEX_MAX_LINES = 20_000;

// Control, format and separator characters removed, whitespace collapsed,
// trimmed and cut to MAX_TITLE_CHARS; nothing left is no title.
export function sanitiseTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ +/g, " ").trim();
  const chars = [...clean];
  const title = chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join("").trimEnd()}…` : clean;
  return isTitle(title) ? title : undefined;
}

function readTail(file: string, maxBytes: number): string {
  // Only a regular file is opened: a pipe in its place would block the read.
  if (!fs.statSync(file).isFile()) throw new Error("not a file");
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.subarray(0, read).toString("utf8");
    // A cut start is a partial line.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Thread id to title; the entry with the latest updated_at wins, and of equal
// times the later line.
export function readCodexTitles(codexHome: string, limits: { maxBytes?: number; maxLines?: number } = {}): Map<string, string> {
  const titles = new Map<string, string>();
  let text: string;
  try {
    text = readTail(path.join(codexHome, CODEX_INDEX), limits.maxBytes ?? INDEX_MAX_BYTES);
  } catch {
    return titles;
  }
  const times = new Map<string, number>();
  for (const line of text.split("\n").slice(-(limits.maxLines ?? INDEX_MAX_LINES))) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { id, thread_name: name, updated_at: at } = entry as Record<string, unknown>;
    const title = sanitiseTitle(name);
    if (typeof id !== "string" || id.length === 0 || id.length > 128 || !title) continue;
    const time = (typeof at === "string" && Date.parse(at)) || 0;
    if (time < (times.get(id) ?? -Infinity)) continue;
    times.set(id, time);
    titles.set(id, title);
  }
  return titles;
}

// Codex sessions with a known thread title carry it; others are unchanged.
export function withCodexTitles(sessions: SessionInfo[], titles: Map<string, string>): SessionInfo[] {
  return sessions.map((s) => {
    const title = s.runtime === CODEX_RUNTIME ? titles.get(s.sessionId) : undefined;
    return title ? { ...s, title } : s;
  });
}

import fs from "node:fs";

import type { CodexFiles } from "./codex-process.mts";
import { readJson } from "./inbox.mts";

// What a Codex task run left in its files (issue #63): the `--json` events,
// how the process ended, the last agent message and the last stderr line.

export interface CodexEvents { threadId?: string; completed: boolean; error?: string }

// Reads the events file; a line that is not JSON (a partial last line) is skipped.
export function readEvents(files: CodexFiles): CodexEvents {
  let text: string;
  try {
    text = fs.readFileSync(files.events, "utf8");
  } catch {
    return { completed: false };
  }
  const result: CodexEvents = { completed: false };
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string" && !result.threadId) result.threadId = event.thread_id;
    if (event.type === "turn.completed") result.completed = true;
    const failure = failureOf(event);
    if (typeof failure === "string") result.error = failure;
  }
  return result;
}

// The message of a turn.failed or error event.
function failureOf(event: Record<string, unknown>): unknown {
  if (event.type === "turn.failed") return (event.error as { message?: unknown } | undefined)?.message;
  if (event.type === "error") return event.message;
  return undefined;
}

export interface CodexExit { code: number | null; signal: string | null }
export const readExit = (files: CodexFiles): CodexExit | null => {
  try {
    return readJson<CodexExit>(files.exit);
  } catch {
    return null;
  }
};

export function readLastMessage(files: CodexFiles): string {
  try {
    return fs.readFileSync(files.lastMessage, "utf8").trim();
  } catch {
    return "";
  }
}

// The last non-empty stderr line, for a failure reason: API keys redacted,
// control characters removed, at most 200 characters. The prompt goes in on
// stdin, and a line that quotes the framing (it names Kherep) is dropped.
export function lastStderrLine(files: CodexFiles): string {
  let text: string;
  try {
    text = fs.readFileSync(files.stderr, "utf8").slice(-65_536);
  } catch {
    return "";
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (line.includes("Kherep")) return "";
  return line.replace(/sk-[A-Za-z0-9_*-]+/g, "sk-<redacted>").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

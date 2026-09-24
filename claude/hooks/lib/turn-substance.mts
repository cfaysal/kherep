// One definition of "substantial", shared by the Stop hooks that judge a turn:
// maestro-banner-gate.js and observation-stop.mts. Two copies would drift, and
// the banner and the observation dispatch would then start firing on different
// turns for no reason anyone decided.
//
// Where the ending turn starts is a parameter of endingTurn(): the banner gate
// keeps isUserPrompt below unchanged, the observation hook passes a stricter
// boundary of its own.
//
// Pure-regex, no model call. Everything here reads a Claude Code transcript
// JSONL: one entry per line, each with an optional { role, content } message.

import fs from "node:fs";

export interface TranscriptMessage {
  role?: unknown;
  content?: unknown;
}

export interface TranscriptEntry {
  message?: TranscriptMessage | null;
  [key: string]: unknown;
}

export interface ContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: { command?: unknown; [key: string]: unknown } | null;
}

// A turn below this many characters of assistant prose is treated as trivial
// when it also stays below the tool thresholds.
const SUBSTANTIAL_CHARS = 400;
const SUBSTANTIAL_TOOL_CALLS = 3;
const READ_ONLY_TOOLS = new Set(["Glob", "Grep", "Read"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const READ_ONLY_SHELL_COMMAND =
  /^\s*(?:pwd|ls\b|dir\b|cat\b|head\b|tail\b|rg\b|grep\b|Get-(?:ChildItem|Content|Item|Process)\b|Select-String\b|Test-Path\b|git\s+(?:status\b|diff\b|log\b|show\b|rev-parse\b|branch\s+(?:--show-current|--list)\b))[^;\r\n&|<>`]*$/i;

// Null means unreadable, and every caller treats that as undecidable: fail open.
export function readTranscript(transcriptPath: string): TranscriptEntry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A half-written last line is normal while the session is live.
    }
  }
  return entries;
}

export function contentBlocks(msg: TranscriptMessage | null | undefined): ContentBlock[] {
  const content = msg && msg.content;
  return Array.isArray(content) ? content : [];
}

export function textOf(msg: TranscriptMessage | null | undefined): string {
  const content = msg && msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

// A user entry starts a new turn only when it carries real prompt text. Tool
// results also arrive with role "user" and must not be mistaken for one.
export function isUserPrompt(entry: TranscriptEntry | null | undefined): boolean {
  const msg = entry && entry.message;
  if (!msg || msg.role !== "user") return false;
  if (typeof msg.content === "string") return true;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as ContentBlock[]).some((b) => b && b.type === "text");
}

// The entries after the last user prompt: the turn that is ending now.
export function endingTurn(
  entries: TranscriptEntry[],
  isPrompt: (entry: TranscriptEntry) => boolean = isUserPrompt,
): TranscriptEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPrompt(entries[i])) return entries.slice(i + 1);
  }
  return entries;
}

function shellToolIsSubstantial(block: ContentBlock): boolean {
  if (!SHELL_TOOLS.has(block.name as string)) return false;
  const command = block.input && block.input.command;
  if (typeof command !== "string" || !command.trim()) return true;
  if (
    /[()[\]{}]|\$\(|\s--(?:ext-diff|output|pre|textconv)(?:=|\s|$)/i.test(command)
  ) {
    return true;
  }
  return !READ_ONLY_SHELL_COMMAND.test(command);
}

function toolIsSubstantial(block: ContentBlock): boolean {
  if (SHELL_TOOLS.has(block.name as string)) return shellToolIsSubstantial(block);
  return !READ_ONLY_TOOLS.has(block.name as string);
}

// Substantiality is judged over the assistant messages of the ENDING turn, so a
// long tool-driven turn that closes with one short sentence still counts: a
// known write/delegation tool, three tool calls of any kind, or >= 400 chars of
// assistant prose.
export function turnIsSubstantial(turn: TranscriptEntry[]): boolean {
  let chars = 0;
  let toolCalls = 0;
  for (const entry of turn) {
    const msg = entry && entry.message;
    if (!msg || msg.role !== "assistant") continue;
    chars += textOf(msg).length;
    for (const block of contentBlocks(msg)) {
      if (!block || block.type !== "tool_use") continue;
      toolCalls++;
      if (toolIsSubstantial(block)) return true;
    }
  }
  return toolCalls >= SUBSTANTIAL_TOOL_CALLS || chars >= SUBSTANTIAL_CHARS;
}

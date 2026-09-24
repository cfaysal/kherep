// OP-1425. $WS/CLAUDE.md and $WS/AGENTS.md belong to the operator. Kherep owns
// only the block between PROJECT_RULES_START and PROJECT_RULES_END; every byte
// outside it stays as the operator wrote it.
//
// The markers differ from the Codex installer's <!-- kherep:start --> and
// <!-- kherep-user-parity:start --> (codex/install.mts), which it writes into
// $CODEX_HOME/AGENTS.md. Neither marker is a substring of the other, so both
// blocks can live in one AGENTS.md without either installer moving the other's.
// The block semantics follow setMarkedBlock (codex/lib/text-merge.mts): a
// trimmed body, the file's own newline, refusal of an incomplete or ambiguous
// block. Two differences are deliberate: an append keeps the operator bytes
// untouched instead of trimming their end, and the body is spliced in by index
// rather than through String.replace, so "$&" in a rule is not a pattern.
//
// CLI, called by install.sh, drift-check.sh and capture.sh:
//   render  <template> <target> <out>          merged file for the install transaction
//   drift   <template> <live> <outRepo> <outLive>  block bodies for cmp_file; exit 3 = no block
//   capture <live> <out>                        block body back into the template; exit 3 = no block
// Exit 2 = refused (incomplete or ambiguous block); nothing is written then.
import { createHash } from "node:crypto";
import fs from "node:fs";

import { KNOWN_TEMPLATE_SHA256 } from "./project-rules-history.mts";

export const PROJECT_RULES_START = "<!-- kherep-project-rules:start -->";
export const PROJECT_RULES_END = "<!-- kherep-project-rules:end -->";

const KNOWN = new Set(KNOWN_TEMPLATE_SHA256);

function newlineFor(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// Returns the span from the start marker to the end of the end marker, null
// when neither marker is present, and throws for anything in between.
function findBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(PROJECT_RULES_START);
  const end = text.indexOf(PROJECT_RULES_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end === -1) {
    const lone = start === -1 ? PROJECT_RULES_END : PROJECT_RULES_START;
    throw new Error(`Refusing to update an incomplete managed block: ${lone} without its partner`);
  }
  const duplicate = text.indexOf(PROJECT_RULES_START, start + 1) !== -1 || text.indexOf(PROJECT_RULES_END, end + 1) !== -1;
  if (end < start || duplicate) {
    throw new Error(`Refusing to update an ambiguous managed block: ${PROJECT_RULES_START}`);
  }
  return { start, end: end + PROJECT_RULES_END.length };
}

export function blockBody(text: string): string | null {
  const span = findBlock(text);
  if (!span) return null;
  return text.slice(span.start + PROJECT_RULES_START.length, span.end - PROJECT_RULES_END.length).trim();
}

export function isKnownTemplate(text: string): boolean {
  return KNOWN.has(createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex"));
}

function renderBlock(template: string, newline: string): string {
  const body = template.trim().replace(/\r?\n/g, newline);
  return `${PROJECT_RULES_START}${newline}${body}${newline}${PROJECT_RULES_END}`;
}

// (a) missing or empty -> the block alone; (b) marked -> only the block changes;
// (c) an unedited historical template -> the block alone; (d) anything else is
// operator content -> the block is appended after one blank line; (e) a lone,
// duplicated or reversed marker throws before anything is produced.
export function mergeProjectRules(existing: string | null, template: string): string {
  if (existing === null || existing === "") return `${renderBlock(template, "\n")}\n`;
  const newline = newlineFor(existing);
  const block = renderBlock(template, newline);
  const span = findBlock(existing);
  if (span) return existing.slice(0, span.start) + block + existing.slice(span.end);
  if (isKnownTemplate(existing)) return `${block}${newline}`;
  const separator = existing.endsWith("\n") ? newline : newline + newline;
  return `${existing}${separator}${block}${newline}`;
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function main(argv: string[]): number {
  const [mode, ...args] = argv;
  if (mode === "render" && args.length === 3) {
    const [template, target, out] = args;
    fs.writeFileSync(out, mergeProjectRules(readIfPresent(target), fs.readFileSync(template, "utf8")));
    return 0;
  }
  if (mode === "drift" && args.length === 4) {
    const [template, live, outRepo, outLive] = args;
    const body = blockBody(fs.readFileSync(live, "utf8"));
    if (body === null) return 3;
    fs.writeFileSync(outRepo, `${fs.readFileSync(template, "utf8").trim()}\n`);
    fs.writeFileSync(outLive, `${body}\n`);
    return 0;
  }
  if (mode === "capture" && args.length === 2) {
    const [live, out] = args;
    const body = blockBody(fs.readFileSync(live, "utf8"));
    if (body === null) return 3;
    fs.writeFileSync(out, `${body.replace(/\r\n/g, "\n")}\n`);
    return 0;
  }
  console.error("usage: project-rules-block.mts render|drift|capture ...");
  return 64;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`FATAL: ${(error as Error).message} (${process.argv.slice(3).join(" ")})`);
    process.exitCode = 2;
  }
}

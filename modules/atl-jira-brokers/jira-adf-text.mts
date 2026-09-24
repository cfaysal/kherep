// OP-1387: shared ADF-to-text reader for both Jira brokers. The reverse of
// jira-adf.mts.
//
// WHY THIS EXISTS. `get` could report who wrote a work item and what its title
// is, but never what it says, because there was no way to turn a description
// back into text. A caller had to open a browser to read a body the broker had
// already been handed.
//
// WHY A SEPARATE MODULE rather than a second half of jira-adf.mts: that file is
// at 182 lines and the 250-LOC limit from CLAUDE.md is a split signal, not a
// ceiling to lean on. One module writes, one reads, both are imported twice.
//
// THE DEGRADATION RULE IS THE POINT. ADF grows node types faster than this
// module will be updated, and the bug being fixed here is a description that
// renders as nothing. So an unrecognised node is never skipped and never throws:
// it contributes its own text, then its children's, then the documented textual
// attributes below. A node that genuinely carries no text anywhere contributes
// nothing - there is nothing to print - and the caller is expected to notice an
// empty result rather than report it as an empty description.
//
// THE ATTRIBUTE NAMES ARE READ OFF THE SPEC, NOT REMEMBERED (CLAUDE.md rule 5).
// Atlassian ADF node reference, read 2026-09-18:
//   - mention: "text: the textual representation of the mention, including a
//     leading @."
//   - status:  "attrs.text ... The textual representation of the status".
//   - emoji:   "text represents the text version of the emoji, shortName is
//     rendered instead if omitted", with shortName required, "such as
//     \":grinning:\"".
//   - inlineCard: attrs.url, "A URI"; "Either data or url must be provided".
//   - hardBreak: "The hardBreak node inserts a new line in a text string."
//   - link mark: attrs.href, "A URI", required.
// Those five cover what a real description actually contains beyond prose, and
// they are reached through one generic rule rather than five special cases.

import type { AdfNode } from "./jira-adf.mts";

const BLOCK_SEPARATOR = "\n\n";

/**
 * What a broker reports for a description that exists but renders to nothing.
 * Defined here rather than spelled out in each broker for the same reason the
 * wire strings in jira-attach.mts are: a one-word edit in one of them would make
 * the two runtimes say different things about the same work item, and nothing
 * would notice.
 */
export const DESCRIPTION_UNREADABLE = "<vorhanden, aber nicht als Text darstellbar>";

function attr(node: AdfNode, name: string): string | null {
  const value = node.attrs?.[name];
  return typeof value === "string" && value ? value : null;
}

// The documented textual attributes, in the order a reader wants them: the node's
// own rendering first, then the name that stands in for it, then the address it
// points at.
function attributeText(node: AdfNode): string {
  return attr(node, "text") ?? attr(node, "shortName") ?? attr(node, "url") ?? "";
}

function markOf(node: AdfNode, type: string): { attrs?: Record<string, unknown> } | undefined {
  return node.marks?.find((mark) => mark.type === type);
}

function marked(node: AdfNode, text: string): string {
  let result = text;
  // Inline code first, so a linked code span reads as [`x`](url) and not as a
  // fence wrapped around the whole link.
  if (markOf(node, "code")) result = `\`${result}\``;
  const href = markOf(node, "link")?.attrs?.href;
  if (typeof href === "string" && href) {
    // An autolinked URL is its own label. Printing it twice is noise, not detail.
    return result === href ? href : `[${result}](${href})`;
  }
  return result;
}

function inlineText(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map((node) => {
    if (node.type === "hardBreak") return "\n";
    if (typeof node.text === "string") return marked(node, node.text);
    if (node.content?.length) return inlineText(node.content);
    return attributeText(node);
  }).join("");
}

// A list item holds blocks, so a nested list inside it renders as its own lines
// and then gets indented by this marker's width. That is the whole of nesting
// support and it costs nothing.
function listItem(node: AdfNode, marker: string): string {
  const body = blocks(node.content).join("\n");
  const indent = " ".repeat(marker.length);
  return body
    .split("\n")
    .map((line, index) => (index === 0 ? `${marker}${line}` : `${indent}${line}`))
    .join("\n");
}

function list(node: AdfNode, ordered: boolean): string {
  const start = Number(node.attrs?.order ?? 1);
  const first = Number.isFinite(start) && start > 0 ? start : 1;
  return (node.content ?? [])
    .map((item, index) => listItem(item, ordered ? `${first + index}. ` : "- "))
    .join("\n");
}

function codeBlock(node: AdfNode): string {
  const language = attr(node, "language") ?? "";
  return `\`\`\`${language}\n${inlineText(node.content)}\n\`\`\``;
}

function heading(node: AdfNode): string {
  const level = Number(node.attrs?.level ?? 1);
  const hashes = "#".repeat(Number.isFinite(level) && level >= 1 && level <= 6 ? level : 1);
  return `${hashes} ${inlineText(node.content)}`;
}

function block(node: AdfNode): string {
  switch (node.type) {
    case "heading": return heading(node);
    case "paragraph": return inlineText(node.content);
    case "bulletList": return list(node, false);
    case "orderedList": return list(node, true);
    case "codeBlock": return codeBlock(node);
    case "rule": return "---";
    default:
      // Unknown block. Its children are rendered as blocks so a panel or a
      // blockquote keeps its paragraphs apart; a leaf falls back to its text.
      return node.content?.length ? blocks(node.content).join(BLOCK_SEPARATOR) : inlineText([node]);
  }
}

function blocks(nodes: AdfNode[] | undefined): string[] {
  return (nodes ?? [])
    .map((node) => block(node))
    .filter((text) => text.trim().length > 0);
}

/**
 * Plain text for a Jira description, comment or any other ADF document.
 *
 * The argument is unknown on purpose: it arrives straight out of a JSON payload
 * and nothing about its shape is proven. A plain string is passed through, since
 * a site that answers with one has still told the caller what the field says.
 * Anything unreadable yields the empty string - never an exception, because a
 * malformed description must not take down a `get`.
 */
export function adfToText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return blocks(content as AdfNode[]).join(BLOCK_SEPARATOR).trim();
}

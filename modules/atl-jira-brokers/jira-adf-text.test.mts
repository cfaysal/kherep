import test from "node:test";
import assert from "node:assert/strict";

import { adfToText } from "./jira-adf-text.mts";
import { renderAdf } from "./jira-adf.mts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });

test("headings keep their level", () => {
  assert.equal(
    adfToText(doc(
      { type: "heading", attrs: { level: 1 }, content: [text("Titel")] },
      { type: "heading", attrs: { level: 3 }, content: [text("Unterpunkt")] },
    )),
    "# Titel\n\n### Unterpunkt",
  );
});

test("paragraphs are separated by a blank line and hard breaks by a single one", () => {
  assert.equal(
    adfToText(doc(
      { type: "paragraph", content: [text("erste"), { type: "hardBreak" }, text("zweite")] },
      { type: "paragraph", content: [text("dritte")] },
    )),
    "erste\nzweite\n\ndritte",
  );
});

test("bullet lists and ordered lists come back as lists, not as one sentence", () => {
  const items = (...values: string[]) => values.map((value) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: [text(value)] }],
  }));
  assert.equal(
    adfToText(doc({ type: "bulletList", content: items("eins", "zwei") })),
    "- eins\n- zwei",
  );
  assert.equal(
    adfToText(doc({ type: "orderedList", content: items("eins", "zwei") })),
    "1. eins\n2. zwei",
  );
  assert.equal(
    adfToText(doc({ type: "orderedList", attrs: { order: 5 }, content: items("fuenf", "sechs") })),
    "5. fuenf\n6. sechs",
  );
});

test("a list inside a list item is indented under it", () => {
  assert.equal(
    adfToText(doc({
      type: "bulletList",
      content: [{
        type: "listItem",
        content: [
          { type: "paragraph", content: [text("oben")] },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("unten")] }] }] },
        ],
      }],
    })),
    "- oben\n  - unten",
  );
});

test("a code block keeps its fence and its language", () => {
  assert.equal(
    adfToText(doc({ type: "codeBlock", attrs: { language: "bash" }, content: [text("npm run test:brokers")] })),
    "```bash\nnpm run test:brokers\n```",
  );
  assert.equal(
    adfToText(doc({ type: "codeBlock", content: [text("plain")] })),
    "```\nplain\n```",
  );
});

test("inline code and links are readable and keep their target", () => {
  assert.equal(
    adfToText(doc({
      type: "paragraph",
      content: [
        text("siehe "),
        text("readAttachments", [{ type: "code" }]),
        text(" in der "),
        text("Doku", [{ type: "link", attrs: { href: "https://example.invalid/adf" } }]),
      ],
    })),
    "siehe `readAttachments` in der [Doku](https://example.invalid/adf)",
  );
});

test("an autolinked URL is printed once, not as a label of itself", () => {
  const url = "https://example.invalid/OP-1387";
  assert.equal(
    adfToText(doc({ type: "paragraph", content: [text(url, [{ type: "link", attrs: { href: url } }])] })),
    url,
  );
});

// OP-1387. The degradation rule, which is the whole reason this module can be
// trusted with a field it did not write.
test("an unknown node type degrades to its text instead of vanishing or throwing", () => {
  assert.equal(
    adfToText(doc({
      type: "paragraph",
      content: [
        text("hallo "),
        { type: "mention", attrs: { id: "557058:abc", text: "@Ada Lovelace" } },
        text(" und "),
        { type: "emoji", attrs: { shortName: ":wave:" } },
        text(" siehe "),
        { type: "inlineCard", attrs: { url: "https://example.invalid/OP-1" } },
      ],
    })),
    "hallo @Ada Lovelace und :wave: siehe https://example.invalid/OP-1",
  );
});

test("an unknown block keeps the paragraphs inside it", () => {
  assert.equal(
    adfToText(doc({
      type: "panel",
      attrs: { panelType: "warning" },
      content: [
        { type: "paragraph", content: [text("Achtung")] },
        { type: "paragraph", content: [text("zweite Zeile")] },
      ],
    })),
    "Achtung\n\nzweite Zeile",
  );
});

test("a node type nobody has ever seen is still read for text, at any depth", () => {
  assert.equal(
    adfToText(doc({
      type: "someFutureNode",
      attrs: { flavour: "unknown" },
      content: [{ type: "anotherFutureNode", content: [text("trotzdem lesbar")] }],
    })),
    "trotzdem lesbar",
  );
  // A leaf that carries nothing but its own name contributes nothing - there is
  // no text to print - and it must not take the rest of the document with it.
  assert.equal(
    adfToText(doc(
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "abc", type: "file" } }] },
      { type: "paragraph", content: [text("danach")] },
    )),
    "danach",
  );
});

test("a malformed or empty document yields empty text rather than an exception", () => {
  for (const value of [null, undefined, 42, {}, { type: "doc" }, { type: "doc", content: "nope" }, doc()]) {
    assert.equal(adfToText(value), "");
  }
  assert.equal(adfToText(doc({ type: "paragraph" })), "");
});

test("a site that answers with a plain string is passed through", () => {
  assert.equal(adfToText("  eine alte Beschreibung  "), "eine alte Beschreibung");
});

// The two modules are each other's inverse for the structure the renderer
// builds. This is what keeps them from drifting apart: a change to either that
// loses a block shows up here.
test("what renderAdf writes, adfToText reads back", () => {
  const written = [
    "# Titel",
    "",
    "Ein Absatz mit `code` darin.",
    "",
    "- eins",
    "- zwei",
    "",
    "1. erstens",
    "2. zweitens",
    "",
    "```bash",
    "npm run test:brokers",
    "```",
  ].join("\n");
  assert.equal(adfToText(renderAdf(written)), written);
});

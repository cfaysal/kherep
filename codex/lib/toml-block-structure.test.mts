import assert from "node:assert/strict";
import { test } from "node:test";

import { blockPieces, fragmentPieces, scanDocument, structure, type Span } from "./toml-block-structure.mts";

const slice = (text: string, { start, end }: Span): string => text.slice(start, end);

test("finds only the headers outside strings, comments, arrays and inline tables", () => {
  const text = ['top = "[not a header]" # [nor this]', "[a]", "s = 'x # y'", 'm = """', "[inside_basic]", '"""',
    "l = '''", "[inside_literal]", "'''", "arr = [", "  [1, 2],", "]", "inline = { k = [1] }", "# [comment]",
    "  [b . 'c.d' . \"e\"]  # trailing", "x = 1", ""].join("\n");

  const doc = scanDocument(text);

  assert.deepEqual(doc.tables.map(({ address }) => address), ["a", 'b."c.d".e']);
  assert.deepEqual(doc.tables[1].path, ["b", "c.d", "e"]);
  assert.deepEqual(doc.top, ['top = "[not a header]" # [nor this]']);
  assert.deepEqual(doc.multiline.map((span) => slice(text, span).slice(0, 3)), ['"""', "'''", "[\n "]);
  assert.equal(doc.tables[0].payload.at(-1), "inline = { k = [1] }");
  assert.deepEqual(doc.tables[1].payload, ["  [b . 'c.d' . \"e\"]  # trailing", "x = 1"]);
  assert.equal(slice(text, doc.tables[1].span), text.slice(text.indexOf("  [b")));
});

test("refuses a document it cannot follow", () => {
  for (const text of ['k = "open\n', "k = '''\nopen", "k = [1,\n", "k = [1}", "[a b]", "[[a]", "[a]]", "[a.]",
    '[a]\nk = "\\\n"']) {
    assert.throws(() => scanDocument(text), /Cannot read the TOML structure safely/, JSON.stringify(text));
  }
});

test("addresses array elements per parent instance, whatever the quote style", () => {
  const text = ["[[hooks.Stop]]", "[[hooks.Stop.hooks]]", "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", "[[hooks.Stop.hooks]]",
    "[hooks.Stop.meta]", "[[owner_items]]", "[owner_items.meta]", "[[owner_items]]", "[owner_items.meta]",
    '[x."y z"]', "[\"x\".'w']"].join("\n");

  const doc = scanDocument(text);

  assert.deepEqual(doc.tables.map(({ address }) => address), [
    "hooks.Stop[0]", "hooks.Stop[0].hooks[0]", "hooks.Stop[1]", "hooks.Stop[1].hooks[0]", "hooks.Stop[1].hooks[1]",
    "hooks.Stop[1].meta", "owner_items[0]", "owner_items[0].meta", "owner_items[1]", "owner_items[1].meta",
    'x."y z"', "x.w"]);
  assert.deepEqual(doc.tables.map(({ array }) => array), [true, true, true, true, true, false, true, false, true, false,
    false, false]);
});

test("structure leaves out excluded tables and refuses a repeated address", () => {
  const doc = scanDocument('top = 1\n[a]\nk = 1\n\n# note\n[[b]]\nk = 2\n[[b]]\nk = 3\n');
  assert.deepEqual(structure(doc, new Set(["b[1]"])),
    { top: ["top = 1"], plain: new Map([["a", ["[a]", "k = 1"]]]), arrays: [["b[0]", ["[[b]]", "k = 2"]]] });
  for (const text of ["[a]\n[\"a\"]\n", "[x.y]\n[x.'y']\n", "[[b]]\n[b]\n"]) {
    assert.throws(() => structure(scanDocument(text), new Set()), /Cannot read the TOML structure safely/, text);
  }
});

test("cuts only the last piece of the block at the end marker", () => {
  const text = "[before]\nk = 1\n# START\n# preamble\n\n[one]\na = 1\n\n[two]\nb = 2\n# END\nc = 3\n\n[after]\nd = 4\n";
  const doc = scanDocument(text);
  const endStart = text.indexOf("# END");

  const pieces = blockPieces(doc, text.indexOf("# preamble"), endStart, endStart + "# END\n".length);

  assert.equal(slice(text, pieces.preamble), "# preamble\n\n");
  assert.deepEqual(pieces.tables.map(({ piece }) => slice(text, piece)), ["[one]\na = 1\n\n", "[two]\nb = 2\n"]);
  assert.equal(slice(text, pieces.tables[1].table.span), "[two]\nb = 2\n# END\nc = 3\n\n");
  assert.equal(slice(text, pieces.carry), "c = 3\n\n");
  for (const end of ["# END", "# END\n"]) {
    const last = `[one]\na = 1\n${end}`, at = last.indexOf("# END");
    assert.equal(slice(last, blockPieces(scanDocument(last), 0, at, last.length).carry), "");
  }
  const fragment = fragmentPieces("# head\n\n[one]\na = 1\n\n[two]\nb = 2");
  assert.deepEqual([fragment.preamble, ...fragment.tables.map(({ piece }) => piece), fragment.carry],
    [{ start: 0, end: 8 }, { start: 8, end: 21 }, { start: 21, end: 32 }, { start: 32, end: 32 }]);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import { legacyForm } from "./legacy-control-plane-form.mts";
import {
  BEFORE, BLOCK, END, FRESH, OPTIONS, REFUSAL, conserved, managedBlock, tomlDocument, type TomlDocument,
} from "./managed-block-split.fixture.mts";

// Issue #684. Measured on macOS with Codex CLI 0.160.1: storing hook trust, the
// CLI wrote a bare `[hooks.state]`, 23 trust tables and `[tui]` inside the
// managed block, between the last hook group and the first MCP table and right
// before the end marker. Every path below is synthetic.

const EVENTS: [string, string[]][] = [
  ["pre_tool_use", ["0:0", "1:0", "1:1", "2:0", "3:0", "4:0"]], ["post_tool_use", ["0:0", "1:0", "2:0"]],
  ["pre_compact", ["0:0"]], ["session_start", ["0:0", "0:1", "0:2", "0:3", "1:0"]],
  ["user_prompt_submit", ["0:0", "0:1", "1:0"]], ["subagent_start", ["0:0"]], ["subagent_stop", ["0:0"]],
  ["stop", ["0:0", "0:1", "1:0"]],
];
const STATE = EVENTS.flatMap(([event, keys]) => keys.map((key, index) =>
  `[hooks.state."fixture-home/config.toml:${event}:${key}"]\ntrusted_hash = "sha256:fixture-${event}-${index}"`));
const TRUST_INTERLEAVED = ["[hooks.state]", ...STATE].join("\n\n");
const LAST_STATE = STATE.at(-1)!;
const TUI = "[tui]\nscreen_reader_detection_done = true";
const FOREIGN = '[operator_inside]\nkeep = "operator-owned"\nnumber = 3';
const KEY = "enabled = false";
const NOTE = "# operator note";
const BEHIND = '[hooks.state."fixture-home/config.toml:stop:2:0"]\ntrusted_hash = "sha256:fixture-behind"';
const AFTER = '[operator_after]\nkeep = "operator-owned"';
const HOOKS = FRESH.slice(0, FRESH.indexOf("[mcp_servers.")).trimEnd();
const MCP = FRESH.slice(FRESH.indexOf("[mcp_servers."), FRESH.indexOf(END)).trimEnd();
const PREAMBLE = BLOCK.trim().split("\n")[0];

// The measured layout: one blank line around the trust tables, `[tui]` right
// before the end marker, a single newline behind it.
function interleaved(withTui: boolean, withForeign: boolean, behind = "", foreign = FOREIGN): string {
  return `${HOOKS}\n\n${TRUST_INTERLEAVED}${withForeign ? `\n\n${foreign}` : ""}\n\n${MCP}`
    + `${withTui ? `\n\n${TUI}` : ""}\n${END}\n${behind}`;
}
// Trust tables as the last tables of the block.
const trustLast = (behind: string, last = TRUST_INTERLEAVED) => `${HOOKS}\n\n${MCP}\n\n${last}\n${END}\n${behind}`;
const headerOf = (table: string) => table.split("\n")[0];
const once = (text: string, part: string) => text.split(part).length === 2;

function accepted(config: string, managedBefore = BLOCK): string {
  const result = prepareManagedConfig(config, OPTIONS);
  assert.equal(result.managedFragment, "replaced");
  assert.equal(managedBlock(result.config), managedBlock(FRESH));
  assert.equal(result.config.split(END).length, 2);
  assert.ok(conserved(config, result.config, managedBefore), "every other line stays, once");
  const again = prepareManagedConfig(result.config, OPTIONS);
  assert.equal(again.managedFragment, "current");
  assert.equal(again.config, result.config);
  return result.config;
}

function equivalent(config: string): string {
  const result = accepted(config);
  assert.deepEqual(tomlDocument(result), tomlDocument(config));
  return result;
}

test("re-anchors the measured block with trust tables inside it", () => {
  for (const withTui of [true, false]) {
    for (const withForeign of [true, false]) {
      const result = equivalent(interleaved(withTui, withForeign));
      const after = result.slice(result.indexOf(END));
      const lifted = ["[hooks.state]", ...STATE.map(headerOf), ...withForeign ? ["[operator_inside]"] : [],
        ...withTui ? ["[tui]"] : []].map((header) => after.indexOf(`\n${header}\n`));
      assert.ok(lifted.every((at, index) => at > 0 && (index === 0 || at > lifted[index - 1])), "in order after the end marker");
    }
  }
});

test("re-anchors the measured block written from an earlier source pin", () => {
  const root = String.raw`C:\Synthetic\.codex\orchestra\source-pins\0123456789abcdef0123456789abcdef01234567`;
  const config = legacyForm(interleaved(true, true), root);
  assert.notEqual(config, interleaved(true, true));

  const result = accepted(config, legacyForm(BLOCK, root));

  const rest = ({ arrays: _hooks, tables, ...doc }: TomlDocument) =>
    ({ ...doc, tables: Object.entries(tables).filter(([address]) => !address.startsWith("mcp_servers.")) });
  assert.deepEqual(rest(tomlDocument(result)), rest(tomlDocument(config)));
  assert.equal(result.includes("0123456789abcdef0123456789abcdef01234567"), false, "no command names the earlier pin");
});

test("moves the text after the end marker with the lifted table that owns it", () => {
  const key = equivalent(trustLast(`${KEY}\n`));
  assert.ok(key.includes(`${LAST_STATE}\n${KEY}\n`) && once(key, KEY));
  const noted = equivalent(trustLast(`${NOTE}\n${KEY}\n`));
  assert.ok(noted.includes(`${LAST_STATE}\n${NOTE}\n${KEY}\n`) && once(noted, NOTE) && once(noted, KEY));
  const tui = equivalent(interleaved(true, false, "animations = false\n"));
  assert.ok(tui.includes(`${TUI}\nanimations = false\n`) && once(tui, "animations = false"));
});

test("moves a comment after the end marker once, before the tables behind it", () => {
  const config = trustLast(`${NOTE}\n\n${BEHIND}\n\n${AFTER}\n`);

  const result = equivalent(config);

  const order = [LAST_STATE, NOTE, BEHIND, AFTER].map((part) => result.indexOf(part));
  assert.ok(order.every((at, index) => at > result.indexOf(END) && (index === 0 || at > order[index - 1])));
  assert.ok(once(result, NOTE));
  assert.equal(conserved(config, result.replace(`${NOTE}\n`, "")), false, "conserved sees a lost comment");
});

test("keeps a blank line after the end marker byte for byte", () => {
  const owner = '[hooks.state."fixture-home/config.toml:stop:1:0"]\ntrusted_hash = "sha256:fixture-owner"';
  const config = trustLast(`\n${BEHIND}\n`, owner);
  const piece = config.slice(config.indexOf(owner), config.indexOf(END));
  const carry = config.slice(config.indexOf(END) + END.length + 1, config.indexOf(BEHIND));
  assert.equal(piece, `${owner}\n`);
  assert.equal(carry, "\n");

  const result = equivalent(config);

  assert.ok(result.includes(piece + carry + config.slice(config.indexOf(BEHIND))));
});

test("refuses text after the end marker that a managed table owns", () => {
  for (const behind of [`${NOTE}\n`, `${KEY}\n`]) {
    assert.throws(() => prepareManagedConfig(interleaved(false, false, behind), OPTIONS), REFUSAL);
  }
});

test("binds the comment that opens the managed block", () => {
  const config = interleaved(true, true);
  equivalent(config.replace(`${PREAMBLE}\n`, `${PREAMBLE}\n\n\n`));
  for (const edited of [config.replace(`${PREAMBLE}\n`, ""), config.replace(PREAMBLE, `${PREAMBLE} Edited.`),
    config.replace(`${PREAMBLE}\n`, `${PREAMBLE}\nstray = 1\n`)]) {
    assert.notEqual(edited, config);
    assert.throws(() => prepareManagedConfig(edited, OPTIONS), REFUSAL);
  }
});

test("refuses a block with a multiline value and reads a bracket inside a string as a value", () => {
  const literal = `${HOOKS}\n\n[operator_fixture]\nvalue = '''\n${TRUST_INTERLEAVED}\n[operator_end]\n'''\n\n${MCP}\n${END}\n`;
  const array = interleaved(true, true, "", '[operator_inside]\nargs = [\n  "x",\n]');
  for (const config of [literal, array]) assert.throws(() => prepareManagedConfig(config, OPTIONS), REFUSAL);
  equivalent(interleaved(true, true, "", `${FOREIGN}\nk = "[not a header]"`));
});

const N2A = '[[owner_items]]\nname = "first"\n\n[owner_items.meta]\nkeep = 1\n\n'
  + '[[owner_items]]\nname = "second"\n\n[owner_items.meta]\nkeep = 2\n\n';

test("tells tables under an array of tables apart by their element", () => {
  equivalent(interleaved(true, true).replace(BEFORE, BEFORE + N2A));
  const inside = interleaved(true, true, "", "[owner_items.meta]\nkeep = 1")
    .replace(BEFORE, `${BEFORE}[[owner_items]]\nname = "first"\n\n`);
  assert.throws(() => prepareManagedConfig(inside, OPTIONS), REFUSAL);
});

test("refuses an interleaved block with any other difference", () => {
  const config = interleaved(true, true);
  for (const edited of [config.replace(/timeout = (\d+)/, (_, seconds) => `timeout = ${Number(seconds) + 1}`),
    interleaved(true, true, "", '[mcp_servers.other]\ncommand = "other"'),
    config.replace(BEFORE, `${BEFORE}${TUI}\n\n`)]) {
    assert.notEqual(edited, config);
    assert.throws(() => prepareManagedConfig(edited, OPTIONS), REFUSAL);
  }
});

test("the oracle tells documents apart that these tests must not confuse", () => {
  const config = interleaved(true, true), doc = tomlDocument(config);
  for (const edited of [config.replace("detection_done = true", "detection_done = false"),
    config.replace("fixture-stop-2", "fixture-stop-9"), config.replace("\nnumber = 3", "")]) {
    assert.notEqual(edited, config);
    assert.notDeepEqual(tomlDocument(edited), doc);
  }
  const group = (name: string) => `[[hooks.Stop]]\nname = "${name}"\n`, child = '[[hooks.Stop.hooks]]\ntype = "command"\n';
  assert.notDeepEqual(tomlDocument(group("a") + child + group("b")), tomlDocument(group("a") + group("b") + child));
  assert.deepEqual(Object.keys(tomlDocument(N2A).tables), ["owner_items[0].meta", "owner_items[1].meta"]);
  assert.ok(tomlDocument(FRESH).arrays.some(([address]) => address === "hooks.Stop[1].hooks[0]"));
  assert.throws(() => tomlDocument("[operator_fixture]\nvalue = '''\n'''\n"));
});

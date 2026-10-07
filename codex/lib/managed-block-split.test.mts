import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";
import { render } from "./parity-config.mts";

// Issue #274. Measured on a Windows host: the Codex app, storing hook trust,
// rewrote config.toml so that its trust tables sit inside the managed block,
// the managed tail sits after the end marker, and the end marker separates the
// keys of one trust table. The TOML is the same document as a normal install.

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";

const OPTIONS: ManagedConfigOptions = {
  startMarker: START,
  endMarker: END,
  retiredMcpServerNames: [],
  registryProjections: [],
  pluginMcpServers: {},
  contextHook: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro-context.mts`,
  hookDir: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro`,
  memoryNotifyHook: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro\codex-memory-notify.mts`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  registry: String.raw`C:\Synthetic\.codex\orchestra\mcp-registry.json`,
  registryBridge: String.raw`C:\Synthetic\.codex\orchestra\registry-http-bridge.mts`,
  registryRuntime: String.raw`C:\Synthetic\.codex\orchestra\supergateway-secret-wrapper.mts`,
  controlPlaneHook: String.raw`C:\Synthetic\repo\modules\control-plane\node\deliver-hook.mts`,
  messagingClient: {
    enabled: true,
    bridge: String.raw`C:\Synthetic\repo\modules\control-plane\node\mcp-stdio-bridge.mts`,
    intentHook: String.raw`C:\Synthetic\repo\modules\control-plane\node\mcp-intent-hook.mts`,
    configRoot: String.raw`C:\Synthetic\kherep`,
  },
};

const FRESH = prepareManagedConfig("", OPTIONS).config;
const BEFORE = FRESH.slice(0, FRESH.indexOf(START));
const BLOCK = FRESH.slice(FRESH.indexOf(START) + START.length, FRESH.indexOf(END));
// The tail opens with the deliver hooks: the last SessionStart group of the block.
const HEAD = BLOCK.slice(0, BLOCK.lastIndexOf("[[hooks.SessionStart]]")).trim();
const TAIL = BLOCK.slice(BLOCK.lastIndexOf("[[hooks.SessionStart]]")).trim();

const STATE_INSIDE = [
  "[hooks.state]", "",
  "[hooks.state.'fixture-a.toml:pre_tool_use:0:0']", 'trusted_hash = "sha256:fixture-a"', "",
  "[hooks.state.'fixture-b.json:stop:0:0']", 'trusted_hash = "sha256:fixture-b"',
].join("\n");
const SEPARATED_KEY = "enabled = false";
const STATE_BETWEEN = "[hooks.state.'fixture-c.toml:session_start:0:0']\ntrusted_hash = \"sha256:fixture-c\"";
const OPERATOR = '[operator_fixture]\nkeep = "operator-owned"';

function split(tail: string, between = STATE_BETWEEN): string {
  return [BEFORE + START, HEAD, "", STATE_INSIDE, END, SEPARATED_KEY, "", between, "", tail, "", OPERATOR, ""].join("\n");
}

// What a TOML parser reports for the hooks arrays and hooks.state. Comments end
// no table, so a key after the end marker belongs to the table before it.
function tomlShape(config: string) {
  const events: Record<string, { keys: string[]; hooks: string[][] }[]> = {};
  const state: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of config.split("\n").map((value) => value.trim())) {
    if (!line || line.startsWith("#")) continue;
    const array = /^\[\[hooks\.(\w+)(\.hooks)?\]\]$/.exec(line);
    if (array) {
      const groups = events[array[1]] ??= [];
      if (array[2]) groups.at(-1)!.hooks.push(current = []);
      else groups.push({ keys: current = [], hooks: [] });
    } else if (line.startsWith("[")) {
      current = line.startsWith("[hooks.state") ? state[line] = [] : undefined;
    } else {
      current?.push(line);
    }
  }
  return { events, state };
}

function managedBlock(config: string): string {
  return config.slice(config.indexOf(START), config.indexOf(END) + END.length);
}

test("the split fixture holds the measured layout", () => {
  assert.match(TAIL, /^\[\[hooks\.SessionStart\]\]\nmatcher = "startup\|resume\|clear\|compact"/);
  assert.match(TAIL, /deliver-hook\.mts/);
  assert.match(TAIL, /\[mcp_servers\.kherep_messaging\][^]*tool_timeout_sec = 60\.0$/);
  assert.match(HEAD, /\[\[hooks\.SubagentStart\.hooks\]\][^[]*$/);
  const config = split(TAIL);
  assert.deepEqual(tomlShape(config).events, tomlShape(FRESH).events);
  assert.deepEqual(tomlShape(config).state["[hooks.state.'fixture-b.json:stop:0:0']"],
    ['trusted_hash = "sha256:fixture-b"', SEPARATED_KEY]);
});

test("re-anchors a block whose tail the Codex app moved behind the end marker", () => {
  for (const between of [STATE_BETWEEN, ""]) {
    const config = split(TAIL, between);

    const result = prepareManagedConfig(config, OPTIONS);

    assert.equal(result.managedFragment, "replaced");
    assert.equal(managedBlock(result.config), managedBlock(FRESH));
    assert.deepEqual(tomlShape(result.config), tomlShape(config));
    // The tail went back into the block and left no copy behind.
    assert.equal(result.config.split("[mcp_servers.kherep_messaging]").length, FRESH.split("[mcp_servers.kherep_messaging]").length);
    assert.equal(result.config.split("deliver-hook.mts").length, FRESH.split("deliver-hook.mts").length);
    const after = result.config.slice(result.config.indexOf(END));
    assert.ok(after.includes(`${STATE_INSIDE}\n${SEPARATED_KEY}\n`));
    if (between) assert.ok(after.includes(between));
    assert.ok(result.config.endsWith(`\n\n${OPERATOR}\n`));

    const again = prepareManagedConfig(result.config, OPTIONS);
    assert.equal(again.managedFragment, "current");
    assert.equal(again.config, result.config);
  }
});

test("re-anchors a tail behind the end marker without trust tables", () => {
  const config = [BEFORE + START, HEAD, END, "", TAIL, ""].join("\n");

  const result = prepareManagedConfig(config, OPTIONS);

  assert.equal(result.managedFragment, "replaced");
  assert.equal(result.config, FRESH);
});

test("still keeps trust tables inside a block that holds the whole fragment", () => {
  for (const windowsHookCommands of [true, false]) {
    const fragment = render({ ...OPTIONS, mcpServers: [], windowsHookCommands }).trim();
    const config = [BEFORE + START, fragment, "", STATE_INSIDE, END, SEPARATED_KEY, ""].join("\n");

    const result = prepareManagedConfig(config, OPTIONS);

    assert.equal(result.managedFragment, windowsHookCommands ? "current" : "replaced");
    assert.ok(result.config.includes(render({ ...OPTIONS, mcpServers: [] }).trim()));
    assert.ok(result.config.includes(`${STATE_INSIDE}\n${END}\n${SEPARATED_KEY}\n`));
    assert.deepEqual(tomlShape(result.config).state, tomlShape(config).state);
    assert.equal(prepareManagedConfig(result.config, OPTIONS).managedFragment, "current");
  }
});

test("refuses a split block whose tail differs in one line", () => {
  const altered = TAIL.replace("startup_timeout_sec = 30.0", "startup_timeout_sec = 31.0");
  assert.notEqual(altered, TAIL);

  assert.throws(() => prepareManagedConfig(split(altered), OPTIONS),
    /Refusing to overwrite a managed block without an exact known managed fragment/);
});

test("refuses a split block with an unknown table between the end marker and the tail", () => {
  assert.throws(() => prepareManagedConfig(split(TAIL, `${STATE_BETWEEN}\n\n${OPERATOR}`), OPTIONS),
    /Refusing to overwrite a managed block without an exact known managed fragment/);
});

test("refuses a split block with unknown content left inside the block", () => {
  const config = split(TAIL).replace(`${HEAD}\n`, `${HEAD}\n\n${OPERATOR}\n`);

  assert.throws(() => prepareManagedConfig(config, OPTIONS),
    /Refusing to overwrite a managed block without an exact known managed fragment/);
});

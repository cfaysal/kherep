import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { test } from "node:test";

import { legacyForm } from "./legacy-control-plane-form.mts";
import { renderHooks } from "./parity-config.mts";

// Issue #503. Codex trusts a hook by a hash over its definition, command line
// included. The Control Plane hook commands name the stable entry point in the
// hook dir and a fixed hook name, so an install from another source pin renders
// the same bytes.

const HOSTS = [
  { label: "Windows", node: String.raw`C:\Program Files\nodejs\node.exe`, hookDir: String.raw`C:\Users\x\.codex\hooks\kherep-maestro`,
    pins: [String.raw`D:\pins\0123456789abcdef0123456789abcdef01234567`, String.raw`D:\pins\89abcdef0123456789abcdef0123456789abcdef`], sep: "\\" },
  { label: "POSIX", node: "/usr/local/bin/node", hookDir: "/Users/x/.codex/hooks/kherep-maestro",
    pins: ["/Users/x/.codex/orchestra/source-pins/0123456789abcdef0123456789abcdef01234567",
      "/Users/x/.codex/orchestra/source-pins/89abcdef0123456789abcdef0123456789abcdef"], sep: "/" },
];

const options = (host: typeof HOSTS[number], pin: string) => ({
  contextHook: [host.hookDir, "..", "kherep-maestro-context.mts"].join(host.sep), hookDir: host.hookDir, node: host.node,
  mcpServers: [], controlPlaneHook: [pin, "modules", "control-plane", "node", "deliver-hook.mts"].join(host.sep),
});

// Every [[hooks.<event>.hooks]] table: its text and its decoded keys.
function tables(config: string): { text: string; command: string; commandWindows?: string }[] {
  return config.split(/^(?=\[\[hooks\.)/m).filter((table) => /^\[\[hooks\.\w+\.hooks\]\]/.test(table)).map((text) => {
    const value = (key: string) => {
      const line = new RegExp(`^${key} = (".*")$`, "m").exec(text)?.[1];
      return line === undefined ? undefined : JSON.parse(line) as string;
    };
    return { text: text.trim(), command: value("command")!, commandWindows: value("commandWindows") };
  });
}

const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

for (const host of HOSTS) {
  test(`renders byte-identical Control Plane hook commands for two source pins (${host.label})`, () => {
    const [a, b] = host.pins.map((pin) => renderHooks(options(host, pin)));
    assert.equal(a, b);
    assert.deepEqual(tables(a!).map(({ text }) => sha256(text)), tables(b!).map(({ text }) => sha256(text)));
    for (const { command, commandWindows } of tables(a!)) {
      for (const value of [command, commandWindows ?? ""]) {
        assert.doesNotMatch(value, /source-pins|deliver-hook\.mts|attribution-hook\.mts/);
        for (const pin of host.pins) assert.equal(value.includes(pin), false);
      }
    }
    const entry = path.join(host.hookDir, "codex-control-plane-hook.mts");
    const q = (...parts: string[]) => parts.map((part) => `"${part}"`).join(" ");
    const deliver = q(host.node, entry, "deliver", "--runtime", "codex");
    const attribution = q(host.node, entry, "attribution", "--runtime", "codex");
    const shell = q(host.node, path.join(host.hookDir, "codex-shell-checks.mts"), entry, "attribution", "--runtime", "codex");
    const named = tables(a!).map(({ command }) => command).filter((command) => command.includes(entry));
    assert.deepEqual(named, [shell, attribution, deliver, deliver, deliver, deliver]);
  });

  test(`every Control Plane hook carries the call-operator form for Windows (${host.label})`, () => {
    const config = renderHooks(options(host, host.pins[0]!));
    const entry = path.join(host.hookDir, "codex-control-plane-hook.mts");
    const named = tables(config).filter(({ command }) => command.includes(entry));
    assert.equal(named.length, 6);
    for (const { text, command, commandWindows } of named) {
      assert.equal(commandWindows, `& ${command}`);
      assert.equal(command.startsWith("& "), false, "the POSIX command has no call operator");
      // TOML basic strings: a backslash is escaped, a quote is escaped.
      assert.ok(text.includes(`command = ${JSON.stringify(command)}`));
      // The entry path inside the quoted command, backslashes doubled. Derived from
      // the host's own path.join, as the renderer joins every hook-dir path.
      assert.ok(text.includes(`\\"${JSON.stringify(entry).slice(1, -1)}\\"`));
      if (entry.includes("\\")) assert.ok(text.includes(entry.replaceAll("\\", "\\\\")));
    }
    const withoutWindows = renderHooks({ ...options(host, host.pins[0]!), windowsHookCommands: false });
    assert.doesNotMatch(withoutWindows, /^commandWindows = /m);
  });
}

// The migration fixtures turn a current render into the bytes an installer
// before issue #503 wrote. Pinned here against the old command shape built
// directly, independent of the renderer.
test("the legacy fixture reproduces the old checkout-path commands", () => {
  for (const host of HOSTS) {
    const root = host.pins[0]!;
    const hook = (name: string) => [root, "modules", "control-plane", "node", `${name}-hook.mts`].join(host.sep);
    const q = (...parts: string[]) => parts.map((part) => `"${part}"`).join(" ");
    const old = [
      q(host.node, path.join(host.hookDir, "codex-shell-checks.mts"), hook("attribution"), "--runtime", "codex"),
      q(host.node, hook("attribution"), "--runtime", "codex"),
      ...Array.from({ length: 4 }, () => q(host.node, hook("deliver"), "--runtime", "codex")),
    ];
    const legacy = tables(legacyForm(renderHooks(options(host, root)), root)).map(({ command }) => command)
      .filter((command) => command.includes(`${host.sep}modules${host.sep}control-plane${host.sep}`));
    assert.deepEqual(legacy, old, host.label);
  }
});

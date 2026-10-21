// Issues #587 and #588. docs/HOOKS.md is the hook reference: one table row per
// wired hook. This test reads the wiring the product ships (both Claude settings
// templates, the Codex hook render and the Git hooks the manifest installs) and
// fails when a wired hook has no row or two, when a row names a hook nothing
// wires, or when a row's cells break the vocabulary. README.md must link the
// reference from its Documentation table and its Security model section.
// Everything runs in-process: no install, no child process, no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { sameEntryPath, wiredFiles } from "../claude/hooks/lib/hook-inventory.mts";
import { renderHooks, type RenderOptions } from "../codex/lib/parity-config.mts";

const repo = path.resolve(import.meta.dirname, "..");
const HOME = "/synthetic/claude";
const REPO = "/synthetic/repo";
const REFERENCE = "docs/HOOKS.md";
const HEADER = "| Hook | Runtime | Event | Kind | What it does |";
const RUNTIMES = ["Claude", "Codex", "Git", "Control Plane"];
const KINDS = ["blocking guard", "asks operator", "watcher (warns)", "recorder", "context", "gate"];
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), "utf8").replace(/\r\n/g, "\n");

// Test-local copy of singleCommand, claude/hooks/lib/hook-inventory.mts:98-110,
// which stays module-private. The parity test below pins it to the original.
function singleCommand(command: string): boolean {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") { if (c === "'") quote = ""; continue; }
    if (c === "\\" && /['"`$;&|<>\r\n]/.test(command[i + 1] ?? "")) return false;
    if (c === "`" || (c === "$" && command[i + 1] === "(")) return false;
    if (quote === '"') { if (c === '"') quote = ""; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (/[;&|<>\r\n]/.test(c)) return false;
  }
  return quote === "";
}

// One template command: a managed hook behind the hook runtime entry (judged by
// wiredFiles alone, as a one-hook settings.json), a Control Plane script run
// directly by node, or neither, which fails.
type Classified = { stems: string[]; controlPlane: boolean } | { error: string };
const TOKENS = /"([^"]*)"|'([^']*)'|(\S+)/g; // the quoting regex of hook-inventory.mts:136
const CONTROL_PLANE = /^\/synthetic\/repo\/modules\/control-plane\/node\/([\w-]+)\.mts$/;
const enoent = Object.assign(new Error("absent"), { code: "ENOENT" });
function wiredAlone(event: string, command: string) {
  return wiredFiles(HOME, (name) => {
    if (name === "settings.json") return JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } });
    throw enoent;
  });
}
function classify(event: string, command: string): Classified {
  const { files, uncoordinated } = wiredAlone(event, command);
  if (files.length) {
    return uncoordinated.length ? { error: `uncoordinated managed hook command under ${event}: ${command}` }
      : { stems: files.map((file) => file.rel.replace(/\.(?:mts|js)$/, "")), controlPlane: false };
  }
  const tokens = [...command.matchAll(TOKENS)].map((match) => match[1] ?? match[2] ?? match[3]!);
  const stem = tokens[0] === "node" ? CONTROL_PLANE.exec(tokens[1] ?? "")?.[1] : undefined;
  if (stem && singleCommand(command)) return { stems: [stem], controlPlane: true };
  return { error: `unclassified wired command under ${event}: ${command}${stem ? " (runs more than one shell command)" : ""}` };
}

type Wired = { stem: string; source: string; runtime: string };
function templateCommands(file: string): { event: string; command: string }[] {
  const text = read(file).replaceAll("__KHEREP_CLAUDE_HOME__", HOME).replaceAll("__KHEREP_REPO__", REPO);
  const hooks = (JSON.parse(text).hooks ?? {}) as Record<string, { hooks?: { command?: unknown }[] }[]>;
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) => (group.hooks ?? [])
    .flatMap((hook) => (typeof hook.command === "string" ? [{ event, command: hook.command }] : []))));
}
function claudeInventory(): { wired: Wired[]; errors: string[] } {
  const wired: Wired[] = [];
  const errors: string[] = [];
  for (const file of ["claude/settings.user.json", "claude/settings.project.json"]) {
    for (const { event, command } of templateCommands(file)) {
      const result = classify(event, command);
      if ("error" in result) { errors.push(`${file}: ${result.error}`); continue; }
      const source = `${file} ${event}${result.controlPlane ? " (Control Plane)" : ""}`;
      for (const stem of result.stems) wired.push({ stem, source, runtime: "Claude" });
    }
  }
  return { wired, errors };
}

// The installer's option set (codex/install.mts): hookDir "" keeps every command
// separator-free, so the stems are the same under path.posix and path.win32.
const CODEX_OPTIONS: RenderOptions = {
  contextHook: "kherep-maestro-context.mts", hookDir: "", node: "node", mcpServers: [],
  controlPlaneHook: `${REPO}/modules/control-plane/node/deliver-hook.mts`,
  messagingClient: { enabled: true, bridge: "mcp-stdio-bridge.mts", intentHook: "mcp-intent-hook.mts", configRoot: "/synthetic/config" },
};
function codexInventory(): Wired[] {
  const out: Wired[] = [];
  let event = "";
  for (const line of renderHooks(CODEX_OPTIONS).split("\n")) {
    event = /^\[\[hooks\.([A-Za-z]+)\]\]$/.exec(line)?.[1] ?? event;
    if (!line.startsWith("command = ")) continue;
    for (const match of line.matchAll(/([\w.-]+)\.mts/g)) {
      out.push({ stem: match[1]!, source: `codex/lib/parity-config.mts renderHooks ${event}`, runtime: "Codex" });
    }
  }
  return out;
}
function gitInventory(): Wired[] {
  return read("bootstrap/manifest/files.txt").split("\n").flatMap((line) => {
    const stem = /^kherep\/githooks\/([^/.]+)$/.exec(line.trim())?.[1];
    return stem ? [{ stem, source: "bootstrap/manifest/files.txt kherep/githooks", runtime: "Git" }] : [];
  });
}
function inventory(): Map<string, { sources: string[]; runtimes: Set<string> }> {
  const claude = claudeInventory().wired;
  const [codex, git] = [codexInventory(), gitInventory()];
  for (const [name, list] of [["Claude templates", claude], ["Codex render", codex], ["Git manifest", git]] as const) {
    assert.ok(list.length > 0, `${name} yielded no wired hook; the read is broken, not the reference`);
  }
  const out = new Map<string, { sources: string[]; runtimes: Set<string> }>();
  for (const { stem, source, runtime } of [...claude, ...codex, ...git]) {
    const entry = out.get(stem) ?? { sources: [], runtimes: new Set<string>() };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    entry.runtimes.add(runtime);
    out.set(stem, entry);
  }
  return out;
}

// docs/HOOKS.md: CommonMark fences are skipped, exactly one header line outside
// them opens the table, the separator follows, and the rows are the consecutive
// lines after it that start with `|`. Cells split on unescaped pipes only.
type Row = { stem: string; cells: string[] };
function cellsOf(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}
function referenceRows(text: string): Row[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headers: number[] = [];
  let fence: { char: string; length: number } | undefined;
  lines.forEach((line, index) => {
    if (fence) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = undefined;
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) fence = { char: open[0]!, length: open.length };
    else if (line.trimEnd() === HEADER) headers.push(index);
  });
  if (headers.length !== 1) throw new Error(`${REFERENCE}: expected exactly one table header "${HEADER}" outside code fences, found ${headers.length}`);
  const start = headers[0]! + 1;
  if (!/^\|(?:\s*:?-{3,}:?\s*\|){5}\s*$/.test(lines[start] ?? "")) throw new Error(`${REFERENCE}: the table header must be followed by a five-column |---| separator`);
  const rows: Row[] = [];
  for (let i = start + 1; i < lines.length && lines[i]!.startsWith("|"); i++) {
    const cells = cellsOf(lines[i]!);
    const stem = /^`([A-Za-z0-9][\w.-]*)`$/.exec(cells[0] ?? "")?.[1];
    if (stem) rows.push({ stem, cells });
  }
  return rows;
}
function cellProblems(row: Row, required: Iterable<string> = []): string[] {
  if (row.cells.length !== 5) return [`row ${row.stem}: ${row.cells.length} cells, expected 5 (write a pipe inside a cell as \\|)`];
  const [, runtime, event, kind, text] = row.cells as [string, string, string, string, string];
  const runtimes = runtime.split(",").map((name) => name.trim());
  const problems: string[] = [];
  if (runtimes.some((name) => !RUNTIMES.includes(name))) problems.push(`row ${row.stem}: Runtime "${runtime}" is not a comma-separated subset of ${RUNTIMES.join(", ")}`);
  for (const name of required) if (!runtimes.includes(name)) problems.push(`row ${row.stem}: Runtime must contain ${name}, a source wires it there`);
  if (!event) problems.push(`row ${row.stem}: Event is empty`);
  if (!KINDS.includes(kind)) problems.push(`row ${row.stem}: Kind "${kind}" is not one of ${KINDS.join(", ")}`);
  if (!text) problems.push(`row ${row.stem}: What it does is empty`);
  return problems;
}
function loadReference(): Row[] {
  const file = path.join(repo, REFERENCE);
  if (!fs.existsSync(file)) assert.fail(`${REFERENCE} is missing: it must hold one table row per wired hook`);
  return referenceRows(read(REFERENCE));
}

const WRAPPER = `node "${HOME}/kherep/hook-runtime/entry.mts"`;
const LOC = `"${HOME}/hooks/loc-watch.mts"`;
const CP = `${REPO}/modules/control-plane/node`;
const stemsOf = (result: Classified): string[] | undefined => ("stems" in result ? result.stems : undefined);
const errorOf = (result: Classified): string => ("error" in result ? result.error : "");

test("the classifier accepts the coordinated wrapper and a direct Control Plane script", () => {
  assert.deepEqual(stemsOf(classify("PostToolUse", `${WRAPPER} reader ${LOC}`)), ["loc-watch"]);
  const guards = ["guard-dispatch", "privacy-boundary-guard", "secret-output-guard", "playwright-file-guard"];
  assert.deepEqual(stemsOf(classify("PreToolUse", `${WRAPPER} pretool ${guards.map((g) => `"${HOME}/hooks/${g}.mts"`).join(" ")}`)), guards);
  assert.deepEqual(stemsOf(classify("SessionStart", `${WRAPPER} writer "${HOME}/hooks/live-hook-integrity.mts"`)), ["live-hook-integrity"]);
  assert.deepEqual(classify("Stop", `node "${CP}/wake-hook.mts" --timeout 86400`), { stems: ["wake-hook"], controlPlane: true });
  for (const { event, command } of templateCommands("claude/settings.user.json").filter(({ command }) => command.includes("/modules/control-plane/node/"))) {
    assert.equal((classify(event, command) as { controlPlane?: boolean }).controlPlane, true, command);
  }
});

test("the classifier rejects uncoordinated managed hook commands and foreign wrappers", () => {
  for (const command of [
    `node "${HOME}/kherep/other/entry.mts" reader ${LOC}`, `node ${LOC}`, `${WRAPPER} run ${LOC}`, `${WRAPPER} reader ${LOC} && echo x`,
    `node "/synthetic/workspace/tools/entry.mts" reader ${LOC}`, `node "${HOME}/hooks/lib/entry.mts" reader ${LOC}`,
  ]) {
    const result = classify("PostToolUse", command);
    assert.equal(stemsOf(result), undefined, command);
    assert.equal(errorOf(result), `uncoordinated managed hook command under PostToolUse: ${command}`);
  }
});

test("the classifier rejects commands that are neither form", () => {
  for (const command of [
    `${WRAPPER} reader`, `${WRAPPER} reader "${HOME}/kherep/x.mts"`, `node "${REPO}/modules/other/x.mts"`, WRAPPER,
    `node ${REPO}/modules/other/new-hook.mts ${CP}/wake-hook.mts`, `"${CP}/wake-hook.mts"`,
  ]) assert.equal(errorOf(classify("Stop", command)), `unclassified wired command under Stop: ${command}`);
  for (const command of [`node "${CP}/wake-hook.mts" --timeout 86400 && node x.mts`, `node "${CP}/deliver-hook.mts"; rm -rf /`]) {
    assert.equal(errorOf(classify("Stop", command)), `unclassified wired command under Stop: ${command} (runs more than one shell command)`);
  }
});

test("the singleCommand copy agrees with the original through wiredFiles", () => {
  const cases: [string, boolean][] = [["", true], [" --timeout 86400", true], [' "R&D"', true], [" && echo x", false],
    ["; echo x", false], [" | cat", false], [" > out", false], ["\n echo x", false], ["`", false], [" $(x)", false], [' \\"', false]];
  for (const [suffix, single] of cases) {
    const command = `${WRAPPER} reader ${LOC}${suffix}`;
    assert.equal(singleCommand(command), single, JSON.stringify(suffix));
    assert.equal(wiredAlone("PostToolUse", command).uncoordinated.length > 0, !single, JSON.stringify(suffix));
  }
});

test("the entry path is case-folded on win32 only", () => {
  const entry = `${HOME}/kherep/hook-runtime/entry.mts`;
  assert.equal(sameEntryPath(`${HOME}/kherep/hook-runtime/Entry.mts`, entry, "linux"), false);
  assert.equal(sameEntryPath(`${HOME}/kherep/hook-runtime/Entry.mts`, entry, "win32"), true);
});

const SEPARATOR = "|---|---|---|---|---|";
const ROW = "| `loc-watch` | Claude, Codex | PostToolUse | watcher (warns) | Warns about long files. |";
const TABLE = `${HEADER}\n${SEPARATOR}\n${ROW}\n`;
const FAKE = "| `fake-hook` | Claude | Stop | gate | x |";
const stems = (text: string): string[] => referenceRows(text).map((row) => row.stem);

test("a reference row claims a stem only in its first cell, inside the one table", () => {
  assert.deepEqual(stems(`The \`fake-hook\` hook is prose.\n\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`${TABLE}| \`a\` \`b\` | Claude | Stop | gate | x |\n| \`a\` hook | Claude | Stop | gate | x |\n`), ["loc-watch"]);
  assert.deepEqual(referenceRows(TABLE.replace(/\n/g, "\r\n")), [{ stem: "loc-watch", cells: cellsOf(ROW) }]);
  assert.deepEqual(stems(`\`\`\`\n${FAKE}\n\`\`\`\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`${TABLE}\n${FAKE}\n`), ["loc-watch"]);
  assert.throws(() => referenceRows(`${TABLE}\n${TABLE}`), /found 2/);
  assert.throws(() => referenceRows("no table"), /found 0/);
});

test("fences follow CommonMark: same character, at least as long, nothing after it", () => {
  const fakeTable = `${HEADER}\n${SEPARATOR}\n${FAKE}`;
  assert.deepEqual(stems(`\`\`\`\`\n\`\`\`\n${fakeTable}\n\`\`\`\`\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`~~~\n\`\`\`\n${fakeTable}\n~~~\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`\`\`\`\nx\n\`\`\`   \n${TABLE}`), ["loc-watch"]);
  assert.throws(() => referenceRows(`\`\`\`\nx\n\`\`\`x\n${TABLE}`), /found 0/);
});

test("cells split on unescaped pipes and follow the vocabulary", () => {
  const escaped = referenceRows(`${HEADER}\n${SEPARATOR}\n| \`main-checkout-guard\` | Claude, Codex | PreToolUse Bash\\|PowerShell, shell dispatcher | blocking guard | Blocks. |\n`)[0]!;
  assert.equal(escaped.cells.length, 5);
  assert.equal(escaped.cells[2], "PreToolUse Bash|PowerShell, shell dispatcher");
  assert.deepEqual(cellProblems(escaped, ["Claude", "Codex"]), []);
  const unescaped = referenceRows(`${HEADER}\n${SEPARATOR}\n| \`main-checkout-guard\` | Claude | PreToolUse Bash|PowerShell | blocking guard | Blocks. |\n`)[0]!;
  assert.equal(unescaped.cells.length, 6);
  assert.match(cellProblems(unescaped).join("\n"), /row main-checkout-guard: 6 cells/);
  const row = (cells: string): Row => referenceRows(`${HEADER}\n${SEPARATOR}\n| \`x\` | ${cells} |\n`)[0]!;
  assert.match(cellProblems(row("Claude | Stop | guard | x")).join(), /Kind "guard"/);
  assert.match(cellProblems(row("Claude, Jira | Stop | gate | x")).join(), /Runtime "Claude, Jira"/);
  assert.match(cellProblems(row("Claude | Stop | gate | x"), ["Codex"]).join(), /must contain Codex/);
  assert.match(cellProblems(row("Claude |  | gate | ")).join("\n"), /Event is empty[\s\S]*What it does is empty/);
});

test("every wired template command is classified", () => {
  assert.deepEqual(claudeInventory().errors, []);
});

test("every wired hook has exactly one row in docs/HOOKS.md", () => {
  const wired = inventory();
  const file = path.join(repo, REFERENCE);
  const rows = fs.existsSync(file) ? referenceRows(read(REFERENCE)) : [];
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.stem, (counts.get(row.stem) ?? 0) + 1);
  const width = Math.max(...[...wired.keys()].map((stem) => stem.length));
  const lines = [...wired].flatMap(([stem, { sources }]) => {
    const n = counts.get(stem) ?? 0;
    return n === 0 ? [`${stem.padEnd(width)}  ${sources.join("; ")}`] : n > 1 ? [`${stem.padEnd(width)}  rows ${n}`] : [];
  });
  if (!lines.length) return;
  assert.fail([fs.existsSync(file) ? `${REFERENCE}: ${lines.length} of ${wired.size} wired hooks lack exactly one row:`
    : `${REFERENCE} is missing; ${lines.length} of ${wired.size} wired hooks have no row:`, ...lines,
  "Fix: add one table row for <stem> to docs/HOOKS.md (first cell: the stem in backticks)."].join("\n"));
});

test("no row in docs/HOOKS.md names a hook nothing wires", () => {
  const wired = inventory();
  const stale = loadReference().filter((row) => !wired.has(row.stem))
    .map((row) => `stale row ${row.stem}: no source wires it; remove the row or re-wire the hook`);
  assert.deepEqual(stale, []);
});

test("every row of docs/HOOKS.md has valid cells", () => {
  const wired = inventory();
  assert.deepEqual(loadReference().flatMap((row) => cellProblems(row, wired.get(row.stem)?.runtimes)), []);
});

test("README.md links the hook reference from Documentation and Security model", () => {
  const sections = new Map(read("README.md").split(/^## /m).slice(1).map((part) => [part.slice(0, part.indexOf("\n")).trim(), part]));
  assert.ok(/^\| \[[^\]]+\]\(docs\/HOOKS\.md(?:#[^)]*)?\)/m.test(sections.get("Documentation") ?? ""),
    "README.md: the Documentation table needs a row linking docs/HOOKS.md");
  assert.ok((sections.get("Security model") ?? "").includes("](docs/HOOKS.md"), "README.md: the Security model section needs a link to docs/HOOKS.md");
});

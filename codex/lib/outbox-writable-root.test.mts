import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  controlPlaneOutbox, managedOutboxRoots, projectOutboxWritableRoot, renderOutboxWritableRoot, scanStringArray,
} from "./outbox-writable-root.mts";

const START = "# BEGIN KHEREP";
const END = "# END KHEREP";
const OUTBOX = path.resolve("/synthetic/kherep/control-plane/outbox");
const ENTRY = JSON.stringify(OUTBOX);
const BLOCK = `${START}\n# managed\n${END}\n`;
const headers = (config: string): number => config.match(/^\s*\[\s*sandbox_workspace_write\s*\]/gm)?.length ?? 0;
const project = (config: string) => projectOutboxWritableRoot(config, OUTBOX, START, END);

test("the outbox is the node directory's control-plane/outbox and honours KHEREP_CONFIG_DIR", () => {
  const dir = path.resolve("/synthetic/config");
  assert.equal(controlPlaneOutbox({ KHEREP_CONFIG_DIR: dir }, "linux"), path.join(dir, "control-plane", "outbox"));
  assert.equal(controlPlaneOutbox({ APPDATA: path.resolve("/synthetic/roaming") }, "win32"),
    path.join(path.resolve("/synthetic/roaming"), "kherep", "control-plane", "outbox"));
  assert.equal(controlPlaneOutbox({ XDG_CONFIG_HOME: path.resolve("/synthetic/xdg") }, "linux"),
    path.join(path.resolve("/synthetic/xdg"), "kherep", "control-plane", "outbox"));
});

test("without an operator definition the managed block carries the table and the config is unchanged", () => {
  const config = `model = "x"\n\n[features]\nhooks = true\n\n${BLOCK}`;
  assert.deepEqual(project(config), { config, status: "managed", managedTable: true });
  assert.equal(renderOutboxWritableRoot(OUTBOX), `[sandbox_workspace_write]\nwritable_roots = [${ENTRY}]`);
  // Tables with the same prefix or under a profile are other tables.
  const other = `[sandbox_workspace_write_extra]\nx = 1\n\n[profiles.fast.sandbox_workspace_write]\nnetwork_access = true\n\n${BLOCK}`;
  assert.equal(project(other).status, "managed");
});

test("an operator table gets the outbox appended; no entry of the operator is removed", () => {
  const cases: Array<[string, string]> = [
    ['writable_roots = ["/operator/a"]', `writable_roots = ["/operator/a", ${ENTRY}]`],
    ["writable_roots = []", `writable_roots = [${ENTRY}]`],
    ['writable_roots = [\n  "/operator/a", # cache\n  \'C:\\literal\',\n]',
      `writable_roots = [\n  "/operator/a", # cache\n  'C:\\literal', ${ENTRY},\n]`],
    ['writable_roots = [ "/operator/a" # last\n]', `writable_roots = [ "/operator/a", ${ENTRY} # last\n]`],
  ];
  for (const [before, after] of cases) {
    const config = `[sandbox_workspace_write]\nnetwork_access = false\n${before}\n\n[features]\nhooks = true\n\n${BLOCK}`;
    const result = project(config);
    assert.equal(result.status, "operator-merged", before);
    assert.equal(result.managedTable, false);
    assert.equal(result.config, config.replace(before, after));
    assert.equal(headers(result.config), 1);
    assert.deepEqual(project(result.config), { config: result.config, status: "operator-present", managedTable: false });
  }
});

test("an operator table without writable_roots gets the key right after its header, also after the block", () => {
  const config = `[sandbox_workspace_write]\nnetwork_access = true\n\n${BLOCK}`;
  assert.equal(project(config).config,
    `[sandbox_workspace_write]\nwritable_roots = [${ENTRY}]\nnetwork_access = true\n\n${BLOCK}`);
  const trailing = `${BLOCK}\n[sandbox_workspace_write] # mine\r\nexclude_slash_tmp = true\r\n`;
  const result = project(trailing);
  assert.equal(result.status, "operator-merged");
  assert.equal(result.config, `${BLOCK}\n[sandbox_workspace_write] # mine\r\nwritable_roots = [${ENTRY}]\r\nexclude_slash_tmp = true\r\n`);
  assert.equal(project(`[sandbox_workspace_write]`).config, `[sandbox_workspace_write]\nwritable_roots = [${ENTRY}]\n`);
});

test("top-level dotted keys are merged as dotted keys, never with a second table", () => {
  const roots = `sandbox_workspace_write.writable_roots = ["/operator/a"]\nmodel = "x"\n\n${BLOCK}`;
  assert.equal(project(roots).config, `sandbox_workspace_write.writable_roots = ["/operator/a", ${ENTRY}]\nmodel = "x"\n\n${BLOCK}`);
  const other = `model = "x"\nsandbox_workspace_write.network_access = true\n\n[features]\nhooks = true\n\n${BLOCK}`;
  const result = project(other);
  assert.equal(result.status, "operator-merged");
  assert.equal(result.config, `model = "x"\nsandbox_workspace_write.writable_roots = [${ENTRY}]\n`
    + `sandbox_workspace_write.network_access = true\n\n[features]\nhooks = true\n\n${BLOCK}`);
  assert.equal(headers(result.config), 0);
  // A dotted key inside another table is not the top-level table.
  assert.equal(project(`[profiles.fast]\nsandbox_workspace_write.network_access = true\n\n${BLOCK}`).status, "managed");
});

test("what cannot be merged without rewriting operator text is left alone and reported", () => {
  const cases: Array<[string, string]> = [
    ['sandbox_workspace_write = { network_access = true }\n', "skipped-inline-table"],
    ['default_permissions = ":workspace"\n', "skipped-default-permissions"],
    ['[sandbox_workspace_write]\nwritable_roots = """/a"""\n', "skipped-unparseable"],
    ['[sandbox_workspace_write]\nwritable_roots = "/a"\n', "skipped-unparseable"],
    ['[sandbox_workspace_write]\nwritable_roots = ["/a" "/b"]\n', "skipped-unparseable"],
    ['[sandbox_workspace_write]\nwritable_roots = [["/a"]]\n', "skipped-unparseable"],
    ['[sandbox_workspace_write]\nwritable_roots = ["/a"\n', "skipped-unparseable"],
  ];
  for (const [operator, status] of cases) {
    const config = `${operator}\n${BLOCK}`;
    assert.deepEqual(project(config), { config, status, managedTable: false }, operator);
  }
});

test("the string-array scanner decodes basic strings and keeps literal strings raw", () => {
  const text = 'x = ["C:\\\\Users\\\\a", \'C:\\raw\', "q\\"uote"]';
  assert.deepEqual(scanStringArray(text, text.indexOf("=") + 1)?.values, ["C:\\Users\\a", "C:\\raw", 'q"uote']);
});

test("the outbox a managed block names is read back for recognition", () => {
  const block = `${START}\n# header\n\n${renderOutboxWritableRoot("C:\\Users\\x\\outbox")}\n\n[[hooks.Stop]]\n${END}`;
  assert.deepEqual(managedOutboxRoots(block, START, END), ["C:\\Users\\x\\outbox"]);
  assert.deepEqual(managedOutboxRoots(`${renderOutboxWritableRoot("/outside")}\n${BLOCK}`, START, END), []);
});

import assert from "node:assert/strict";
import test from "node:test";

import { BAD_THREAD_ID, NESTED_RUNTIME, NO_SESSION, runtimeIdentity, TASK_THREAD_MISMATCH } from "./runtime-identity.mts";
import { claudeUnderCodex, codexUnderClaude, NESTED_ENV, table, THREAD } from "./runtime-fixture.mts";

// Issue #471: the runtime of the calling process decides first, then its identity.
const LEAF = 400;
const OTHER_THREAD = "019a2b3c-4d5e-7f60-8123-000000000099";
const untouched = () => { throw new Error("the process table must not be read"); };

test("a Codex thread with an inherited Claude Code id resolves the Codex thread when codex is the nearest ancestor (issue #471)", () => {
  assert.deepEqual(runtimeIdentity(NESTED_ENV, { pid: LEAF, processTable: () => codexUnderClaude(LEAF), platform: "darwin" }),
    { ok: true, runtime: "codex", id: THREAD, source: "CODEX_THREAD_ID" });
});

test("a Claude Code id with an inherited Codex thread resolves the Claude session when CLAUDE_PID is the nearest ancestor (reverse case)", () => {
  assert.deepEqual(runtimeIdentity(NESTED_ENV, { pid: LEAF, processTable: () => claudeUnderCodex(LEAF), platform: "darwin" }),
    { ok: true, runtime: "claude", id: "s-self", source: "CLAUDE_CODE_SESSION_ID" });
});

test("both markers without a decidable ancestry refuse with the fixed nested-runtime reason and never fall back", () => {
  const refused = { ok: false, code: "nested-undecided", error: NESTED_RUNTIME };
  assert.deepEqual(runtimeIdentity(NESTED_ENV, { pid: LEAF, processTable: () => null }), refused);
  // Thirteen shells between the leaf and the codex process: beyond the walk's bound.
  const shells: [number, number, string][] = Array.from({ length: 13 }, (_, i) => [1000 + i, 1001 + i, "/bin/bash"]);
  const deep = table([[LEAF, 1000, "node msg"], ...shells, [1013, 1, "codex exec"]]);
  assert.deepEqual(runtimeIdentity(NESTED_ENV, { pid: LEAF, processTable: () => deep }), refused);
  // A command line that cannot be read could hide a codex: no guess past it.
  const unreadable = table([[LEAF, 300, "node msg"], [300, 200, null], [200, 1, "codex exec"]]);
  assert.deepEqual(runtimeIdentity(NESTED_ENV, { pid: LEAF, processTable: () => unreadable }), refused);
  // Without CLAUDE_PID the Claude Code process cannot be placed in the chain.
  const { CLAUDE_PID: _, ...noPid } = NESTED_ENV;
  assert.deepEqual(runtimeIdentity(noPid, { pid: LEAF, processTable: untouched }), refused);
});

test("only CLAUDE_CODE_SESSION_ID, with CODEX_COMPANION_* names present, is a Claude session without reading the process table", () => {
  const env = { CLAUDE_CODE_SESSION_ID: "s-self", CLAUDE_PID: "100", CODEX_COMPANION_SESSION_ID: "x", CODEX_COMPANION_TRANSCRIPT_PATH: "/tmp/t" };
  assert.deepEqual(runtimeIdentity(env, { processTable: untouched }),
    { ok: true, runtime: "claude", id: "s-self", source: "CLAUDE_CODE_SESSION_ID" });
  assert.deepEqual(runtimeIdentity({ CODEX_THREAD_ID: THREAD }, { processTable: untouched }),
    { ok: true, runtime: "codex", id: THREAD, source: "CODEX_THREAD_ID" });
  assert.deepEqual(runtimeIdentity({}, { processTable: untouched }), { ok: false, code: "none", error: NO_SESSION });
});

test("KHEREP_SESSION_ID alone is a node Codex run; with a matching or unknown task thread it stays the identity; with another thread it is refused", () => {
  const node = { ok: true, runtime: "codex", id: "task-00000000", source: "KHEREP_SESSION_ID" };
  assert.deepEqual(runtimeIdentity({ KHEREP_SESSION_ID: "task-00000000" }, { processTable: untouched }), node);
  const env = { KHEREP_SESSION_ID: "task-00000000", CODEX_THREAD_ID: THREAD };
  assert.deepEqual(runtimeIdentity(env, { processTable: untouched, taskThreadOf: () => undefined }), node);
  assert.deepEqual(runtimeIdentity(env, { processTable: untouched, taskThreadOf: () => THREAD }), node);
  assert.deepEqual(runtimeIdentity(env, { processTable: untouched, taskThreadOf: () => OTHER_THREAD }),
    { ok: false, code: "task-thread-mismatch", error: TASK_THREAD_MISMATCH });
});

test("a CODEX_THREAD_ID that cannot name a file is refused", () => {
  assert.deepEqual(runtimeIdentity({ CODEX_THREAD_ID: "../escape" }, { processTable: untouched }),
    { ok: false, code: "bad-thread-id", error: BAD_THREAD_ID });
});

test("the Windows program match recognises codex.exe in a quoted command line", () => {
  const windows = table([[100, 1, "\"C:\\Program Files\\Claude\\claude.exe\""], [150, 100, "C:\\Git\\bin\\bash.exe -c codex"],
    [200, 150, "\"C:\\Users\\x\\AppData\\Local\\Codex Bin\\Codex.EXE\" exec --sandbox workspace-write"],
    [300, 200, "powershell.exe -NoProfile -Command node cli.mts"], [LEAF, 300, "node.exe cli.mts msg send"]]);
  const env = { ...NESTED_ENV, CLAUDE_PID: "100" };
  assert.deepEqual(runtimeIdentity(env, { pid: LEAF, processTable: () => windows, platform: "win32" }),
    { ok: true, runtime: "codex", id: THREAD, source: "CODEX_THREAD_ID" });
});

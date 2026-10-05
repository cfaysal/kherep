import assert from "node:assert/strict";
import test from "node:test";

import type { DirectoryBody } from "../protocol-messages.mts";
import { cwdProblem, MSYS_HINT, nodePathStyle } from "./cwd-guard.mts";
import { writeDirectory } from "./exchange.mts";
import { runMsg } from "./msg-cli.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { requestIds } from "./task-records.mts";

// Issue #240: msg send --new --cwd refuses, before writing a request, a
// directory that cannot be a path on the target node.

const SELF = "00000000-0000-4000-8000-0000000000aa";
const MAC = "00000000-0000-4000-8000-0000000000bb";
const WIN = "00000000-0000-4000-8000-0000000000cc";
const NEW = "00000000-0000-4000-8000-0000000000dd";
const session = (nodeId: string, cwd: string) => ({ nodeId, sessionId: `s-${cwd.length}-${nodeId.slice(-2)}`, runtime: "claude-code", state: "idle", cwd });
const DIRECTORY: DirectoryBody = {
  nodes: [{ nodeId: SELF, name: "n", status: "online" }, { nodeId: MAC, name: "mac", status: "online" },
    { nodeId: WIN, name: "win", status: "online" }, { nodeId: NEW, name: "fresh", status: "online" }],
  sessions: [session(MAC, "/Users/a/repo"), session(MAC, "/Users/a/other"), session(WIN, "C:\\Users\\a\\repo")],
  fetchedAt: new Date(T0).toISOString(),
};

test("the path style of a node comes from the working directories of its listed sessions", () => {
  assert.equal(nodePathStyle(DIRECTORY, MAC), "posix");
  assert.equal(nodePathStyle(DIRECTORY, WIN), "windows");
  assert.equal(nodePathStyle(DIRECTORY, NEW), null, "no sessions listed");
  const mixed = { ...DIRECTORY, sessions: [...DIRECTORY.sessions, session(MAC, "D:/x")] };
  assert.equal(nodePathStyle(mixed, MAC), null, "disagreeing sessions");
});

test("an MSYS-rewritten path is refused for any target, a foreign path style for a known one", () => {
  for (const cwd of ["C:/Program Files/Git/Users/a/probe-198", "c:\\Program Files (x86)\\Git\\home\\a",
    "C:/Users/a/AppData/Local/Programs/Git/Users/a/x", "C:/Users/a/scoop/apps/git/current/tmp/x"]) {
    for (const style of ["posix", "windows", null] as const) {
      const problem = cwdProblem(cwd, "mac", style);
      assert.match(problem ?? "", /rewritten by Git Bash/, `${cwd} ${style}`);
      assert.ok(problem?.includes("PowerShell") && problem.includes("MSYS_NO_PATHCONV=1"));
    }
  }
  assert.match(cwdProblem("C:/Users/a/probe", "mac", "posix") ?? "", /Windows path, but mac uses POSIX paths/);
  // A UNC share in forward-slash form is a Windows path, not a POSIX one.
  assert.equal(cwdProblem("//server/share/repo", "win", "windows"), null);
  assert.match(cwdProblem("//server/share/repo", "mac", "posix") ?? "", /Windows path, but mac uses POSIX paths/);
  assert.match(cwdProblem("D:\\work", "mac", "posix") ?? "", new RegExp(MSYS_HINT));
  assert.match(cwdProblem("/Users/a/probe", "win", "windows") ?? "", /POSIX path, but win uses Windows paths/);
  for (const [cwd, style] of [["/Users/a/probe", "posix"], ["C:\\Users\\a\\repo", "windows"], ["C:/Users/a/probe", null],
    ["/Users/a/probe", null], ["C:/Program Files/Gitea/x", "windows"]] as const) {
    assert.equal(cwdProblem(cwd, "t", style), null, `${cwd} ${style}`);
  }
});

async function send(t: test.TestContext, target: string, cwd: string) {
  const node = taskNode(t, { delegate: { request: true } });
  writeDirectory(node.paths, DIRECTORY);
  const out: string[] = [];
  const err: string[] = [];
  let clock = T0;
  const code = await runMsg(["send", target, "--new", "codex", "--directive", "yes", "--cwd", cwd, "--wait", "0", "--", "hello"], {
    paths: node.paths, env: { CLAUDE_CODE_SESSION_ID: "maestro" }, now: () => clock, out: (l) => out.push(l), err: (l) => err.push(l),
    sleep: async (ms) => { clock += ms; },
  });
  return { code, out, err, requests: requestIds(node.paths) };
}

test("msg send --new refuses an invalid --cwd before writing any request", async (t) => {
  const msys = await send(t, "mac", "C:/Program Files/Git/Users/a/probe-198");
  assert.equal(msys.code, 1);
  assert.deepEqual(msys.requests, [], "no request written");
  assert.match(msys.err[0], /^kherep-node msg: --cwd "C:\/Program Files\/Git\/Users\/a\/probe-198" looks rewritten by Git Bash/);
  assert.match(msys.err[0], /PowerShell.*MSYS_NO_PATHCONV=1/);

  const drive = await send(t, "mac", "C:/Users/a/probe-198");
  assert.deepEqual([drive.code, drive.requests], [1, []]);
  assert.match(drive.err[0], /Windows path, but mac uses POSIX paths/);

  const posix = await send(t, "win", "/Users/a/probe-198");
  assert.deepEqual([posix.code, posix.requests], [1, []]);
});

test("msg send --new writes the request for a valid --cwd", async (t) => {
  for (const [target, cwd] of [["mac", "/Users/a/probe-198"], ["win", "C:\\Users\\a\\probe"], ["fresh", "C:/Users/a/probe"]]) {
    const sent = await send(t, target, cwd);
    assert.equal(sent.requests.length, 1, `${target} ${cwd}: ${sent.err.join(" ")}`);
  }
});

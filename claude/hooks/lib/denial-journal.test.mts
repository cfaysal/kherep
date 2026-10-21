// Issue #504. The write side of the denied-call journal: line fields, target classes, reason
// redaction, the agent_id gate, and the fallback chain under failing and stalled writers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  callLine, journalPaths, journalVerdict, markCaptureFailed, PRIVATE_MARKER_PATTERN, redactReason, targetOf, guardOf, WITHHELD,
  type Fsp,
} from "./denial-journal.mts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const home = (): string => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "denial-journal-")); roots.push(root); return root; };
// A marker term taken from the pattern itself, so this file names none.
const MARK = PRIVATE_MARKER_PATTERN.source.split("|").pop()!;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`injected ${code}`), { code });
const never = (): Promise<never> => new Promise<never>(() => {});
const seam = (over: Partial<Fsp>): Fsp => ({ mkdir: fs.promises.mkdir, appendFile: fs.promises.appendFile, rename: fs.promises.rename, ...over });
const deny = (reason: string, broken = false) => ({ decision: "deny", reason, broken });
const bash = (command: string, extra: Record<string, unknown> = {}) =>
  ({ agent_id: "a1", agent_type: "general-purpose", tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { command }, cwd: "/w", ...extra });

test("the marker sample matches the pattern", () => assert.match(MARK, PRIVATE_MARKER_PATTERN));

test("a call line carries the decision, agent_type and one denial per denying verdict", () => {
  const line = JSON.parse(callLine(bash("git commit -m x"), [deny("commit-guard blocked this commit:\n - bullet"),
    deny("[guard-dispatch] /h/hooks/x.mts cannot run (missing); the tool call is blocked", true), { decision: "allow", reason: "" }]));
  assert.equal(line.v, 1);
  assert.equal(line.kind, "call");
  assert.equal(line.id, "toolu_1");
  assert.equal(line.tool, "Bash");
  assert.equal(line.agent_type, "general-purpose");
  assert.equal(line.decision, "deny");
  assert.deepEqual(line.denials, [
    { guard: "commit-guard", target: "git", reason: "commit-guard blocked this commit:", broken: false },
    { guard: "guard-dispatch", target: "git", reason: "[guard-dispatch] x.mts cannot run (missing); the tool call is blocked", broken: true },
  ]);
  assert.ok(!JSON.stringify(line).includes("bullet"), "only the first line of a reason");
});

test("a tool_use_id that is no string is null, never a skip; no denial is decision none or allow", () => {
  assert.equal(JSON.parse(callLine(bash("ls", { tool_use_id: 7 }), [])).id, null);
  assert.equal(JSON.parse(callLine(bash("ls"), [])).decision, "none");
  assert.equal(JSON.parse(callLine(bash("ls"), [{ decision: "allow" }])).decision, "allow");
  assert.equal(JSON.parse(callLine(bash("ls"), [{ decision: "ask", reason: "r" }])).decision, "ask");
});

test("shell targets: environment assignments skipped, the program's basename, else -", () => {
  assert.equal(targetOf(bash("FOO=1 BAR=x /usr/local/bin/git push")), "git");
  assert.equal(targetOf(bash("$env:KHEREP_DEPLOY_AUTH='approved'; npm run deploy", { tool_name: "PowerShell" })), "npm");
  assert.equal(targetOf(bash("'C:\\Program Files\\x\\tool.exe' -v")), "tool.exe");
  assert.equal(targetOf(bash("\"/opt/my app/run\" now")), "run");
  assert.equal(targetOf(bash("\"/opt/unterminated")), "-");
  assert.equal(targetOf(bash("x".repeat(41))), "-");
  assert.equal(targetOf({ tool_name: "shell_command", tool_input: { command: "rm -rf /" } }), "rm");
});

test("file targets are relative to cwd inside it, else <outside cwd>", () => {
  const read = (file_path: unknown, cwd: unknown = "/w/repo") => targetOf({ tool_name: "Read", tool_input: { file_path }, cwd });
  assert.equal(read("/w/repo/src/a.mts"), "src/a.mts");
  assert.equal(read("src/b.mts"), "src/b.mts");
  assert.equal(read("/w/other/a.mts"), "<outside cwd>");
  assert.equal(read("/w/repo/../other/a.mts"), "<outside cwd>");
  assert.equal(read("/w/repo"), "<outside cwd>");
  assert.equal(read("C:\\w\\repo\\x.txt", "C:\\w\\repo"), "x.txt");
  assert.equal(read("/w/repo/a.mts", null), "<outside cwd>");
  assert.equal(read(undefined), "-");
  assert.equal(targetOf({ tool_name: "Grep", tool_input: { path: "/w/repo/lib" }, cwd: "/w/repo" }), "lib");
});

test("apply_patch, agent and MCP targets", () => {
  const patch = "*** Begin Patch\n*** Update File: src/c.mts\n@@\n-a\n+b\n*** End Patch";
  assert.equal(targetOf({ tool_name: "apply_patch", tool_input: patch, cwd: "/w" }), "src/c.mts");
  assert.equal(targetOf({ tool_name: "apply_patch", tool_input: "no header", cwd: "/w" }), "-");
  assert.equal(targetOf({ tool_name: "Agent", tool_input: { subagent_type: "kherep-builder", prompt: "secret brief" } }), "kherep-builder");
  assert.equal(targetOf({ tool_name: "spawn_agent", tool_input: { agent_type: "bad type!" } }), "-");
  assert.equal(targetOf({ tool_name: "mcp__srv__executeDestructive", tool_input: { x: 1 } }), "mcp__srv__executeDestructive");
  assert.equal(targetOf({ tool_name: "WebFetch", tool_input: { url: "https://example.com" } }), "-");
});

test("privacy denials and marker-matching targets are <withheld>", () => {
  const read = { agent_id: "a1", tool_name: "Read", tool_input: { file_path: `/w/${MARK}/notes.txt` }, cwd: "/w" };
  assert.equal(targetOf(read), WITHHELD);
  const plain = { ...read, tool_input: { file_path: "/w/notes.txt" } };
  const [denial] = JSON.parse(callLine(plain, [deny("[privacy-boundary] Private paths may not enter Claude file tools.")])).denials;
  assert.equal(denial.target, WITHHELD);
  assert.equal(denial.guard, "privacy-boundary");
});

test("reasons: absolute paths of every form reduced to their basename", () => {
  assert.equal(redactReason("cannot read \"/Users/x/file.mts\" now"), "cannot read \"file.mts\" now");
  // A space ends a path: the absolute head is reduced, the relative rest stays.
  assert.equal(redactReason("cannot read \"/Users/x/a b/c.mts\""), "cannot read \"a b/c.mts\"");
  assert.equal(redactReason("blocked (/home/u/repo/file.txt) and `/etc/hosts`"), "blocked (file.txt) and `hosts`");
  assert.equal(redactReason("share \\\\server\\share\\dir\\x.cfg is held"), "share x.cfg is held");
  assert.equal(redactReason("drive C:\\Users\\u\\y.json and D:/a/z.txt;"), "drive y.json and z.txt;");
  assert.equal(redactReason("home ~/.claude/hooks/g.mts, done"), "home g.mts, done");
  assert.equal(redactReason("relative a/b and 1/2 stay"), "relative a/b and 1/2 stay");
});

test("reasons: a marker-matching line is <withheld>, control characters go, 240 characters at most", () => {
  assert.equal(redactReason(`path with ${MARK} inside`), WITHHELD);
  assert.equal(redactReason("a\tb\u0007c"), "abc");
  assert.equal(redactReason("x".repeat(300)).length, 240);
  assert.equal(redactReason(undefined), "");
});

test("guard tags: bracket tag, else the word before blocked, else guard", () => {
  assert.equal(guardOf("[secret-output] Command output may contain a secret"), "secret-output");
  assert.equal(guardOf("main-checkout-guard blocked this command:\n - git"), "main-checkout-guard");
  assert.equal(guardOf("/h/hooks/deploy-guard.mts blocked this tool call without giving a reason"), "deploy-guard.mts");
  assert.equal(guardOf("no tag at all"), "guard");
  assert.equal(guardOf(`[${MARK}] x`), "guard");
});

test("a line that would pass 1 KiB is cut: reasons and targets at 80 characters", () => {
  const reasons = Array.from({ length: 6 }, (_, i) => deny(`[g${i}] ${"r".repeat(230)}`));
  const line = callLine(bash("git status"), reasons);
  assert.ok(Buffer.byteLength(callLine(bash("ls"), reasons.slice(0, 2))) <= 1023, "two full reasons fit");
  assert.equal(JSON.parse(callLine(bash("ls"), reasons.slice(0, 2))).denials[0].reason.length, 235);
  assert.ok(JSON.parse(line).denials.every((d: { reason: string }) => d.reason.length <= 80));
});

test("journalVerdict writes one line for a delegated call and nothing without a valid agent_id or for the handback", async () => {
  const root = home();
  const until = Date.now() + 1_500;
  assert.equal(await journalVerdict(root, bash("ls"), [deny("[x] no")], until), "");
  assert.equal(await journalVerdict(root, bash("ls", { agent_id: "../escape" }), [deny("[x] no")], until), "");
  assert.equal(await journalVerdict(root, bash("ls", { agent_id: undefined }), [deny("[x] no")], until), "");
  assert.equal(await journalVerdict(root, bash("ls", { tool_name: "SubagentHandback" }), [deny("[x] no")], until), "");
  const { dir, journal } = journalPaths(root, "a1");
  assert.deepEqual(fs.readdirSync(dir), ["a1.jsonl"]);
  const lines = fs.readFileSync(journal, "utf8").split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).denials[0].guard, "x");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test("journalVerdict names the failure: mkdir, append (ENOSPC, EACCES, EROFS) and a writer that never settles", async () => {
  const root = home();
  const until = () => Date.now() + 300;
  assert.equal(await journalVerdict(root, bash("ls"), [], until(), seam({ mkdir: () => Promise.reject(errno("EACCES")) })), "mkdir");
  for (const code of ["ENOSPC", "EACCES", "EROFS"]) {
    assert.equal(await journalVerdict(root, bash("ls"), [], until(), seam({ appendFile: () => Promise.reject(errno(code)) })), "append");
  }
  const thrown = seam({ appendFile: () => { throw errno("EIO"); } });
  assert.equal(await journalVerdict(root, bash("ls"), [], until(), thrown), "append");
  const start = Date.now();
  assert.equal(await journalVerdict(root, bash("ls"), [], Date.now() + 200, seam({ appendFile: never })), "append-timeout");
  assert.ok(Date.now() - start < 1_000, `returned after ${Date.now() - start} ms`);
});

test("markCaptureFailed: a marker line, else the journal renamed, retried while held, false when both fail", async () => {
  const root = home();
  const { dir, journal, marker } = journalPaths(root, "a1");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(await markCaptureFailed(root, "a1", "append", Date.now() + 400), true);
  assert.equal(fs.readFileSync(marker, "utf8"), "append\n");
  fs.rmSync(marker);
  fs.writeFileSync(journal, "{}\n");
  const noAppend = { appendFile: () => Promise.reject(errno("ENOSPC")) };
  assert.equal(await markCaptureFailed(root, "a1", "append", Date.now() + 400, seam(noAppend)), true);
  assert.equal(fs.existsSync(journal), false);
  assert.equal(fs.readFileSync(marker, "utf8"), "{}\n", "the renamed journal is the marker");
  fs.rmSync(marker);
  fs.writeFileSync(journal, "{}\n");
  let tries = 0;
  const held = seam({ ...noAppend, rename: (a, b) => (++tries < 3 ? Promise.reject(errno("EBUSY")) : fs.promises.rename(a, b)) });
  assert.equal(await markCaptureFailed(root, "a1", "append", Date.now() + 400, held), true);
  assert.equal(tries, 3);
  const both = seam({ ...noAppend, rename: () => Promise.reject(errno("ENOSPC")) });
  assert.equal(await markCaptureFailed(root, "a1", "append", Date.now() + 400, both), false);
  const start = Date.now();
  assert.equal(await markCaptureFailed(root, "a1", "append", Date.now() + 150, seam({ appendFile: never, rename: never })), false);
  assert.ok(Date.now() - start < 1_000);
});

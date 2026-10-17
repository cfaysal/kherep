import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { AppServerRequestError } from "./codex-app-server-client.mts";
import { FORK_OWNER, LAST_TURN, type ForkScenario } from "./codex-fork-fixture.mts";
import { FORK_RPC_OVERLONG_BYTES, forkRpcError, type ForkRpcMethod } from "./codex-fork-refusal.mts";
import { runFork } from "./codex-fork-run-fixture.mts";
import { serviceAdmissionsIdle } from "./service-drain.mts";
import { testServiceOwner } from "./task-fixture.mts";

// Issue #477: a refused JSON-RPC request of a fork attempt becomes one local log
// line of content-free metadata. No process and no file: the formatter is pure,
// and the run-level tests below use the in-memory fake app-server.

const OWNER = FORK_OWNER, TURN = LAST_TURN;
const CTX = { owner: OWNER, cwd: "/synthetic/work/repo", producer: { resolvedCodexHome: "/synthetic/codex-home" } };
const hash = (text: string): string => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 12);
const refused = (error: unknown, method: ForkRpcMethod = "thread/fork", lastTurnId?: string, ctx = CTX) =>
  forkRpcError(method, new AppServerRequestError(method, error), ctx, lastTurnId);
const LINE = /^kherep-node: Codex fork helper refused (initialize|thread\/read|thread\/turns\/list|thread\/fork) \(code (-?\d+|none), (missing|empty|text|overlong), sha256 [0-9a-f]{12}, mentions ([a-z-]+(,[a-z-]+)*|none)\)$/;

test("the exact line of a plain refusal, and nothing but the line is returned", () => {
  const result = refused({ code: -32600, message: "cannot fork" });
  assert.deepEqual(Object.keys(result), ["line"]);
  assert.equal(result.line, `kherep-node: Codex fork helper refused thread/fork (code -32600, text, sha256 ${hash("cannot fork")}, mentions none)`);
  assert.match(result.line, LINE);
  for (const method of ["initialize", "thread/read", "thread/turns/list"] as const) {
    assert.match(refused({ code: -1, message: "no" }, method).line, new RegExp(`refused ${method.replace("/", "\\/")} \\(code -1, `));
  }
});

test("shape: missing for a non-string message, empty, text up to the byte limit, overlong past it in UTF-8 bytes", () => {
  const shape = (message: unknown): string => refused({ code: -32600, message }).line.match(LINE)![3]!;
  assert.equal(shape(7), "missing");
  assert.equal(shape(undefined), "missing");
  assert.equal(shape({ text: "nested" }), "missing");
  assert.equal(shape(""), "empty");
  assert.equal(shape("x".repeat(FORK_RPC_OVERLONG_BYTES)), "text");
  assert.equal(shape("x".repeat(FORK_RPC_OVERLONG_BYTES + 1)), "overlong");
  assert.equal(shape("\u00e9".repeat(FORK_RPC_OVERLONG_BYTES / 2 + 1)), "overlong", "2050 characters, 4100 bytes");
  // A missing or empty message hashes the empty string.
  assert.match(refused({ code: 1, message: 7 }).line, new RegExp(`sha256 ${hash("")},`));
  assert.match(refused({ code: 1, message: "" }).line, new RegExp(`sha256 ${hash("")},`));
});

test("code: a finite integer is kept, anything else is none; no cause is derived from it", () => {
  const code = (value: unknown): string => refused({ code: value, message: "m" }).line.match(LINE)![2]!;
  assert.equal(code(-32600), "-32600");
  assert.equal(code(0), "0");
  for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "x", "-32600", null, undefined, { code: 1 }]) {
    assert.equal(code(value), "none", String(value));
  }
});

test("sha256 covers the UTF-8 bytes of a unicode and of a multiline message; the line stays one line", () => {
  const unicode = "Ablehnung: G\u00e4nsef\u00fc\u00dfchen \u{1F6AB} \u4e0d\u5141\u8bb8";
  assert.match(refused({ code: -32600, message: unicode }).line, new RegExp(`sha256 ${hash(unicode)},`));
  const multiline = "first line\nsecond line\r\nthird line";
  const line = refused({ code: -32600, message: multiline }).line;
  assert.match(line, new RegExp(`sha256 ${hash(multiline)},`));
  assert.notEqual(hash(multiline), hash("third line"), "not the last line only");
  assert.equal(/[\r\n]/.test(line), false);
});

test("a message with a known-looking prefix, a secret and paths leaves no character of itself in the line", () => {
  const message = "Invalid request: Bearer sk-live_Secret1 at /private/var/canary and C:\\Users\\canary\\secret.txt; data follows";
  const result = refused({ code: -32600, message, data: { canary: "data-canary-7f3a" } });
  assert.match(result.line, LINE);
  for (const text of ["Invalid", "request:", "Bearer", "sk-live", "Secret1", "/private", "canary", "C:\\", "secret.txt", "data", "7f3a"]) {
    assert.equal(JSON.stringify(result).includes(text), false, text);
  }
});

test("mentions: owner, turn, cwd in both slash forms, codex home and kherep, without case, deduplicated in list order", () => {
  const mentions = (message: string, lastTurnId?: string, ctx = CTX): string =>
    refused({ code: -32600, message }, "thread/fork", lastTurnId, ctx).line.match(LINE)![4]!;
  assert.equal(mentions("cannot fork"), "none");
  assert.equal(mentions(`thread ${OWNER.toUpperCase()} refused`), "owner");
  assert.equal(mentions(`turn ${TURN} not found`, TURN), "turn");
  assert.equal(mentions(`turn ${TURN} not found`), "none", "no turn known yet");
  assert.equal(mentions("cwd /synthetic/work/repo differs"), "cwd");
  assert.equal(mentions("cwd \\synthetic\\work\\repo differs"), "cwd");
  const windows = { ...CTX, cwd: "C:\\Synthetic\\Work" };
  assert.equal(mentions("cwd c:/synthetic/work differs", undefined, windows), "cwd");
  assert.equal(mentions("cwd C:\\Synthetic\\Work differs", undefined, windows), "cwd");
  assert.equal(mentions("home /synthetic/codex-home/sessions"), "codex-home");
  assert.equal(mentions("client KHEREP_fork_reply unsupported"), "kherep");
  assert.equal(mentions(`kherep ${TURN} /synthetic/work/repo ${OWNER} \\synthetic\\work\\repo ${OWNER} /synthetic/codex-home`, TURN),
    "owner,turn,cwd,codex-home,kherep");
  assert.equal(mentions("empty context", undefined, { owner: "", cwd: "", producer: { resolvedCodexHome: "" } }), "none",
    "an empty context string matches nothing");
});

test("a method outside the four fork methods is refused by the formatter", () => {
  assert.throws(() => forkRpcError("turn/start" as ForkRpcMethod, new AppServerRequestError("turn/start", { code: 1, message: "m" }), CTX));
});

// Through runForkAttempt and the fake app-server: the line is logged, the outcome is as before.
const refusals = (logs: string[]): string[] => logs.filter((line) => line.includes("Codex fork helper refused"));
const CANARY_DATA = "data-canary-7f3a";
const canaryMessage = (cwd: string): string => `synthetic refusal canary-text of ${FORK_OWNER} at ${cwd} home /synthetic/codex-home`
  + " token sk-live_Secret1 file /private/var/canary and C:\\Users\\canary\\secret.txt asked: Is the build green?";

test("#477: a refused fork logs its metadata only; the canary set reaches neither the logs nor the outcome", async (t) => {
  let cwd = "";
  // The fork request carries the admitted cwd; the error is read only when it is answered.
  const errors = { get "thread/fork"() { return { code: -32600, message: canaryMessage(cwd), data: { canary: CANARY_DATA } }; } };
  const r = await runFork(t, { errors, onRequest: (method, params) => { if (method === "thread/fork") cwd = params.cwd; } });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "fork-rejected" });
  // The test's temporary directory may itself carry the word kherep, then the cwd is also that mention.
  const kherep = cwd.toLowerCase().includes("kherep") ? ",kherep" : "";
  assert.deepEqual(refusals(r.logs), [`kherep-node: Codex fork helper refused thread/fork (code -32600, text, sha256 ${hash(canaryMessage(cwd))}, `
    + `mentions owner,cwd,codex-home${kherep})`]);
  const egress = [r.logs.join("\n"), JSON.stringify(r.outcome)];
  for (const text of ["canary-text", "sk-live", "Secret1", "/private/var/canary", "C:\\Users\\canary", "secret.txt", CANARY_DATA, FORK_OWNER,
    cwd, "/synthetic/codex-home", "Is the build green?"]) {
    for (const out of egress) assert.equal(out.includes(text), false, text);
  }
  assert.deepEqual([r.run.ended, r.run.signals, r.unconfirmed(), serviceAdmissionsIdle(r.paths, testServiceOwner)], [true, [], 0, true]);
});

test("#477: owner and turn ids in the message are mentions, never echoed; a malformed error is missing with code none", async (t) => {
  const ids = await runFork(t, { errors: { "thread/fork": { code: -32600, message: `no fork of ${FORK_OWNER} at turn ${LAST_TURN}` } } });
  assert.deepEqual(refusals(ids.logs), [`kherep-node: Codex fork helper refused thread/fork (code -32600, text, sha256 ${
    hash(`no fork of ${FORK_OWNER} at turn ${LAST_TURN}`)}, mentions owner,turn)`]);
  assert.equal(ids.logs.some((line) => line.includes(FORK_OWNER) || line.includes(LAST_TURN)), false);
  const malformed = await runFork(t, { errors: { "thread/fork": { message: 7, code: "x" } } });
  assert.deepEqual(malformed.outcome, { state: "failed", from: "launching", reason: "fork-rejected" });
  assert.deepEqual(refusals(malformed.logs), [`kherep-node: Codex fork helper refused thread/fork (code none, missing, sha256 ${hash("")}, mentions none)`]);
});

test("#477: a refused thread/read and initialize name their method; a real cwd mismatch and non-RPC failures write no line", async (t) => {
  const read = await runFork(t, { errors: { "thread/read": { code: -32600, message: "thread not found" } } });
  assert.deepEqual(read.outcome, { state: "failed", from: "launching", reason: "cwd-mismatch" });
  assert.deepEqual(refusals(read.logs), [`kherep-node: Codex fork helper refused thread/read (code -32600, text, sha256 ${hash("thread not found")}, mentions none)`]);
  const init = await runFork(t, { errors: { initialize: { code: -1, message: "no" } } });
  assert.deepEqual(init.outcome, { state: "failed", from: "launching", reason: "initialize" });
  assert.deepEqual(refusals(init.logs), [`kherep-node: Codex fork helper refused initialize (code -1, text, sha256 ${hash("no")}, mentions none)`]);
  const cases: [Partial<ForkScenario>, Record<string, unknown>][] = [
    [{ ownerThread: { cwd: "/elsewhere" } }, { state: "failed", from: "launching", reason: "cwd-mismatch" }],
    [{ ownerThread: { ephemeral: true } }, { state: "failed", from: "launching", reason: "cwd-mismatch" }],
    [{ exitAt: "thread/fork" }, { state: "failed", from: "launching", reason: "helper-exit" }],
    [{ hangAt: "thread/fork" }, { state: "failed", from: "launching", reason: "fork-rejected" }],
    [{ malformedAt: "thread/fork" }, { state: "failed", from: "launching", reason: "fork-rejected" }],
  ];
  for (const [scenario, outcome] of cases) {
    const r = await runFork(t, scenario);
    assert.deepEqual(r.outcome, outcome, JSON.stringify(scenario));
    assert.deepEqual(refusals(r.logs), [], `${JSON.stringify(scenario)}: no refusal line`);
  }
});

test("#477: a throwing logger changes neither the reason, the close nor the lease, also on an unconfirmed close", async (t) => {
  const log = (): void => { throw new Error("synthetic logger failure"); };
  const errors = { "thread/fork": { code: -32600, message: "cannot fork" } };
  const clean = await runFork(t, { errors }, { log });
  assert.deepEqual(clean.outcome, { state: "failed", from: "launching", reason: "fork-rejected" });
  assert.deepEqual([clean.run.ended, clean.run.signals, clean.unconfirmed(), serviceAdmissionsIdle(clean.paths, testServiceOwner)],
    [true, [], 0, true]);
  const stuck = await runFork(t, { errors, ignoreEnd: true, neverExit: true }, { log });
  assert.deepEqual(stuck.outcome, { state: "uncertain", from: "launching", reason: "close-unconfirmed" });
  assert.deepEqual([stuck.run.signals, stuck.unconfirmed()], [["SIGKILL"], 1]);
  assert.equal(serviceAdmissionsIdle(stuck.paths, testServiceOwner), false, "the lease stays");
});


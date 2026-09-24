// OP-1415. The third verification state, the decision it drives, and the
// capture that decision can open. Split out of atl-credential.test.mts for the
// same reason atl-credential-install.test.mts was: that file sits at the
// 250-line ceiling. The cut follows a line that is already there - this file is
// about what a VERDICT does and what the capture it allows may touch: the
// backup its question promises and the terminal the secret is read from.
//
// The defect this covers, measured 2026-09-23: one transient failure of the
// live token request made the step offer to overwrite a working credential
// file, because `verified: Boolean(first?.pass)` flattened "proved wrong" and
// "proved nothing" into the same false.
//
// What is NOT claimed here: the confirmation prompt itself. It needs a terminal
// and there is none in a test runner, so the reading of the answer is exercised
// as a pure function and the branch that asks is pinned structurally. The
// interactive round trip is unproven.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  CAPTURE_QUESTION, backupPathFor, classifyVerdict, confirmationLines, credentialSource,
  declinedMessage, readsAsYes,
} from "./atl-credential-format.mts";
import { pauseBriefly, readSecretBytes } from "./atl-credential.mts";

const STEP = path.join(import.meta.dirname, "atl-credential.mts");
const TARGET = "/var/kherep/atl-credential-claude.txt";

test("PASS proves, FAIL disproves, and every other word proves nothing", () => {
  assert.equal(classifyVerdict("PASS", 0), "pass");
  assert.equal(classifyVerdict("pass", 0), "pass", "the word decides, not its casing");
  // The conclusive failure, in both brokers' dialects.
  assert.equal(classifyVerdict("FAIL", 1), "fail");
  assert.equal(classifyVerdict("FEHLSCHLAG", 1), "fail");
  // Silence, a broker that never ran, both spellings of UNKNOWN, and any word
  // this step has never heard of: all of them prove nothing. The unrecognised
  // word defaults to the cautious side on purpose - it must never read as a
  // licence to overwrite a file that may be perfectly good.
  for (const word of ["UNKNOWN", "UNBEKANNT", "NOT-RUN", "", "   ", "FAILED", "ERROR"]) {
    assert.equal(classifyVerdict(word, 1), "inconclusive", `${JSON.stringify(word)} proves nothing`);
  }
  // A PASS the broker contradicts with a non-zero exit is not a pass either.
  assert.equal(classifyVerdict("PASS", 1), "inconclusive");
});

test("the decision keeps a proven file, replaces a disproven one, and asks about neither", () => {
  // A conclusive pass keeps the file, terminal or not.
  assert.equal(credentialSource({ outcome: "pass", hasTerminal: true }), "keep");
  assert.equal(credentialSource({ outcome: "pass", hasTerminal: false }), "keep");
  // A conclusive failure behaves exactly as it did before: prompt at a
  // terminal, fatal without one.
  assert.equal(credentialSource({ outcome: "fail", hasTerminal: true }), "prompt");
  assert.equal(credentialSource({ outcome: "fail", hasTerminal: false }), "fatal");
  // No file at all. Nothing can be destroyed, no broker ran, so there is no
  // verdict - and today's behaviour is unchanged.
  assert.equal(credentialSource({ hasTerminal: true }), "prompt");
  assert.equal(credentialSource({ hasTerminal: false }), "fatal");
});

test("an inconclusive verdict over an existing file never overwrites on its own", () => {
  // The cell the defect was in. A rotated or revoked secret is legitimately
  // inconclusive and recovering from it is why this step exists, so refusing
  // is not the answer - but neither is acting silently.
  assert.equal(credentialSource({ outcome: "inconclusive", hasTerminal: true }), "confirm");
  assert.equal(credentialSource({ outcome: "inconclusive", hasTerminal: false }), "fatal");
  // Restated as the property rather than the table: of the four states an
  // existing file can be in, exactly one reaches the capture unasked.
  const silent = (["pass", "fail", "inconclusive"] as const)
    .filter((outcome) => credentialSource({ outcome, hasTerminal: true }) === "prompt");
  assert.deepEqual(silent, ["fail"], "only a disproven file is replaced without asking");
});

test("the question defaults to no, and only a spelled-out yes is a yes", () => {
  for (const yes of ["y", "Y", "yes", "YES", "  yes  ", "y\n", "Yes\r\n"]) {
    assert.equal(readsAsYes(yes), true, JSON.stringify(yes));
  }
  // An empty answer IS an answer here, and it is no. So is everything that is
  // not the word: a stray keystroke must not cost the operator their file.
  for (const no of ["", "\n", "   ", "n", "no", "N", "j", "ja", "yeah", "1", "sure", "capture"]) {
    assert.equal(readsAsYes(no), false, JSON.stringify(no));
  }
  assert.match(CAPTURE_QUESTION, /\[y\/N\]/, "the prompt must show which answer the empty line gives");
});

test("the question says why it is asked and what happens to the file, with no value in it", () => {
  const backup = backupPathFor(TARGET, new Date("2026-09-23T09:15:00Z"));
  const text = confirmationLines(TARGET, "UNKNOWN", backup).join("\n");
  assert.match(text, /UNKNOWN/, "the verdict is named");
  assert.match(text, /could not tell a wrong credential from an endpoint it could not/);
  assert.match(text, /may be perfectly good/);
  assert.match(text, new RegExp(backup.replace(/[.\\/]/g, "\\$&")), "the backup path is named");
  assert.match(text, /leaves the file untouched/);
  assert.match(declinedMessage(TARGET, "UNKNOWN"), /left untouched/);
  for (const line of [...confirmationLines(TARGET, "UNKNOWN", backup), declinedMessage(TARGET, "UNKNOWN")]) {
    assert.doesNotMatch(line, /SENTINEL/, "a message may carry a path and a verdict, never a value");
  }
});

// The pure branch above says the decision is "confirm". This says the step
// honours it: the answer is read BEFORE the first value is asked for, and the
// declined answer leaves through the file's one non-zero exit rather than
// falling through into the capture underneath it.
test("the capture is unreachable from an inconclusive verdict without an answer", () => {
  const step = fs.readFileSync(STEP, "utf8");
  const question = step.indexOf("readsAsYes(");
  const capture = step.indexOf("clientId: promptLine(");
  assert.notEqual(question, -1, "the step never reads an answer");
  assert.notEqual(capture, -1, "the capture moved; this guard has to move with it");
  assert.ok(question < capture, "the values are asked for before the question is answered");
  assert.match(step.slice(question, capture), /fail\(declinedMessage\(/, "a no does not stop the run");
});

// The refusal an unattended run hits, end to end, with no network and no
// terminal: the file on disk is not a credential, so the broker refuses it
// before any request and prints no verdict at all - the same "nothing is known"
// shape a transient failure of the live token request produces.
function runStep(args: string[]): { status: number | null; stderr: string } {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("KHEREP_ATL_CRED_FILE")) delete env[key];
  }
  const run = spawnSync(process.execPath, [STEP, ...args], {
    env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
  });
  return { status: run.status, stderr: run.stderr ?? "" };
}

test("without a terminal an inconclusive verdict is fatal, names it, and touches nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-atl-credential-verdict-"));
  const target = path.join(dir, "cred");
  fs.writeFileSync(target, "not-a-credential-file\n", { mode: 0o600 });
  const before = fs.readFileSync(target);
  const run = runStep(["--runtime", "claude", "--out", target]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /verdict UNKNOWN/, "the verdict is named");
  assert.match(run.stderr, /does not say the file is wrong/, "and not reported as a proven rejection");
  assert.deepEqual(fs.readFileSync(target), before, "a refused run overwrites nothing");
  assert.equal(fs.existsSync(path.join(dir, "_deprecated")), false, "and backs nothing up");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The backup a yes promises, parked by the step's own backUp in a child process
// because a refusal ends that process - which is the point: nothing after it
// runs. Two runs inside one second collide on the stamp.
function park(target: string, backup: string): { status: number | null; stderr: string; stdout: string } {
  const code = `import { backUp } from ${JSON.stringify(pathToFileURL(STEP).href)};`
    + "backUp(process.argv[1], process.argv[2]);";
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code, target, backup], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  return { status: run.status, stderr: run.stderr ?? "", stdout: run.stdout ?? "" };
}

test("a backup already parked is never overwritten, and the target stays as it was", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-atl-credential-backup-"));
  const target = path.join(dir, "cred");
  const backup = backupPathFor(target, new Date("2026-09-23T09:15:00Z"));
  fs.writeFileSync(target, "SENTINEL-CURRENT\n");
  fs.mkdirSync(path.dirname(backup));
  fs.writeFileSync(backup, "SENTINEL-PARKED\n");
  const refused = park(target, backup);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^FATAL: Refusing to run: a backup is already parked at /);
  assert.ok(refused.stderr.includes(backup), "the refusal names the parked file");
  assert.match(refused.stderr, /Nothing was changed/);
  assert.doesNotMatch(refused.stderr + refused.stdout, /SENTINEL/, "a path, never the contents");
  assert.equal(fs.readFileSync(backup, "utf8"), "SENTINEL-PARKED\n", "the parked copy is evidence");
  assert.equal(fs.readFileSync(target, "utf8"), "SENTINEL-CURRENT\n", "and the target is untouched");
  // A free name is taken as before: the same bytes, owner-only.
  const fresh = backupPathFor(target, new Date("2026-09-23T09:15:01Z"));
  assert.equal(park(target, fresh).status, 0);
  assert.equal(fs.readFileSync(fresh, "utf8"), "SENTINEL-CURRENT\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
  // And the step parks before it writes, so the refusal precedes any change.
  const main = fs.readFileSync(STEP, "utf8").split("function main(")[1] ?? "";
  const parkAt = main.indexOf("backUp(target, plannedBackup)");
  assert.ok(parkAt !== -1 && parkAt < main.indexOf("writeSecure(target, text)"), "written before parked");
});

// A non-blocking stdin answers EAGAIN until a key arrives. That is waited on,
// not spun on - and not counted: a cap on the waits would end the input early
// and hand on part of a secret as if it were all of it. The raw-mode terminal
// around this loop needs a real TTY and stays unproven here.
function terminal(typed: string, idleFirst: number): (chunk: Buffer) => number {
  const keys = [...Buffer.from(typed)];
  let idle = idleFirst;
  return (chunk) => {
    if (idle-- > 0) throw Object.assign(new Error("idle"), { code: "EAGAIN" });
    chunk[0] = keys.shift() ?? 0x0d;
    return 1;
  };
}
const typedOut = (bytes: number[]): string => Buffer.from(bytes).toString("utf8");

test("an idle terminal is waited on between reads, not spun on", () => {
  const started = performance.now();
  pauseBriefly();
  assert.ok(performance.now() - started >= 10, "the pause returned without waiting");
  const at = performance.now();
  assert.equal(typedOut(readSecretBytes("client secret", terminal("SENTINEL\r", 3))), "SENTINEL");
  assert.ok(performance.now() - at >= 30, "three EAGAINs were answered without a pause");
});

test("however long the terminal stays idle, the secret arrives whole", () => {
  let pauses = 0;
  const bytes = readSecretBytes("client secret", terminal("SENTINEL-SECRET\r", 20_000), () => { pauses += 1; });
  assert.equal(typedOut(bytes), "SENTINEL-SECRET");
  assert.equal(pauses, 20_000, "every EAGAIN paused, and none of them ended the input");
  // The keys the loop already knew keep their meaning.
  assert.equal(typedOut(readSecretBytes("client secret", terminal("AB\x7fC\n", 0))), "AC");
  assert.throws(() => readSecretBytes("client secret", terminal("\x03", 0)), /^Error: Reading the client secret was interrupted\.$/);
  const broken = (): number => { throw Object.assign(new Error("gone"), { code: "EIO" }); };
  assert.throws(() => readSecretBytes("client secret", broken), /^Error: Could not read the client secret from the terminal\.$/);
});

test("this file stays under the size cap too", () => {
  const lines = fs.readFileSync(import.meta.filename, "utf8").replace(/\n$/, "").split(/\r?\n/).length;
  assert.equal(lines <= 250, true, `${path.basename(import.meta.filename)} is ${lines} lines`);
});

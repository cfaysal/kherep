// Pure-logic cover for bootstrap/atl-credential.mts: no network, no terminal,
// no broker process. The one thing that is NOT restated here is the credential
// file format - it is checked against the two brokers' real parsers, because a
// second copy of the rule in a test is exactly how the two drift apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  RUNTIMES,
  backupPathFor,
  bindingHint,
  childEnv,
  collides,
  credentialSource,
  fieldLengths,
  rejectedMessage,
  renderCredentialFile,
  resolveTarget,
  unchangedMessage,
  verdictOf,
  writtenMessage,
} from "./atl-credential-format.mts";
import { writeSecure } from "./atl-credential.mts";
import { parseCredentialText as parseForClaude } from "../modules/atl-jira-brokers/atl-jira-ccoder.mts";
import { parseCredentialText as parseForCodex } from "../modules/atl-jira-brokers/atl-jira.mts";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const REPO = path.join(import.meta.dirname, "..");
const STEP = path.join(import.meta.dirname, "atl-credential.mts");
const FORMAT = path.join(import.meta.dirname, "atl-credential-format.mts");
const ENV_KEY = "KHEREP_ATL_CRED_FILE_CLAUDE";

test("each runtime names its own variable and its own repo broker", () => {
  assert.deepEqual(RUNTIMES.claude, { envKey: ENV_KEY, broker: "atl-jira-ccoder.mts" });
  assert.deepEqual(RUNTIMES.codex, { envKey: "KHEREP_ATL_CRED_FILE_CODEX", broker: "atl-jira.mts" });
  for (const runtime of Object.values(RUNTIMES)) {
    const broker = path.join(REPO, "modules", "atl-jira-brokers", runtime.broker);
    assert.ok(fs.existsSync(broker), `repo broker missing: ${broker}`);
  }
});

test("the canonical form is the one both brokers actually parse", () => {
  const values = { clientId: "ID-VALUE", clientSecret: "SECRET-VALUE" };
  const text = renderCredentialFile(values);
  assert.equal(text, "client_id: ID-VALUE\nclient_secret: SECRET-VALUE\n");
  assert.equal(text.split("\n").filter((line) => line.trim()).length, 2, "exactly two non-empty lines");
  assert.equal(text.endsWith("\n") && !text.endsWith("\n\n"), true, "exactly one trailing newline");
  // The Codex parser is the strict one; the Claude parser is the lenient one.
  assert.deepEqual(parseForCodex(text), values);
  assert.deepEqual(parseForClaude(text), values);
  // A value may carry colons of its own: the key is what the parsers split on.
  const colons = { clientId: "ID:WITH:COLONS", clientSecret: "SECRET:WITH:COLONS" };
  assert.deepEqual(parseForCodex(renderCredentialFile(colons)), colons);
  assert.deepEqual(parseForClaude(renderCredentialFile(colons)), colons);
});

test("values are trimmed before they are written", () => {
  assert.equal(renderCredentialFile({ clientId: " A ", clientSecret: "\tB " }), "client_id: A\nclient_secret: B\n");
});

test("an unwritable value is refused without the value reaching the message", () => {
  assert.throws(
    () => renderCredentialFile({ clientId: "   ", clientSecret: "S" }),
    /^Error: No client id given\.$/,
  );
  assert.throws(
    () => renderCredentialFile({ clientId: "A", clientSecret: "first\nSENTINEL-SECRET" }),
    (error: Error) => /client secret must be a single line/.test(error.message)
      && !/SENTINEL/.test(error.message),
  );
});

test("the variable names the file; --out is only the fallback", () => {
  assert.deepEqual(
    resolveTarget({ [ENV_KEY]: "  /bound/cred  " }, ENV_KEY, "/out/cred"),
    { target: "/bound/cred", origin: "env" },
  );
  assert.deepEqual(resolveTarget({ [ENV_KEY]: "   " }, ENV_KEY, "/out/cred"), { target: "/out/cred", origin: "out" });
  assert.deepEqual(resolveTarget({}, ENV_KEY, "/out/cred"), { target: "/out/cred", origin: "out" });
});

// OP-1415. The four-way decision this used to check in two states now lives in
// atl-credential-verdict.test.mts, next to the verdict that drives it.
test("a verified file is kept, whether or not a terminal is attached", () => {
  assert.equal(credentialSource({ outcome: "pass", hasTerminal: true }), "keep");
  assert.equal(credentialSource({ outcome: "pass", hasTerminal: false }), "keep");
});

test("the backup lands in _deprecated beside the file, stamped in UTC", () => {
  const at = new Date("2026-09-22T16:26:00.123Z");
  assert.equal(
    backupPathFor("/var/kherep/atl-credential-claude.txt", at),
    path.join("/var/kherep/_deprecated", "atl-credential-claude.txt.pre-20260922T162600Z"),
  );
  // Local time must not leak into the name: the same instant, a different zone.
  assert.equal(
    backupPathFor("/var/kherep/cred", new Date(Date.UTC(2026, 0, 1, 0, 0, 0))),
    path.join("/var/kherep/_deprecated", "cred.pre-20260101T000000Z"),
  );
});

test("a backup path that resolves onto the file itself is refused", () => {
  assert.equal(collides("/a/b/cred", "/a/b/./cred"), true);
  assert.equal(collides("/a/b/cred", "/a/b/../b/cred"), true);
  const target = "/var/kherep/cred";
  assert.equal(collides(target, backupPathFor(target, new Date("2026-09-22T16:26:00Z"))), false);
});

test("the child binding replaces every inherited spelling of the variable", () => {
  const parent = {
    PATH: "/usr/bin",
    [ENV_KEY]: "/inherited",
    kherep_atl_cred_file_claude: "/inherited-other-casing",
    KHEREP_ATL_CRED_FILE_CODEX: "/the-other-runtime",
  };
  const child = childEnv(parent, ENV_KEY, "/named/by/configuration");
  assert.equal(child[ENV_KEY], "/named/by/configuration");
  assert.equal(child.PATH, "/usr/bin", "the rest of the environment is carried over");
  assert.equal(child.KHEREP_ATL_CRED_FILE_CODEX, "/the-other-runtime", "the other runtime is untouched");
  const bindings = Object.keys(child).filter((key) => key.toLowerCase() === ENV_KEY.toLowerCase());
  assert.deepEqual(bindings, [ENV_KEY], "exactly one binding, in canonical spelling");
});

test("only the discriminating verdict counts, in either broker's dialect", () => {
  assert.equal(verdictOf("echt: status 200, token laenge 812\nverdikt: PASS\n"), "PASS");
  assert.equal(verdictOf("verdikt: UNBEKANNT - Test diskriminiert nicht\n"), "UNBEKANNT");
  assert.equal(verdictOf("verdikt: FEHLSCHLAG - echtes Secret abgelehnt\n"), "FEHLSCHLAG");
  assert.equal(verdictOf('{"token":{"status":200},"control":{"status":401},"verdict":"PASS"}\n'), "PASS");
  assert.equal(verdictOf('{"token":{"status":200},"verdict":"UNKNOWN"}\n'), "UNKNOWN");
  assert.equal(verdictOf('{"token":{"status":401},"verdict":"FAIL"}\n'), "FAIL");
  // Silence and noise are UNKNOWN. A broker that said nothing proved nothing.
  assert.equal(verdictOf(""), "UNKNOWN");
  assert.equal(verdictOf("\n   \n"), "UNKNOWN");
  assert.equal(verdictOf("{ truncated json"), "UNKNOWN");
  assert.equal(verdictOf("status: 200\nall good\n"), "UNKNOWN");
  assert.equal(verdictOf('{"status":0,"error":"Interner Fehler."}\n'), "UNKNOWN");
});

test("the written summary carries lengths, never the values", () => {
  const values = { clientId: "SENTINEL-ID-0001", clientSecret: "SENTINEL-SECRET-0002" };
  assert.deepEqual(fieldLengths(values), { id: 16, secret: 20 });
  const message = writtenMessage(ENV_KEY, "/var/kherep/cred", 64, fieldLengths(values));
  assert.match(message, /client id 16 chars/);
  assert.match(message, /client secret 20 chars/);
  assert.match(message, /64 bytes/);
  assert.doesNotMatch(message, /SENTINEL/);
});

test("every other message is built from a path, a size and a verdict only", () => {
  const messages = [
    unchangedMessage(ENV_KEY, "/var/kherep/cred", 61),
    bindingHint(ENV_KEY, "/var/kherep/cred"),
    rejectedMessage("/var/kherep/cred", "UNBEKANNT", 1),
  ];
  for (const message of messages) {
    assert.match(message, /\/var\/kherep\/cred/);
    assert.doesNotMatch(message, /SENTINEL/);
  }
  assert.match(messages[0], /61 bytes/);
  assert.match(messages[2], /verdict UNBEKANNT, exit 1/);
});

// The source-level guard the message tests cannot give: a value can only leave
// this module through the file it writes. Every other interpolation of a
// credential variable is a leak into stdout, stderr or a log.
test("no string outside the file renderer interpolates a credential value", () => {
  const offenders = [STEP, FORMAT].flatMap((file) => fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((text, index) => ({ file: path.basename(file), line: index + 1, text }))
    .filter(({ text }) => /\$\{[^}]*\b(clientId|clientSecret)\b[^}]*\}/.test(text))
    .filter(({ text }) => !text.includes("`client_id: ${")));
  assert.deepEqual(offenders, [], "credential value interpolated outside renderCredentialFile");
});

test("importing the step runs nothing, and both files stay under the size cap", () => {
  const step = fs.readFileSync(STEP, "utf8");
  assert.match(step, /^if \(isMainModule\(\)\) main\(\);$/m);
  for (const file of [STEP, FORMAT, import.meta.filename]) {
    const lines = fs.readFileSync(file, "utf8").replace(/\n$/, "").split(/\r?\n/).length;
    assert.equal(lines <= 250, true, `${path.basename(file)} is ${lines} lines`);
  }
});

test("the file is written owner-only, byte for byte, even over a looser one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-atl-credential-"));
  const target = path.join(dir, "nested", "cred");
  const text = renderCredentialFile({ clientId: "ID-VALUE", clientSecret: "SECRET-VALUE" });
  const posix = process.platform !== "win32"; // Windows has no POSIX mode to assert
  writeSecure(target, text);
  assert.equal(fs.readFileSync(target, "utf8"), text, "exact bytes, nothing appended");
  if (posix) assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  // An existing file keeps its own mode through a plain open(), so the rewrite
  // has to narrow it again or a world-readable file stays world-readable.
  if (posix) fs.chmodSync(target, 0o644);
  writeSecure(target, text);
  if (posix) assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The refusals a scripted or CI install can hit. stdin is a pipe here, so this
// is also the proof that no terminal means a fast failure naming the variable
// rather than a process blocked on stdin. No file exists, so no broker starts.
function runStep(args: string[]): { status: number | null; stderr: string; stdout: string } {
  // Every inherited credential binding is stripped, or this test resolves the
  // operator's own file, starts a broker and reaches the network - measured
  // here: with the binding inherited the step exits 0 on the live credential.
  // Stripped by hand rather than through childEnv: the guarantee must not
  // depend on the function under test, or a regression there would surface as
  // a network call instead of a red test.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("KHEREP_ATL_CRED_FILE")) delete env[key];
  }
  const run = spawnSync(process.execPath, [STEP, ...args], {
    env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
  });
  return { status: run.status, stderr: run.stderr ?? "", stdout: run.stdout ?? "" };
}

test("a scripted run without a terminal fails fast, naming the variable", () => {
  const absent = path.join(os.tmpdir(), `kherep-atl-credential-absent-${process.pid}`);
  assert.equal(fs.existsSync(absent), false, "the fixture path must not exist");
  const run = runStep(["--runtime", "claude", "--out", absent]);
  assert.equal(run.status, 1);
  assert.match(withoutTypeStrippingWarning(run.stderr), /^FATAL: KHEREP_ATL_CRED_FILE_CLAUDE names no verified credential file/);
  assert.match(run.stderr, /attached to a terminal/);
  assert.equal(fs.existsSync(absent), false, "a refused run writes nothing");
});

test("the arguments are required and the runtime list is closed", () => {
  assert.match(runStep(["--runtime", "claude"]).stderr, /^FATAL: --out <file> is required\.$/m);
  assert.match(runStep(["--out", "/tmp/x"]).stderr, /^FATAL: --runtime claude\|codex is required\.$/m);
  assert.match(
    runStep(["--out", "/tmp/x", "--runtime", "rovo"]).stderr,
    /^FATAL: --runtime must be one of claude \| codex\.$/m,
  );
});


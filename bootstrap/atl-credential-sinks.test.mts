// OP-1415. What may leave the credential step, read from its source. Split out
// of atl-credential.test.mts for the reason its two siblings were: that file
// sits at the 250-line ceiling. It widens the interpolation guard there, "no
// ${value} outside the file renderer", to "no sink is handed a value at all" -
// concatenations included, and say() included, which the step prints through.
//
// Structural on purpose: a behavioural test only proves the paths it walks, and
// most of these - a terminal prompt, a live broker - cannot be walked here. The
// scan is textual, so a value first copied into a local of another name and
// then printed is NOT caught; the anchors below make a rename of the names it
// tracks fail loudly instead of passing quietly.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const STEP = path.join(import.meta.dirname, "atl-credential.mts");
const FORMAT = path.join(import.meta.dirname, "atl-credential-format.mts");

// Every place output or a child process starts: a terminal write, a FATAL, a
// say(), an Error that becomes a FATAL, and a child's argv and environment.
const SINK = /(?:process\.std(?:out|err)\.write|console\.\w+|\b(?:fail|say|spawnSync|spawn|execFileSync|execSync)|new Error)\(/g;
const LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * Each sink call with what it is handed, cut at its closing paren. Literals are
 * stepped over while counting, so a paren in a message cannot end an argument
 * early, then reduced to their ${...} parts: prose may say "values", code not.
 */
function sinkArguments(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  for (const match of code.matchAll(SINK)) {
    const start = match.index + match[0].length;
    let index = start;
    for (let depth = 1; index < code.length && depth > 0; index += 1) {
      const char = code[index];
      if (char === '"' || char === "'" || char === "`") {
        index += 1;
        while (index < code.length && code[index] !== char) index += code[index] === "\\" ? 2 : 1;
      } else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
    }
    found.push(match[0] + code.slice(start, index - 1).replace(LITERAL, (literal) => (literal.startsWith("`")
      ? [...literal.matchAll(/\$\{([^}]*)\}/g)].map((part) => part[1]).join(" ") : "")));
  }
  return found;
}

// The names the step keeps a captured value under: the two fields, the object
// holding them, the raw line, the secret's bytes and the file text made of
// them. A measurement of one is not the value: its length, its byte count.
const TAINTED = /\b(?:values|clientId|clientSecret|raw|bytes|text)\b/;
const MEASURED = /\b(?:fieldLengths|Buffer\.byteLength)\([^)]*\)|[\w.]+\.length\b/g;
const leaks = (calls: string[]): string[] => calls.filter((call) => TAINTED.test(call.replace(MEASURED, "")));

test("no sink in the step is handed a captured value", () => {
  const step = fs.readFileSync(STEP, "utf8");
  for (const anchor of ["const values: CredentialValues = {", "const text = renderCredentialFile(values);",
    "bytes = readSecretBytes(", "function accept(label: string, raw: string)"]) {
    assert.ok(step.includes(anchor), `"${anchor}" moved; the names tracked here have to move with it`);
  }
  const calls = [step, fs.readFileSync(FORMAT, "utf8")].flatMap(sinkArguments);
  // Every kind of sink the step uses was reached, or the scan proves nothing.
  for (const kind of ["say(", "fail(", "new Error(", "spawnSync(", "process.stdout.write(", "process.stderr.write("]) {
    assert.ok(calls.some((call) => call.startsWith(kind)), `no ${kind}...) call was scanned`);
  }
  assert.ok(calls.some((call) => call.startsWith("say(writtenMessage(")), "the say() that reports the write");
  assert.deepEqual(leaks(calls), [], "a captured value is handed to a sink");
});

// The scan against a leak through each kind of sink - say() above all, which a
// scan of write() and fail() alone never reached.
test("the scan sees a value handed to any sink, and lets a measurement pass", () => {
  for (const leak of [
    "say(`client id ${values.clientId}`);",
    'say("client secret " + values.clientSecret);',
    'fail("rejected: " + text);',
    'process.stdout.write(Buffer.from(bytes).toString("utf8"));',
    "throw new Error(`not a single line: ${raw}`);",
    'spawnSync(process.execPath, [broker, "selftest", values.clientSecret]);',
  ]) {
    assert.equal(leaks(sinkArguments(leak)).length, 1, leak);
  }
  const measured = 'say(writtenMessage(key, target, Buffer.byteLength(text, "utf8"), fieldLengths(values)));';
  assert.deepEqual(leaks(sinkArguments(measured)), []);
  // Prose is not code: a message may say what it is about.
  assert.deepEqual(leaks(sinkArguments('fail("run it at a terminal so the values can be entered");')), []);
});

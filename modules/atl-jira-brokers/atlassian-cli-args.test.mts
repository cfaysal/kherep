import assert from "node:assert/strict";
import test from "node:test";

import {
  CliArgsError,
  DE,
  EN,
  helpText,
  isHelp,
  parseVerbArgs,
  usageLine,
  type FlagSpec,
} from "./atlassian-cli-args.mts";

const GET: FlagSpec = { required: { id: "<id>" }, optional: { format: "<storage|adf>" }, valueless: ["body-only"] };
const COMMENT: FlagSpec = { required: { key: "<KEY>" }, oneOf: [{ body: "<text>", "body-file": "<path>" }] };

function rejection(spec: FlagSpec, argv: string[], verb = "get", messages = EN): string {
  try {
    parseVerbArgs(verb, spec, argv, messages);
  } catch (error) {
    assert.ok(error instanceof CliArgsError);
    return error.message;
  }
  assert.fail("expected a CliArgsError");
}

test("well-formed flags parse into a plain map, valueless flags as empty strings", () => {
  assert.deepEqual(parseVerbArgs("get", GET, ["--body-only", "--id", "5001"], EN), { "body-only": "", id: "5001" });
  assert.deepEqual(parseVerbArgs("get", GET, ["--id", "5001", "--format", "adf"], EN), { id: "5001", format: "adf" });
  assert.deepEqual(parseVerbArgs("selftest", {}, [], EN), {});
});

test("an empty value and text that only starts with dashes are values", () => {
  assert.deepEqual(parseVerbArgs("comment", COMMENT, ["--key", "OP-1", "--body", ""], EN), { key: "OP-1", body: "" });
  assert.deepEqual(parseVerbArgs("comment", COMMENT, ["--key", "OP-1", "--body", "---"], EN).body, "---");
});

test("a positional is refused with the corrected call and the full syntax", () => {
  assert.equal(rejection(GET, ["275907063"]), [
    "get expects --id <id>; got positional '275907063'.",
    "Did you mean: get --id 275907063",
    "Usage: get --id <id> [--format <storage|adf>] [--body-only]",
  ].join("\n"));
});

test("a positional after the required flag names no guess it cannot make", () => {
  const message = rejection(GET, ["--id", "5001", "stray"]);
  assert.match(message, /got positional 'stray'/);
  assert.doesNotMatch(message, /Did you mean/);
});

test("a positional is quoted when it would not survive a shell as one word", () => {
  assert.match(rejection(COMMENT, ["OP-1", "--body", "x"], "comment"), /Did you mean: comment --key OP-1 \.\.\./);
  assert.match(rejection(GET, ["a b"]), /Did you mean: get --id "a b"/);
});

test("unknown, valueless-missing, duplicate and missing flags each name the verb syntax", () => {
  const usage = "Usage: get --id <id> [--format <storage|adf>] [--body-only]";
  assert.equal(rejection(GET, ["--id", "1", "--title", "x"]), `get does not take --title.\n${usage}`);
  assert.equal(rejection(GET, ["--id"]), `get: --id needs a value.\n${usage}`);
  assert.equal(rejection(GET, ["--id", "--body-only"]), `get: --id needs a value.\n${usage}`);
  assert.equal(rejection(GET, ["--id", "1", "--id", "2"]), `get: --id was given more than once.\n${usage}`);
  assert.equal(rejection(GET, ["--body-only", "--body-only", "--id", "1"]), `get: --body-only was given more than once.\n${usage}`);
  assert.equal(rejection(GET, ["--body-only"]), `get: --id is missing.\n${usage}`);
});

test("an alternative group is satisfied by either flag and named whole when neither is given", () => {
  assert.deepEqual(parseVerbArgs("comment", COMMENT, ["--key", "OP-1", "--body-file", "b.txt"], EN), { key: "OP-1", "body-file": "b.txt" });
  assert.match(rejection(COMMENT, ["--key", "OP-1"], "comment", DE), /^comment: --body oder --body-file fehlt\.\nNutzung: comment --key <KEY> \(--body <text> \| --body-file <path>\)$/);
});

test("prototype names are unknown flags, not inherited ones", () => {
  assert.match(rejection(GET, ["--constructor", "x"]), /does not take --constructor/);
  assert.match(rejection(GET, ["--__proto__", "x"]), /does not take --__proto__/);
});

test("a verb without flags refuses any argument", () => {
  assert.equal(rejection({}, ["x"], "selftest"), "selftest expects no arguments; got positional 'x'.\nUsage: selftest");
  assert.equal(rejection({}, ["x"], "selftest", DE),
    "selftest erwartet keine Argumente; Positionsargument 'x' erhalten.\nNutzung: selftest");
});

test("help lists every verb with its flags, generated from the same table", () => {
  assert.deepEqual(helpText({ get: GET, selftest: {} }, EN), [
    "Verbs and their flags ([...] is optional):",
    "  get --id <id> [--format <storage|adf>] [--body-only]",
    "  selftest",
  ]);
  assert.equal(usageLine("comment", COMMENT), "comment --key <KEY> (--body <text> | --body-file <path>)");
});

test("help is recognised in its three spellings and nothing else", () => {
  for (const token of ["help", "--help", "-h"]) assert.equal(isHelp(token), true, token);
  for (const token of [undefined, "", "get", "-help", "HELP"]) assert.equal(isHelp(token), false, String(token));
});

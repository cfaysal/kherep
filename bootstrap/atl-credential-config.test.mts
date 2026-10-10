// Issue #379. A broker that stops on its own configuration ran no check: the
// step names the variable, asks nothing and changes nothing, instead of
// treating the silence as an inconclusive verdict on the credential.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { configurationProblem, misconfiguredMessage } from "./atl-credential-config.mts";
import { CAPTURE_QUESTION, credentialSource } from "./atl-credential-format.mts";

const STEP = path.join(import.meta.dirname, "atl-credential.mts");

test("finds the brokers' configuration message in either broker's channel", () => {
  // Claude broker: stderr. Codex broker: the JSON envelope on stdout.
  assert.equal(configurationProblem("", "KHEREP_ATL_SITE ist nicht gesetzt.\n"), "KHEREP_ATL_SITE ist nicht gesetzt.");
  assert.equal(configurationProblem('{"status":0,"error":"KHEREP_ATL_PROJECT_KEY ist nicht gesetzt."}\n', ""),
    "KHEREP_ATL_PROJECT_KEY ist nicht gesetzt.");
  for (const message of [
    "KHEREP_ATL_SITE ist ungültig.",
    "KHEREP_ATL_SITE muss ein credential-freier HTTPS-Origin sein.",
    "KHEREP_ATL_PROJECT_ID muss numerisch sein.",
    "KHEREP_ATL_ISSUE_TYPES ist kein gültiges JSON-Objekt.",
  ]) assert.equal(configurationProblem("", message), message);
});

test("a credential problem, a check that ran and any other output are not configuration", () => {
  for (const [stdout, stderr] of [
    ["", "KHEREP_ATL_CRED_FILE_CLAUDE ist nicht gesetzt."],
    ['{"status":0,"error":"KHEREP_ATL_CRED_FILE_CODEX ist nicht gesetzt."}', ""],
    ["", "Credentials-Datei hat nicht genau zwei Werte."],
    ['{"status":0,"error":"Interner Fehler."}', ""],
    ['{"token":{"status":200},"verdict":"UNKNOWN"}', ""],
    ["verdikt: UNBEKANNT - Test diskriminiert nicht", ""],
    ["", "  at KHEREP_ATL_SITE {value: https://x} ist nicht gesetzt."],
    ["", ""],
  ]) assert.equal(configurationProblem(stdout!, stderr!), undefined, `${stdout} | ${stderr}`);
});

test("a misconfigured host is decided before the terminal is asked", () => {
  assert.equal(credentialSource({ outcome: "misconfigured", hasTerminal: true }), "misconfigured");
  assert.equal(credentialSource({ outcome: "misconfigured", hasTerminal: false }), "misconfigured");
  const message = misconfiguredMessage("/x/cred", "KHEREP_ATL_SITE ist nicht gesetzt.");
  assert.match(message, /KHEREP_ATL_SITE ist nicht gesetzt\. \/x\/cred was neither verified nor changed/);
});

test("without the site the step names it, asks nothing and leaves the file as it was", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-atl-credential-config-"));
  try {
    const target = path.join(dir, "cred");
    fs.writeFileSync(target, "Client ID: synthetic-id\nClient Secret: synthetic-secret-value\n", { mode: 0o600 });
    const before = fs.readFileSync(target);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("KHEREP_ATL_")) delete env[key];
    const run = spawnSync(process.execPath, [STEP, "--runtime", "codex", "--out", target], {
      env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /The broker could not run its check: KHEREP_ATL_SITE ist nicht gesetzt\./);
    assert.equal(run.stdout.includes(CAPTURE_QUESTION), false, "nothing is asked");
    assert.doesNotMatch(run.stdout + run.stderr, /synthetic-secret-value/);
    assert.deepEqual(fs.readFileSync(target), before, "the file is untouched");
    assert.equal(fs.existsSync(path.join(dir, "_deprecated")), false, "and nothing is backed up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

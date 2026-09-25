#!/usr/bin/env node
/**
 * Setup step: capture and persist the Atlassian service-account credential for
 * one runtime, instead of an operator copying the two values into a file.
 *
 * It follows the Kherep convention for a required per-host value (see
 * bootstrap/confluence-space.mts and bootstrap/install.sh): the environment
 * variable names the file, a file that is already valid there is kept, and a
 * prompt comes only where a terminal is actually attached - otherwise the run
 * fails with the variable named instead of blocking on stdin.
 *
 * Two deliberate differences from the space key next door: the secret is read
 * WITHOUT echo and the terminal is restored even when the read throws; and
 * nothing counts as configured until the matching broker's `selftest` returns
 * the discriminating verdict PASS. Exit 0 on its own is not a pass - a check
 * that answers the same for a good and a tampered secret has proved nothing
 * (golden rule 12).
 *
 * No credential value is printed, logged or put into an error message: only
 * existence, byte size, field lengths and the verdict surface. The repo copies
 * of the brokers are used, so this works before the workspace tools exist.
 *
 * The decidable parts live in ./atl-credential-format.mts, where a test can
 * reach them without a terminal or a broker.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CAPTURE_QUESTION, RUNTIMES, backupPathFor, bindingHint, childEnv, classifyVerdict, collides,
  confirmationLines, credentialSource, declinedMessage, fieldLengths, readSecretBytes, readsAsYes,
  rejectedMessage, renderCredentialFile, requireSingleLine, resolveTarget, unchangedMessage,
  verdictOf, writtenMessage,
} from "./atl-credential-format.mts";
import type { CredentialValues, VerificationOutcome } from "./atl-credential-format.mts";

function fail(message: string): never {
  process.stderr.write(`FATAL: ${message}\n`);
  process.exit(1);
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Verdict { outcome: VerificationOutcome; verdict: string; exitCode: number }

// The broker's own output is not echoed. It is value-free by contract, but that
// contract is the broker's and not this step's; the verdict is the only part
// the decision rests on, and a zero exit without it is not a pass.
function verify(broker: string, envKey: string, credentialFile: string): Verdict {
  const run = spawnSync(process.execPath, [broker, "selftest"], {
    env: childEnv(process.env, envKey, credentialFile),
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
  const verdict = run.error ? "NOT-RUN" : verdictOf(run.stdout ?? "");
  const exitCode = typeof run.status === "number" ? run.status : -1;
  return { outcome: classifyVerdict(verdict, exitCode), verdict, exitCode };
}

function promptLine(prompt: string, label: string): string {
  process.stdout.write(prompt);
  const buffer = Buffer.alloc(512);
  let read = 0;
  try {
    read = fs.readSync(0, buffer, 0, buffer.length, null);
  } catch {
    fail(`Could not read the ${label} from the terminal.`);
  }
  return accept(label, buffer.subarray(0, read).toString("utf8"));
}

/** Raw mode, one byte at a time, echo restored in `finally` on every exit. */
function promptSecret(prompt: string, label: string): string {
  process.stdout.write(prompt);
  let bytes: number[] = [];
  let failure: Error | undefined;
  process.stdin.setRawMode(true);
  try {
    bytes = readSecretBytes(label, (chunk) => fs.readSync(0, chunk, 0, 1, null));
  } catch (error) {
    failure = error as Error;
  } finally {
    // A shell left with echo off is worse than a failed setup step, so this
    // runs for the interrupt and the read error too - which is why neither of
    // them fails from inside the loop: process.exit would skip the finally.
    process.stdin.setRawMode(false);
    process.stdout.write("\n");
  }
  if (failure) fail(failure.message);
  return accept(label, Buffer.from(bytes).toString("utf8"));
}

function accept(label: string, raw: string): string {
  try { return requireSingleLine(label, raw); } catch (error) { fail((error as Error).message); }
}

/**
 * The confirmation below is the only interactive element whose answer is not a
 * credential value, so it is the only read that tolerates an empty line: empty
 * IS an answer here, and readsAsYes makes it no. A read that fails is no too -
 * there is no answer that could have arrived, and no is the safe one.
 */
function askLine(prompt: string): string {
  process.stdout.write(prompt);
  const buffer = Buffer.alloc(64);
  try {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  }
}

export function writeSecure(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, "w", 0o600);
  try { fs.writeSync(fd, text, 0, "utf8"); } finally { fs.closeSync(fd); }
  fs.chmodSync(target, 0o600); // an already existing file keeps its old mode otherwise
}

// The path is computed once by the caller and not here: the question the
// operator answered names the backup, and it has to name the real one.
export function backUp(target: string, backup: string): string {
  if (collides(target, backup)) {
    fail(`Refusing to run: the backup path resolves to the file itself (${target}).`);
  }
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  // COPYFILE_EXCL: a copy already parked here is an earlier run's evidence and
  // is never overwritten. The copy is the check, so nothing lands between a
  // look and the write; main() writes the target only after this returns.
  try {
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    fail(code === "EEXIST"
      ? `Refusing to run: a backup is already parked at ${backup} and is never overwritten. `
        + `Nothing was changed: ${target} is as it was. The name is stamped to the second, `
        + "so run this step again in a moment."
      : `Could not copy ${target} to ${backup} (${code}); ${target} was not changed.`);
  }
  fs.chmodSync(backup, 0o600);
  say(`atl credential: previous file copied to ${backup}`);
  return backup;
}

function main(): void {
  const outArg = argValue("--out") ?? fail("--out <file> is required.");
  const name = argValue("--runtime") ?? fail("--runtime claude|codex is required.");
  const runtime = RUNTIMES[name] ?? fail(`--runtime must be one of ${Object.keys(RUNTIMES).join(" | ")}.`);
  const broker = path.join(import.meta.dirname, "..", "modules", "atl-jira-brokers", runtime.broker);
  if (!fs.existsSync(broker)) fail(`Jira broker not found at ${broker}.`);
  const { target, origin } = resolveTarget(process.env, runtime.envKey, outArg);
  const present = fs.existsSync(target);
  const first = present ? verify(broker, runtime.envKey, target) : undefined;
  const source = credentialSource({
    outcome: first?.outcome,
    hasTerminal: Boolean(process.stdin.isTTY),
  });
  // Named before the question is asked, because the question names it.
  const plannedBackup = backupPathFor(target, new Date());
  function hint(): void {
    if (origin === "out") say(bindingHint(runtime.envKey, target));
  }
  if (source === "keep") {
    say(unchangedMessage(runtime.envKey, target, fs.statSync(target).size));
    hint();
    return;
  }
  if (source === "fatal") {
    fail(`${runtime.envKey} names no verified credential file`
      + `${first ? ` (${target}: verdict ${first.verdict})` : ""}. `
      + (first?.outcome === "inconclusive"
        ? "That verdict does not say the file is wrong: the check could not tell a wrong credential "
          + "from an endpoint it could not reach, and nothing here was changed. "
        : "")
      + `Set ${runtime.envKey} to this host's service-account credential file, or run this step `
      + "attached to a terminal so the values can be entered. "
      + `Without it the ${name} broker cannot authenticate.`);
  }
  if (source === "confirm") {
    // The file is only unproven, not disproven, so it is the operator's call
    // and the empty answer keeps it. Nothing above this line has written.
    const verdict = first?.verdict ?? "UNKNOWN";
    for (const line of confirmationLines(target, verdict, plannedBackup)) say(line);
    if (!readsAsYes(askLine(CAPTURE_QUESTION))) fail(declinedMessage(target, verdict));
  } else if (first) {
    say(`atl credential: ${target} did not verify (verdict ${first.verdict}); capturing new values.`);
  }
  const values: CredentialValues = {
    clientId: promptLine("Atlassian service-account client id: ", "client id"),
    clientSecret: promptSecret("Atlassian service-account client secret (not echoed): ", "client secret"),
  };
  const text = renderCredentialFile(values);
  const backup = present ? backUp(target, plannedBackup) : undefined;
  writeSecure(target, text);
  const checked = verify(broker, runtime.envKey, target);
  if (checked.outcome !== "pass") {
    if (backup) { fs.copyFileSync(backup, target); fs.chmodSync(target, 0o600); }
    fail(rejectedMessage(target, checked.verdict, checked.exitCode)
      + (backup ? ` The previous file was restored from ${backup}.` : " Nothing was overwritten."));
  }
  say(writtenMessage(runtime.envKey, target, Buffer.byteLength(text, "utf8"), fieldLengths(values)));
  hint();
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();

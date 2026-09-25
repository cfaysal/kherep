/**
 * The decidable half of the Atlassian service-account credential setup step:
 * the file format, the precedence between configuration, an existing file and
 * a prompt, the backup path, the child environment and the broker verdict.
 *
 * It is separate from bootstrap/atl-credential.mts so all of this is reachable
 * from a test with no terminal, no broker process and no network - and so both
 * files stay inside the repository's size rule.
 *
 * Nothing here takes a credential value except renderCredentialFile, which is
 * the one function whose output is the file itself. Every message is built from
 * a path, a byte size, a field length or a verdict. The secret prompt's byte
 * loop, readSecretBytes, is here too: it reads through the function it is
 * handed and returns the bytes to the step without printing them.
 */
import path from "node:path";

export interface RuntimeBinding { envKey: string; broker: string }
export interface CredentialValues { clientId: string; clientSecret: string }

export const RUNTIMES: Record<string, RuntimeBinding> = {
  claude: { envKey: "KHEREP_ATL_CRED_FILE_CLAUDE", broker: "atl-jira-ccoder.mts" },
  codex: { envKey: "KHEREP_ATL_CRED_FILE_CODEX", broker: "atl-jira.mts" },
};

// The label is a fixed string; the value never reaches the message.
export function requireSingleLine(label: string, raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error(`No ${label} given.`);
  if (/[\r\n]/.test(value)) throw new Error(`The ${label} must be a single line.`);
  return value;
}

const IDLE = new Int32Array(new SharedArrayBuffer(4)); // never notified: a plain sleep
/** EAGAIN means a non-blocking stdin with nothing typed yet: wait, then ask again. */
export function pauseBriefly(): void {
  Atomics.wait(IDLE, 0, 0, 20);
}

/**
 * promptSecret's byte loop, handed its read so a test can drive it without a
 * terminal. It throws, never exits: promptSecret's finally has to run. An idle
 * terminal is waited out, uncapped - a cap would pass on part of a secret.
 */
export function readSecretBytes(
  label: string, readByte: (chunk: Buffer) => number, pause: () => void = pauseBriefly,
): number[] {
  const bytes: number[] = [];
  const chunk = Buffer.alloc(1);
  for (;;) {
    let read = 0;
    try {
      read = readByte(chunk);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") { pause(); continue; }
      throw new Error(`Could not read the ${label} from the terminal.`);
    }
    if (read === 0) return bytes;
    const byte = chunk[0];
    if (byte === 0x0d || byte === 0x0a) return bytes;
    if (byte === 0x03) throw new Error(`Reading the ${label} was interrupted.`);
    if (byte === 0x7f || byte === 0x08) { bytes.pop(); continue; }
    bytes.push(byte);
  }
}

/**
 * The canonical two-line form both brokers read. The Codex one is the strict
 * parser: exactly two non-empty lines, each `<key>: <value>` with the colon at
 * index 1 or later, exactly one key matching /secret/i and exactly one not.
 */
export function renderCredentialFile(values: CredentialValues): string {
  const clientId = requireSingleLine("client id", values.clientId);
  const clientSecret = requireSingleLine("client secret", values.clientSecret);
  return `client_id: ${clientId}\nclient_secret: ${clientSecret}\n`;
}

export function fieldLengths(values: CredentialValues): { id: number; secret: number } {
  return { id: values.clientId.trim().length, secret: values.clientSecret.trim().length };
}

/**
 * The variable names the file; `--out` is only the installer's default, used
 * where the host has not bound one. A host that points somewhere else is never
 * given a second copy under a name nothing reads.
 */
export function resolveTarget(
  env: Record<string, string | undefined>, envKey: string, outArg: string,
): { target: string; origin: "env" | "out" } {
  const bound = env[envKey]?.trim();
  return bound ? { target: bound, origin: "env" } : { target: outArg, origin: "out" };
}

/** What a broker's verdict proved about the file it was pointed at. */
export type VerificationOutcome = "pass" | "fail" | "inconclusive";

/**
 * PASS with a zero exit proves the credential. FAIL - FEHLSCHLAG in the Claude
 * broker's dialect - proves it wrong, and both brokers reach that word only
 * where the check demonstrably CAN tell a genuine secret from a tampered one.
 * Every other word proves nothing: UNKNOWN, UNBEKANNT, a broker that never ran,
 * silence, or a word this step has never heard of. That default is the cautious
 * side on purpose - an unrecognised verdict must never read as a licence to
 * overwrite a file that may be perfectly good.
 */
export function classifyVerdict(verdict: string, exitCode: number): VerificationOutcome {
  const word = verdict.trim().toUpperCase();
  if (word === "PASS") return exitCode === 0 ? "pass" : "inconclusive";
  return word === "FAIL" || word === "FEHLSCHLAG" ? "fail" : "inconclusive";
}

/**
 * A file that already verifies is kept, whatever named it; otherwise a terminal
 * is asked, and without one the run fails instead of blocking on stdin. WHICH
 * file is in question was already decided by resolveTarget above.
 *
 * OP-1415. The verdict has three states, not two, and the third one is where a
 * working file was being offered up: a check that could not tell a wrong
 * credential from an endpoint it could not reach has proved NOTHING. Refusing
 * to capture on it is not the answer either - a rotated or revoked secret is
 * legitimately inconclusive, and recovering from exactly that is why this step
 * exists. So the single cell where an existing file meets an inconclusive
 * verdict asks the operator, and only that cell does.
 */
export function credentialSource(state: {
  /** The verdict on the file already there; absent when there is no file. */
  outcome?: VerificationOutcome; hasTerminal: boolean;
}): "keep" | "prompt" | "confirm" | "fatal" {
  if (state.outcome === "pass") return "keep";
  if (!state.hasTerminal) return "fatal";
  return state.outcome === "inconclusive" ? "confirm" : "prompt";
}

/**
 * The one question this step asks whose answer is not a credential value, so
 * the one read that tolerates an empty line: empty IS an answer here, and it is
 * no. Only the word yes, in either length, replaces a file.
 */
export const CAPTURE_QUESTION = "Capture new values anyway? [y/N]: ";

export function readsAsYes(answer: string): boolean {
  const word = answer.trim().toLowerCase();
  return word === "y" || word === "yes";
}

export function confirmationLines(target: string, verdict: string, backup: string): string[] {
  return [
    `atl credential: ${target} could not be verified (broker verdict ${verdict}).`,
    "atl credential: this check could not tell a wrong credential from an endpoint it could not",
    "atl credential: reach, so the file that is already there may be perfectly good.",
    `atl credential: answering yes copies it to ${backup} first, then captures new values.`,
    "atl credential: answering no, or nothing at all, leaves the file untouched.",
  ];
}

export function declinedMessage(target: string, verdict: string): string {
  return `Nothing was captured: ${target} was left untouched on your answer, and broker verdict `
    + `${verdict} proved nothing either way. Re-run this step once the endpoint answers again, or `
    + "re-run it and answer yes to replace the file.";
}

export function backupPathFor(target: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(path.dirname(target), "_deprecated", `${path.basename(target)}.pre-${stamp}`);
}

export function collides(target: string, backup: string): boolean {
  return path.resolve(target) === path.resolve(backup);
}

/**
 * Remove the inherited binding FIRST, then set it: otherwise an inherited value
 * could make the check pass against a file the configuration does not name. On
 * a case-insensitive environment the inherited key need not even be spelled the
 * same, so every casing of it drops out.
 */
export function childEnv(
  parent: Record<string, string | undefined>, envKey: string, credentialFile: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const lowered = envKey.toLowerCase();
  for (const key of Object.keys(parent)) {
    if (key.toLowerCase() === lowered) continue;
    out[key] = parent[key];
  }
  out[envKey] = credentialFile;
  return out;
}

/**
 * The Claude broker ends with `verdikt: <word>`; the Codex broker prints one
 * JSON envelope carrying `verdict`. Anything else is UNKNOWN, which is no pass.
 */
export function verdictOf(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text) as { verdict?: unknown };
        if (typeof parsed.verdict === "string") return parsed.verdict;
      } catch { /* not the envelope, keep reading */ }
      continue;
    }
    const match = /^verdi[kc]t:\s*(\S+)/i.exec(text);
    if (match) return match[1];
  }
  return "UNKNOWN";
}

export function unchangedMessage(envKey: string, target: string, bytes: number): string {
  return `atl credential: ${envKey} verified unchanged, ${bytes} bytes -> ${target}`;
}

export function writtenMessage(
  envKey: string, target: string, bytes: number, lengths: { id: number; secret: number },
): string {
  return `atl credential: ${envKey} written and verified, ${bytes} bytes `
    + `(client id ${lengths.id} chars, client secret ${lengths.secret} chars) -> ${target}`;
}

export function bindingHint(envKey: string, target: string): string {
  return `atl credential: ${envKey} is not set in this environment. Bind it to ${target} `
    + "so the brokers read this file; this step does not edit your settings.";
}

export function rejectedMessage(target: string, verdict: string, exitCode: number): string {
  return `The credential at ${target} did not verify: broker verdict ${verdict}, exit ${exitCode}.`;
}

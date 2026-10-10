/**
 * Issue #379. A broker that stops on its own configuration never ran the check,
 * so its silence says nothing about the credential. Read as an inconclusive
 * verdict, it made the step offer to replace a working credential for a reason
 * it never named. This module finds that case and names the variable.
 *
 * Only the brokers' fixed configuration messages pass through: each starts with
 * the KHEREP_ATL_ variable it is about and carries no value. The credential
 * file's own variable is excluded; a missing or unreadable credential is the
 * credential's problem, not the host's.
 */

const CONFIGURATION_ERROR = /^KHEREP_ATL_(?!CRED_FILE_)[A-Z_]+ [^\r\n{}]{1,80}\.$/;

function matching(text: unknown): string | undefined {
  const line = String(text ?? "").trim();
  return CONFIGURATION_ERROR.test(line) ? line : undefined;
}

/** The Claude broker writes its error to stderr, the Codex broker as `error` in its JSON envelope. */
export function configurationProblem(stdout: string, stderr: string): string | undefined {
  for (const line of String(stderr).split(/\r?\n/)) {
    const found = matching(line);
    if (found) return found;
  }
  for (const line of String(stdout).split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const found = matching((JSON.parse(text) as { error?: unknown }).error);
      if (found) return found;
    } catch { /* not the envelope */ }
  }
  return undefined;
}

export function misconfiguredMessage(target: string, problem: string): string {
  return `The broker could not run its check: ${problem} ${target} was neither verified nor changed, `
    + "and nothing was asked: the credential is not in question. Set that variable for this host, "
    + "then run this step again.";
}

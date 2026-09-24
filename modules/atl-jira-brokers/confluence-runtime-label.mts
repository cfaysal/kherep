// Computes the `runtime-<runtime>-<host>` label instead of accepting one.
//
// Both halves used to be typed by whoever dispatched the observation agent, and
// both are exactly the kind of fact a caller gets wrong without ever finding
// out. The two runtimes share one Confluence service account per family, so a
// page's authorId is identical on every machine: this label is the ONLY record
// of which box produced a page. A wrong half does not fail, it just lies.
//
// So neither half is taken from the caller. The runtime comes from which
// credential variable the calling CLI is built around - a constant that IS the
// runtime identity rather than a guess about it - and the host comes from the
// same profile the installers and the drift check use.

export type Host = "win" | "mac";
export type Runtime = "claude-code" | "codex";

// Mirrors bootstrap/profile.sh: an explicit KHEREP_PROFILE wins, otherwise
// Darwin is the only unambiguous Mac and everything else exercises the win
// profile. A bare node process does not inherit the shell export, which is why
// the platform fallback has to exist rather than being a nicety.
export function hostOf(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Host {
  const configured = (env.KHEREP_PROFILE ?? "").trim();
  if (configured === "win" || configured === "mac") return configured;
  return platform === "darwin" ? "mac" : "win";
}

export function runtimeOf(credEnv: string): Runtime {
  if (/_CODEX$/.test(credEnv)) return "codex";
  if (/_CLAUDE$/.test(credEnv)) return "claude-code";
  throw new Error(`Cannot tell the runtime from the credential variable ${credEnv}.`);
}

export function runtimeLabel(
  credEnv: string,
  env?: Record<string, string | undefined>,
  platform?: string,
): string {
  return `runtime-${runtimeOf(credEnv)}-${hostOf(env, platform)}`;
}

// Strips any runtime label the caller supplied and puts the computed one in its
// place. Replacing rather than rejecting is deliberate: a caller that passes the
// right value should not fail, and one that passes the wrong value must not
// succeed with it.
export function withRuntimeLabel(
  labels: readonly string[],
  credEnv: string,
  env?: Record<string, string | undefined>,
  platform?: string,
): string[] {
  const cleaned = labels
    .map((label) => label.trim())
    .filter((label) => label && !label.startsWith("runtime-"));
  return [...cleaned, runtimeLabel(credEnv, env, platform)];
}

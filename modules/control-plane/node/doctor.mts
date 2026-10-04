import fs from "node:fs";
import path from "node:path";

import { codexHome } from "./codex-app.mts";
import type { NodePaths } from "./config.mts";
import { pidAlive } from "./daemon-state.mts";
import { checkRuntimes, checkWorker, findRuntime, runtimeVersion, type VersionOf } from "./doctor-host.mts";
import { checkHooks } from "./doctor-hooks.mts";
import { checkDaemon, checkEnrollment, checkListeners, checkPolicy, type Check } from "./doctor-local.mts";
import { defaultConfigDir } from "./launch-mode.mts";

// `kherep-node doctor` (issue #215): whether this host can take part, as JSON.
// Any failed check makes ok false and the command exit 1. The report holds
// ids, versions, counts, times and paths, never key material, tokens or
// message bodies.

// This checkout: node/ -> control-plane/ -> modules/ -> repository root.
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export interface DoctorDeps {
  paths: NodePaths;
  repoRoot?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  fetch?: typeof fetch;
  find?: (name: string) => string | null;
  versionOf?: VersionOf;
  pidAlive?: (pid: unknown) => boolean;
  now?: () => number;
}

export interface DoctorReport { ok: boolean; version: string | null; checks: Record<string, Check> }

function checkoutVersion(repoRoot: string): string | null {
  try {
    const version = (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

const notEnrolled: Check = { ok: false, detail: "needs an enrolled node" };

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const alive = deps.pidAlive ?? pidAlive;
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const { check: enrollment, config } = checkEnrollment(deps.paths);
  const { check: policy, policy: parsed } = checkPolicy(config?.policyFile ?? deps.paths.policy);
  const checks: Record<string, Check> = {
    enrollment,
    daemon: checkDaemon(deps.paths, alive),
    worker: config ? await checkWorker(config.controlUrl, deps.fetch ?? fetch) : notEnrolled,
    policy,
    runtimes: await checkRuntimes(parsed?.sessions?.enabled ? parsed.sessions.runtimes : [],
      deps.find ?? findRuntime, deps.versionOf ?? runtimeVersion),
    hooks: checkHooks({
      claude: path.join(deps.claudeConfigDir ?? defaultConfigDir(), "settings.json"),
      codex: path.join(deps.codexHome ?? codexHome(), "config.toml"),
    }, repoRoot),
    listeners: checkListeners(deps.paths, alive, deps.now?.() ?? Date.now()),
  };
  return { ok: Object.values(checks).every((check) => check.ok), version: checkoutVersion(repoRoot), checks };
}

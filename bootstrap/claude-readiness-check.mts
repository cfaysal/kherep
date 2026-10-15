#!/usr/bin/env node
// Issue #403. Claude sign-in around the install's deps phase, which runs the
// claude CLI (npm globals, plugins, the MCP registry):
//   precheck        warns when claude already reports no sign-in, so a sign-out
//                   from before the install is not blamed on it; never fails.
//   pause <owner>   writes the install lock an enrolled Kherep node's daemon
//                   honours by deferring its Claude probe (install-pause.mts).
//   resume <owner>  removes that lock again, only when <owner> wrote it.
//   check           runs the daemon's own readiness probe once. `claude auth
//                   status` is no proof: it reported loggedIn true for an
//                   expired login (runtime-probe.mts). Exit 1 only when the
//                   sign-in is lost; a timeout or another failure proves nothing.
// The claude command resolves as for reconcile-plugins.mts (KHEREP_CLAUDE_BIN).

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { configRoot, nodePaths } from "../modules/control-plane/node/config.mts";
import { installPauseFile } from "../modules/control-plane/node/install-pause.mts";
import { probeRuntime, spawnProbe, type ProbeResult } from "../modules/control-plane/node/runtime-probe.mts";
import { getClaudeCommand } from "./reconcile-plugins.mts";

const PRECHECK_TIMEOUT_MS = 15_000;
const SIGN_IN_HELP = "run 'claude auth login'";

// The CLI's renewal-lock message: another process renews the login (errors.md
// "Could not refresh your login": "This message doesn't mean your login was rejected").
const RENEWAL_BUSY = /another claude code process/i;

function verdict(result: ProbeResult): { code: 0 | 1; line: string } {
  if (result.ok) return { code: 0, line: "install: claude ready" };
  const detail = result.detail ? `: ${result.detail}` : "";
  if (RENEWAL_BUSY.test(result.detail)) return { code: 0, line: `install: claude probe inconclusive (login renewal busy${detail})` };
  if (result.cause === "sign-in") {
    return { code: 1, line: `install: WARNING claude SIGN-IN LOST (${result.detail || "sign-in required"}) - ${SIGN_IN_HELP}` };
  }
  const cause = result.cause === "timeout" ? "probe timed out" : "probe failed";
  return { code: 0, line: `install: claude probe inconclusive (${cause}${detail})` };
}

export async function checkReadiness(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: 0 | 1; line: string }> {
  let command: ReturnType<typeof getClaudeCommand>;
  try {
    command = getClaudeCommand(options.env ?? process.env);
  } catch (error) {
    return verdict({ ok: false, cause: "error", detail: (error as Error).message });
  }
  const spawn = spawnProbe();
  const result = await probeRuntime("claude", {
    findClaude: () => command.executable, cwd: os.tmpdir(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    run: (file, args, spawnOptions) => spawn(file, file === command.executable ? [...command.prefixArgs, ...args] : args, spawnOptions),
  });
  return verdict(result);
}

function precheck(env: NodeJS.ProcessEnv = process.env): string | null {
  const unreadable = "install: claude sign-in status unreadable before the deps phase";
  let status: unknown;
  try {
    const command = getClaudeCommand(env);
    const out = childProcess.spawnSync(command.executable, [...command.prefixArgs, "auth", "status", "--json"], {
      encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "ignore"], timeout: PRECHECK_TIMEOUT_MS, windowsHide: true });
    status = JSON.parse(out.stdout ?? "");
  } catch {
    return unreadable;
  }
  if (typeof status !== "object" || status === null) return unreadable;
  const { authMethod, loggedIn } = status as { authMethod?: unknown; loggedIn?: unknown };
  if (authMethod !== "none" && loggedIn !== false) return null;
  return "install: WARNING claude reports no sign-in before the deps phase (authMethod none);"
    + ` this install did not sign it out - ${SIGN_IN_HELP}`;
}

// The node directory exists only on an enrolled node; without it no daemon
// probes, and the installer creates nothing there.
function pause(owner: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const paths = nodePaths(configRoot(env));
  if (!fs.statSync(paths.dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  fs.writeFileSync(installPauseFile(paths), `pid=${owner}\nstartedAt=${new Date().toISOString()}\n`, { mode: 0o600 });
  return "install: Kherep node Claude probe paused for the deps phase";
}

function resume(owner: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const file = installPauseFile(nodePaths(configRoot(env)));
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (text.split("\n")[0] !== `pid=${owner}`) return null;
  fs.rmSync(file, { force: true });
  return "install: Kherep node Claude probe resumed";
}

async function cli(argv: string[]): Promise<number> {
  const [action, owner] = argv;
  const print = (line: string | null): void => { if (line) process.stdout.write(`${line}\n`); };
  if (action === "check" && argv.length === 1) {
    const result = await checkReadiness();
    print(result.line);
    return result.code;
  }
  if (action === "precheck" && argv.length === 1) { print(precheck()); return 0; }
  if ((action === "pause" || action === "resume") && argv.length === 2 && /^\d+$/.test(owner)) {
    print(action === "pause" ? pause(owner) : resume(owner));
    return 0;
  }
  process.stderr.write("usage: claude-readiness-check.mts check | precheck | pause <pid> | resume <pid>\n");
  return 2;
}

// As reconcile-plugins.mts: the main module may be reached through a symlink.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = await cli(process.argv.slice(2));

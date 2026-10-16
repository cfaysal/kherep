// Issue #436. The bodies of the stable launcher files under <configRoot>/bin/.
// The launcher is self-contained: it imports only Node built-ins, never a
// module of a source pin, because the pin it runs is the one it has to find.
// launcher.mts renders these bodies and keeps resolveLauncher() in step with
// the resolution below; launcher.test.mts runs both against the same fixtures.

// Fixed failure texts, shared by the generated launcher and resolveLauncher().
export const LAUNCHER_REASONS = Object.freeze({
  missing: "no managed service receipt",
  invalid: "the managed service receipt is invalid",
  "missing-pin": "the receipt's source pin is missing",
  "missing-cli": "the receipt's source pin has no Control Plane CLI",
  spawn: "the receipt's Node executable could not be started",
});

export const LAUNCHER_HINT = `run "kherep-node service install|upgrade" from a clean checkout`;

const HEADER = "Managed by Kherep (issue #436): the stable Control Plane command. Rewritten by kherep-node service; do not edit.";

// The config root is derived as config.mts configRoot() does, so the CLI the
// launcher starts and the receipt it reads name the same directory.
export const LAUNCHER_SCRIPT = `// ${HEADER}
// Runs the Control Plane CLI of the active managed service pin named by
// <configRoot>/control-plane/service/receipt.json and fails closed without it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const reasons = ${JSON.stringify(LAUNCHER_REASONS)};

function configRoot(env) {
  if (env.KHEREP_CONFIG_DIR) return path.resolve(env.KHEREP_CONFIG_DIR);
  if (process.platform === "win32") return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "kherep");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "kherep");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "kherep");
}

const receiptFile = path.join(configRoot(process.env), "control-plane", "service", "receipt.json");

function fail(reason) {
  process.stderr.write(\`kherep-node: \${reasons[reason]}; receipt \${receiptFile}; ${LAUNCHER_HINT}\\n\`);
  process.exit(1);
}

function isFile(file) {
  try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
}

function resolve() {
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")); }
  catch (error) { fail(error?.code === "ENOENT" ? "missing" : "invalid"); }
  const binding = receipt?.binding;
  const source = binding?.source;
  if (receipt?.version !== 1 || source?.kind !== "pin" || source.verified !== true
    || typeof source.root !== "string" || !path.isAbsolute(source.root)
    || typeof binding.nodeExecutable !== "string" || !path.isAbsolute(binding.nodeExecutable)
    || typeof source.commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.commit)) fail("invalid");
  if (!isFile(path.join(source.root, ".kherep-source.json"))) fail("missing-pin");
  const cli = path.join(source.root, "modules", "control-plane", "node", "cli.mts");
  if (!isFile(cli)) fail("missing-cli");
  return { node: binding.nodeExecutable, cli };
}

const target = resolve();
const child = spawn(target.node, [target.cli, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
// The terminal delivers Ctrl+C to the child itself; a SIGTERM aimed at the launcher is passed on.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => { if (process.platform !== "win32") child.kill("SIGTERM"); });
child.on("error", () => fail("spawn"));
child.on("exit", (code) => process.exit(code ?? 1));
`;

// The shims are for humans; agents run `node "<configRoot>/bin/kherep-node.mjs"`.
// The paths are checked by launcher.mts before they are placed in double quotes.
export function posixShim(nodeExecutable: string, script: string): string {
  return `#!/bin/sh\n# ${HEADER}\nexec "${nodeExecutable}" "${script}" "$@"\n`;
}

export function cmdShim(nodeExecutable: string): string {
  return `@REM ${HEADER}\r\n@"${nodeExecutable}" "%~dp0kherep-node.mjs" %*\r\n`;
}

export function ps1Shim(nodeExecutable: string): string {
  return `# ${HEADER}\n& "${nodeExecutable}" "$PSScriptRoot\\kherep-node.mjs" @args\nexit $LASTEXITCODE\n`;
}

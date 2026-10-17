import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import { captureSourceIdentity, compareSourceIdentity } from "./daemon-source.mts";
import type { Check } from "./doctor-local.mts";
import { INTERCOM_INSTRUCTIONS, expectedIntercomText, intercomCommand, intercomInstructionFiles } from "./intercom-instructions.mts";
import { LAUNCHER_FILE, renderLauncher, resolveLauncher, type LauncherFile } from "./launcher.mts";
import { LAUNCHER_REASONS } from "./launcher-template.mts";
import { readServiceReceipt, type ServiceReceipt } from "./service-records.mts";

// Issue #436. The intercom check of `kherep-node doctor`: whether the stable
// command `node "<configRoot>/bin/kherep-node.mjs"` works on this host and the
// five instruction files name it. It reads the service receipt, the launcher
// files, the receipt's source pin (verified in full, once per doctor run; the
// launcher itself never does) and the instruction files. The report holds
// paths and fixed statuses only, never file contents. A failed read is
// "unreadable", never "missing".

type Read = Buffer | "missing" | "unreadable";
type Resolves = "match" | "missing-pin" | "missing-cli" | "mismatch";

export interface IntercomDeps { paths: NodePaths; claudeConfigDir: string; codexHome: string }

const SHIMS: Readonly<Record<string, string>> = { "kherep-node": "posix", "kherep-node.cmd": "cmd", "kherep-node.ps1": "ps1" };

function read(file: string): Read {
  try { return fs.readFileSync(file); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Present: the file holds the exact expected text (intercom-instructions.mts);
// the managed rules file must be exactly that text, nothing besides it.
function instructionStatuses(deps: IntercomDeps, command: string): Record<string, string> {
  const files = intercomInstructionFiles(deps.claudeConfigDir, deps.codexHome);
  return Object.fromEntries(INTERCOM_INSTRUCTIONS.map((kind) => {
    const bytes = read(files[kind]);
    if (typeof bytes === "string") return [kind, bytes];
    const text = bytes.toString("utf8");
    const expected = expectedIntercomText(kind, command);
    return [kind, (kind === "codexRules" ? text === expected : text.includes(expected)) ? "present" : "stale"];
  }));
}

// The launcher resolves the receipt's pin, and that pin's files verify against
// the commit and digest the receipt recorded.
function resolves(root: string, receipt: ServiceReceipt): Resolves {
  const resolution = resolveLauncher(root);
  if (!resolution.ok) return resolution.reason === "missing-pin" || resolution.reason === "missing-cli" ? resolution.reason : "mismatch";
  try {
    return compareSourceIdentity(receipt.binding.source, captureSourceIdentity(resolution.pin)).status === "match" ? "match" : "mismatch";
  } catch { return "mismatch"; }
}

function receiptOf(paths: NodePaths): { status: "valid" | "missing" | "invalid"; receipt?: ServiceReceipt } {
  try {
    const receipt = readServiceReceipt(paths);
    return receipt ? { status: "valid", receipt } : { status: "missing" };
  } catch { return { status: "invalid" }; }
}

const RESOLVE_DETAIL: Readonly<Record<Exclude<Resolves, "match">, string>> = {
  "missing-pin": LAUNCHER_REASONS["missing-pin"],
  "missing-cli": LAUNCHER_REASONS["missing-cli"],
  mismatch: "the receipt's source pin does not verify against the receipt",
};

export function checkIntercom(deps: IntercomDeps): Check {
  const root = path.dirname(deps.paths.dir);
  const { status, receipt } = receiptOf(deps.paths);
  const managed = status !== "missing";
  let command: string;
  try { command = intercomCommand(root); } catch {
    return { ok: false, managed, receipt: status, detail: "the intercom command cannot be rendered for this config root" };
  }
  const instructions = instructionStatuses(deps, command);
  const fail = (detail: string): Check => ({ ok: false, managed, receipt: status, instructions, detail });
  if (!receipt) {
    return fail(managed ? "the managed service receipt is invalid" : "no managed service; the intercom command cannot resolve a pin");
  }
  let files: LauncherFile[];
  try {
    files = renderLauncher({ platform: receipt.binding.platform, configRoot: root, nodeExecutable: receipt.binding.nodeExecutable });
  } catch { return fail("the launcher cannot be rendered for this config root"); }
  const launcher = { path: path.join(root, "bin", LAUNCHER_FILE), status: "" };
  const shims: Record<string, string> = {};
  for (const file of files) {
    const bytes = read(path.join(root, "bin", file.name));
    const state = typeof bytes === "string" ? bytes : bytes.equals(Buffer.from(file.content, "utf8")) ? "current" : "stale";
    if (file.name === LAUNCHER_FILE) launcher.status = state;
    else shims[SHIMS[file.name]] = state;
  }
  const resolved = resolves(root, receipt);
  const node = isFile(receipt.binding.nodeExecutable) ? "present" : "missing";
  let detail: string | undefined;
  if (launcher.status !== "current" || Object.values(shims).some((state) => state !== "current")) {
    detail = "the launcher files are missing or not the current renderer's bytes; run kherep-node service upgrade";
  } else if (resolved !== "match") detail = RESOLVE_DETAIL[resolved];
  else if (node !== "present") detail = "the receipt's Node executable is missing";
  else if (Object.values(instructions).some((state) => state !== "present")) {
    detail = "an instruction file does not name the intercom command; rerun the installers";
  }
  return { ok: !detail, managed, receipt: status, launcher, shims, resolves: resolved, node, instructions, ...(detail ? { detail } : {}) };
}

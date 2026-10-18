#!/usr/bin/env node
// Issue #503. The stable entry point of the Control Plane hooks, installed as
// <CODEX_HOME>/hooks/kherep-maestro/codex-control-plane-hook.mts. Every Codex
// hook command names this file, so the commands and their Codex trust hashes
// stay the same across upgrades. It runs the hook of the source the Codex
// installer last ran from, named by <CODEX_HOME>/orchestra/control-plane-source.json,
// and fails closed without it. Node built-ins only: the source it runs is the one
// it has to find.
//
// The check per run is the pointer's shape and the existence of the hook file
// (and of the manifest of a source pin), the depth of the stable msg launcher.
// It is not a verified load: `kherep-node doctor` verifies the source identity.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ENTRY_NAME = "codex-control-plane-hook.mts";
// The only hooks this entry point runs. argv selects an entry, never a path.
const HOOKS: Readonly<Record<string, string>> = Object.freeze({ deliver: "deliver-hook.mts", attribution: "attribution-hook.mts" });

export const POINTER_REASONS = Object.freeze({
  missing: "no control-plane source pointer",
  invalid: "the control-plane source pointer is invalid",
  name: "unknown hook name",
  "missing-manifest": "the pointer's source pin has no manifest",
  "missing-hook": "the pointer's source has no such hook",
  spawn: "the hook could not be started",
});
export type PointerReason = keyof typeof POINTER_REASONS;

export interface ControlPlanePointer { version: 1; root: string; commit?: string; kind: "pin" | "checkout"; verified: boolean }

export function pointerFile(codexHome: string): string {
  return path.join(codexHome, "orchestra", "control-plane-source.json");
}

// The install this file belongs to; run from anywhere else, CODEX_HOME or ~/.codex.
function installedCodexHome(): string {
  const dir = import.meta.dirname;
  if (path.basename(dir) === "kherep-maestro" && path.basename(path.dirname(dir)) === "hooks") return path.dirname(path.dirname(dir));
  const home = process.env.CODEX_HOME;
  return home && path.isAbsolute(home) ? home : path.join(os.homedir(), ".codex");
}

const isFile = (file: string): boolean => {
  try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
};

export function readPointer(file: string): { pointer: ControlPlanePointer } | { reason: PointerReason } {
  let value: Partial<ControlPlanePointer> | null;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ControlPlanePointer> | null; }
  catch (error) { return { reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "invalid" }; }
  if (!value || value.version !== 1 || typeof value.root !== "string" || !path.isAbsolute(value.root)
    || (value.kind !== "pin" && value.kind !== "checkout") || typeof value.verified !== "boolean"
    || (value.commit !== undefined && (typeof value.commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.commit)))) {
    return { reason: "invalid" };
  }
  return { pointer: value as ControlPlanePointer };
}

// The hook file the pointer names for `name`, or why there is none.
export function resolveHook(name: string | undefined, file: string): { hook: string; pointer: ControlPlanePointer } | { reason: PointerReason } {
  const read = readPointer(file);
  if ("reason" in read) return read;
  if (!name || !Object.hasOwn(HOOKS, name)) return { reason: "name" };
  const { root, kind } = read.pointer;
  if (kind === "pin" && !isFile(path.join(root, ".kherep-source.json"))) return { reason: "missing-manifest" };
  const hook = path.join(root, "modules", "control-plane", "node", HOOKS[name]);
  return isFile(hook) ? { hook, pointer: read.pointer } : { reason: "missing-hook" };
}

// For the shell dispatcher, which imports the attribution hook in-process.
export function resolveControlPlaneHook(name: "deliver" | "attribution", file = pointerFile(installedCodexHome())): string {
  const resolved = resolveHook(name, file);
  if ("reason" in resolved) throw new Error(POINTER_REASONS[resolved.reason]);
  return resolved.hook;
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try { return [path.resolve(entry), fs.realpathSync(entry)].some((file) => import.meta.url === pathToFileURL(file).href); } catch { return false; }
}

if (isMainModule()) {
  const file = pointerFile(installedCodexHome());
  const fail = (reason: PointerReason): void => {
    process.stderr.write(`kherep control-plane-hook: ${POINTER_REASONS[reason]}; pointer ${file}; run codex/install.mts\n`);
    process.exitCode = 1;
  };
  const resolved = resolveHook(process.argv[2], file);
  if ("reason" in resolved) fail(resolved.reason);
  else {
    // The hook runs as its own main module, with this process's stdin, stdout,
    // stderr, environment and working directory, and no Node options of its
    // own; its exit code is passed on. The rendered hook command starts this
    // process with --disable-warning=ExperimentalWarning, so on the Node
    // versions that warn about type stripping only the hook warns, exactly as a
    // direct hook call does, and every warning of the hook itself still shows.
    const child = spawnSync(process.execPath, [resolved.hook, ...process.argv.slice(3)], { stdio: "inherit", windowsHide: true });
    if (child.error) fail("spawn");
    else process.exitCode = child.status ?? 1;
  }
}

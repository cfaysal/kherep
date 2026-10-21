#!/usr/bin/env node
// Issue #592. The pointer the stable Claude Control Plane entry point reads,
// <CLAUDE_HOME>/kherep/control-plane/source.json: the source root the installer
// runs from, in the record codex/lib/control-plane-pointer.mts renders for the
// Codex entry point (issue #503), so both runtimes share one shape.
//
//   render <repoRoot> <out>        install.sh preflight; install_path installs it
//   check <claudeHome> <repoRoot>  drift-check.sh: 0 ok, 3 drift, 1 error
//
// The check compares what the hooks run with what this source would install, by
// identity, not by root: a pointer to a pin of this commit is in sync with the
// checkout of the same commit (#595 made the settings merge root-neutral; the
// pointer follows). A pointer whose source lacks the hook of any stable name
// (deliver, wake, attribution) is drift: that hook fails closed until install.sh
// runs again.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { pointerFile, readPointer, resolveHook } from "../claude/kherep/control-plane/claude-control-plane-hook.mts";
import { renderControlPlanePointer } from "../codex/lib/control-plane-pointer.mts";
import { captureSourceIdentity } from "../modules/control-plane/node/daemon-source.mts";
import { errorMessage } from "./shape.mts";

export type PointerVerdict = { line: string; drift: boolean };

// One report line for drift-check.sh. The root is printed only in the ok line, as information.
export function checkPointer(claudeHome: string, repoRoot: string): PointerVerdict {
  const rel = "kherep/control-plane/source.json";
  const file = pointerFile(claudeHome);
  const read = readPointer(file);
  if ("reason" in read) return { line: read.reason === "missing" ? `MISSING-LIVE  ${rel}` : `POINTER-INVALID ${rel}`, drift: true };
  // Every name a stable command runs; the first that does not resolve is reported.
  for (const name of ["deliver", "wake", "attribution"]) {
    const resolved = resolveHook(name, file);
    if ("reason" in resolved) {
      return { line: `POINTER-UNRESOLVED ${rel} (${resolved.reason}: the pointer's source cannot run the ${name} hook)`, drift: true };
    }
  }
  let expected: string | undefined;
  try { expected = captureSourceIdentity(repoRoot, false).commit; } catch { /* no identity: compared by presence only */ }
  const { commit: live, kind } = read.pointer;
  if (expected && live && expected !== live) {
    return { line: `POINTER-STALE ${rel} (commit ${live.slice(0, 7)} != ${expected.slice(0, 7)})`, drift: true };
  }
  const identity = live ? `${kind} ${live.slice(0, 7)}` : `${kind} unverified`;
  return { line: `ok            ${rel} (${identity})`, drift: false };
}

function main(argv: string[]): number {
  const [mode, first, second] = argv;
  if (mode === "render" && first && second) {
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(second, renderControlPlanePointer(path.resolve(first)), { mode: 0o600 });
    return 0;
  }
  if (mode === "check" && first && second) {
    const verdict = checkPointer(first, second);
    console.log(verdict.line);
    return verdict.drift ? 3 : 0;
  }
  throw new Error("usage: render <repoRoot> <out> | check <claudeHome> <repoRoot>");
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch { return false; }
}

if (isMainModule()) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`FATAL: control-plane pointer: ${errorMessage(error)}`); process.exitCode = 1; }
}

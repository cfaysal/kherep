import fs from "node:fs";
import path from "node:path";

import { captureSourceIdentity, SOURCE_MANIFEST, type SourceIdentity } from "../../modules/control-plane/node/daemon-source.mts";
import type { ControlPlanePointer } from "../hooks/control-plane-hook.mts";

export { pointerFile } from "../hooks/control-plane-hook.mts";

// Issue #503. The record the stable Control Plane hook entry point reads: the
// source root this installer runs from, with its identity when it can be read.
// A failed identity read still names the root, unverified.
export function renderControlPlanePointer(
  repoRoot: string, capture: (root: string, requireClean: boolean) => SourceIdentity = captureSourceIdentity,
): string {
  let identity: SourceIdentity | undefined;
  try { identity = capture(repoRoot, false); } catch { /* stays unverified */ }
  const pointer: ControlPlanePointer = identity
    ? { version: 1, root: repoRoot, commit: identity.commit, kind: identity.kind, verified: identity.verified }
    : { version: 1, root: repoRoot, kind: fs.existsSync(path.join(repoRoot, SOURCE_MANIFEST)) ? "pin" : "checkout", verified: false };
  return `${JSON.stringify(pointer, null, 2)}\n`;
}

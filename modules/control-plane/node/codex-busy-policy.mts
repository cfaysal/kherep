import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import type { NodePolicy } from "./policy.mts";

export function busyPolicyFingerprint(policy: NodePolicy): string {
  return crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

// Same existing node kill switch, without loading Claude's wake listener.
export const busyWakeDisabled = (paths: NodePaths): boolean => fs.existsSync(path.join(paths.dir, "wake.disabled"));

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateServiceName } from "./service-platform-mac.mts";
import type { ServiceBinding } from "./service-types.mts";

// #582 (status on an unattested read): the digest of the configured macOS plist without any launchd attestation,
// so `service status` can say whether the file on disk is a recorded definition before it names a reload.
// null: no regular file at the configured path (absent, symlink, directory, unreadable, invalid name). Never returns
// bytes or a path and never throws (A2 P3-4). O_NOFOLLOW plus fstat on the open descriptor closes the lstat/read race;
// where the flag does not exist (Windows) the open would follow a symlink, so the helper reads nothing (PR #599 P1-1).
export function configuredDefinitionDigest(binding: ServiceBinding, home = os.homedir()): string | null {
  if (binding.platform !== "darwin" || fs.constants.O_NOFOLLOW === undefined) return null;
  let fd: number | undefined;
  try {
    const file = path.join(home, "Library", "LaunchAgents", `${validateServiceName(binding.serviceName)}.plist`);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

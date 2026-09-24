// OP-1137. Kanonisierung eines Pfades über das echte Dateisystem, ab dieser
// Welle TypeScript. Verhalten unverändert.

import fs from "node:fs";
import path from "node:path";
import { normalizePathLike } from "./workspace-scope.mts";

// Der Plattform-Schalter ist ein Wert aus process.platform, kein freier String:
// nur "win32" verzweigt, alles andere ist der POSIX-Zweig. Als Union getypt,
// damit ein Tippfehler im Aufruf nicht still in den POSIX-Zweig fällt.
export type Platform = NodeJS.Platform;

export function nativeAbsolutePath(value: unknown, platform: Platform = process.platform): string {
  const normalized = normalizePathLike(value);
  if (!normalized || normalized.length > 4096 || /[\r\n\0]/.test(normalized)) return "";
  if (platform === "win32") {
    if (/^[A-Za-z]:\//.test(normalized)) return normalized;
    const mount = normalized.match(/^\/([A-Za-z])(?:\/(.*))?$/);
    return mount ? `${mount[1]}:/${mount[2] || ""}` : "";
  }
  return normalized.startsWith("/") ? normalized : "";
}

// Resolve the nearest existing ancestor, then append any missing/glob suffix.
// This catches reads and writes through directory symlinks without requiring
// the final target to exist. Non-native/test-only path formats return empty and
// continue through the caller's provider-neutral lexical checks.
export function canonicalPathLike(value: unknown, platform: Platform = process.platform): string {
  let candidate = nativeAbsolutePath(value, platform);
  if (!candidate) return "";
  const suffix: string[] = [];
  try {
    while (!fs.existsSync(candidate)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) return "";
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
    return normalizePathLike(path.join(fs.realpathSync(candidate), ...suffix));
  } catch {
    return "";
  }
}

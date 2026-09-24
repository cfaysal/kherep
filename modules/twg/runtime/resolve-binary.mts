import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fail } from "./errors.mts";

function productEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}

export interface ResolveTwgBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  pathApi?: path.PlatformPath;
  homedir?: string;
  exists?: (candidate: string) => boolean;
}

function defaultExists(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true;
}

function pathCandidates(env: NodeJS.ProcessEnv, platform: string, pathApi: path.PlatformPath): string[] {
  const names = platform === "win32"
    ? [...new Set([".EXE", ...(env.PATHEXT || ".EXE;.CMD").split(";")])].map((ext) => `twg${ext.toLowerCase()}`)
    : ["twg"];
  const entries = String(env.PATH || "").split(pathApi.delimiter).filter(Boolean);
  return entries.flatMap((entry) => names.map((name) => pathApi.join(entry, name)));
}

export function resolveTwgBinary(options: ResolveTwgBinaryOptions = {}): string {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathApi = options.pathApi || path;
  const homedir = options.homedir || os.homedir();
  const exists = options.exists || defaultExists;
  const explicit = productEnv(env, "TWG_BIN");
  if (explicit !== undefined) {
    if (!pathApi.isAbsolute(explicit) || !exists(explicit)) {
      fail("TWG_BINARY_INVALID", "The configured TWG executable is unavailable.");
    }
    return explicit;
  }

  const discovered = pathCandidates(env, platform, pathApi).find(exists);
  if (discovered) return discovered;
  const fallback = platform === "win32"
    ? [
      pathApi.join(env.LOCALAPPDATA || pathApi.join(homedir, "AppData", "Local"), "Programs", "twg", "bin", "twg.exe"),
      pathApi.join(env.ProgramFiles || "C:\\Program Files", "twg", "twg.exe"),
    ]
    : [
      pathApi.join(homedir, ".local", "bin", "twg"),
      "/opt/homebrew/bin/twg",
      "/usr/local/bin/twg",
    ];
  const found = fallback.find(exists);
  if (found) return found;
  fail("TWG_BINARY_MISSING", "TWG is not installed in a supported location.");
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { codexHome } from "./codex-app.mts";
import { codexCommand } from "./codex-binary.mts";
import type { CodexDeps } from "./codex-process.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";

const MAX_APPROVED_FILE_BYTES = 512 * 1024 * 1024;
const ROUTE_MARKERS = new Set([
  "CODEX_EXEC_SERVER_URL", "CODEX_SQLITE_HOME", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE",
]);

function approvedFile(file: string, deadlineAt: number): { path: string; realpath: string; sha256: string } {
  const absolute = path.resolve(file);
  if (fs.statSync(absolute).size > MAX_APPROVED_FILE_BYTES) throw new Error("Codex executable is too large to identify");
  const hash = createHash("sha256");
  const descriptor = fs.openSync(absolute, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      if (Date.now() > deadlineAt) throw new Error("Codex executable identity timed out");
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { path: absolute, realpath: fs.realpathSync(absolute), sha256: hash.digest("hex") };
}

export function localQueueRoute(home: string, env: NodeJS.ProcessEnv = process.env,
  stat: (file: string) => fs.Stats = (file) => fs.lstatSync(file)): "local" | "unknown" {
  if (Object.keys(env).some((key) => {
    const normalized = key.toUpperCase();
    return ROUTE_MARKERS.has(normalized) || normalized.startsWith("CODEX_EXEC_SERVER_NOISE_");
  })) return "unknown";
  try {
    stat(path.join(home, "environments.toml"));
    return "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "local" : "unknown";
  }
}

export function queueProducerIdentity(file: string, args: string[], deps: { codex?: CodexDeps },
  env: NodeJS.ProcessEnv = process.env, deadlineAt: number = Date.now() + 1_000): QueueProducerIdentity {
  const platform = deps.codex?.platform ?? process.platform;
  const command = codexCommand(file, args, platform);
  const prefixLength = command.args.length - args.length;
  const home = path.resolve(deps.codex?.home ?? codexHome(env));
  let route = localQueueRoute(home, env);
  let approvedFiles: QueueProducerIdentity["approvedFiles"] = [];
  if (route === "local") {
    try {
      approvedFiles = [...new Set([file, command.file, ...command.args.slice(0, prefixLength)])]
        .map((candidate) => approvedFile(candidate, deadlineAt));
    } catch {
      route = "unknown";
    }
  }
  return {
    codexExecutable: path.resolve(file), launchFile: path.resolve(command.file),
    launchPrefix: command.args.slice(0, prefixLength).map((value) => path.resolve(value)),
    approvedFiles, resolvedCodexHome: home, route,
  };
}

function executableMagic(file: string): Buffer {
  const descriptor = fs.openSync(file, "r");
  const magic = Buffer.alloc(4);
  try { fs.readSync(descriptor, magic, 0, magic.length, 0); } finally { fs.closeSync(descriptor); }
  return magic;
}

export function isDirectNativeQueueIdentity(identity: QueueProducerIdentity,
  readMagic: (file: string) => Buffer = executableMagic): boolean {
  if (identity.route !== "local" || identity.launchPrefix.length !== 0
    || identity.codexExecutable !== identity.launchFile || identity.approvedFiles.length !== 1) return false;
  let magic: string;
  try { magic = readMagic(identity.launchFile).toString("hex"); } catch { return false; }
  return magic.startsWith("4d5a") || magic === "7f454c46"
    || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(magic);
}

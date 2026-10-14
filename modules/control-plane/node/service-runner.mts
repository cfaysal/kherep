#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { nodePaths, readConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { serviceSelector, supportedServicePlatform } from "./service-platform.mts";

export interface ServiceRunnerArgs { configDir: string; serviceName: string; taskPath?: string; workspace: string }

export function parseServiceRunnerArgs(argv: string[], platform: NodeJS.Platform = process.platform): ServiceRunnerArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, strict: true, options: {
      "config-dir": { type: "string" }, "service-name": { type: "string" }, "task-path": { type: "string" }, workspace: { type: "string" },
    } });
  } catch { throw new Error("usage: service-runner --config-dir <absolute> --service-name <name> [--task-path <path>] --workspace <absolute>"); }
  const configDir = parsed.values["config-dir"];
  const serviceName = parsed.values["service-name"];
  const taskPath = parsed.values["task-path"];
  const workspace = parsed.values.workspace;
  if (typeof configDir !== "string" || typeof serviceName !== "string" || typeof workspace !== "string"
    || (taskPath !== undefined && typeof taskPath !== "string") || !path.isAbsolute(configDir) || !path.isAbsolute(workspace)) {
    throw new Error("service runner paths must be absolute");
  }
  const service = serviceSelector(supportedServicePlatform(platform), serviceName, taskPath);
  return { configDir: path.resolve(configDir), ...service, workspace: path.resolve(workspace) };
}

async function run(argv: string[]): Promise<void> {
  const args = parseServiceRunnerArgs(argv);
  const paths = nodePaths(args.configDir);
  const config = readConfig(paths.config);
  if (!config) throw new Error("managed daemon service is not enrolled");
  process.chdir(args.workspace);
  const platform = supportedServicePlatform();
  const daemon = startDaemon(config, paths, undefined, undefined, undefined,
    { name: args.serviceName, platform, ...(args.taskPath ? { taskPath: args.taskPath } : {}) });
  const stop = () => daemon.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await daemon.done;
}

function isMainModule(): boolean {
  const entry = process.argv[1] ?? "";
  try { return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { return false; }
}

if (isMainModule()) run(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`kherep-node service: ${(error as Error).message ?? String(error)}`);
  process.exitCode = 1;
});

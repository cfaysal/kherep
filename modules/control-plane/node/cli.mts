#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { nodePaths, readConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { nodeStatus, onboard, unenroll } from "./onboard.mts";

// kherep-node: node side of the Kherep Control Plane, Phase 1.
//
//   node cli.mts node onboard --url https://control.example.com --code <code> [--name <name>]
//   node cli.mts node status
//   node cli.mts node unenroll
//   node cli.mts daemon
//
// The enrollment code can also come from KHEREP_ENROLL_CODE so it stays out of
// shell history. KHEREP_CONFIG_DIR overrides the config location.
const USAGE = `usage:
  kherep-node node onboard --url <https origin> --code <enrollment code> [--name <name>]
  kherep-node node status
  kherep-node node unenroll
  kherep-node daemon`;

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { url: { type: "string" }, code: { type: "string" }, name: { type: "string" } },
  });
  const paths = nodePaths();
  const [group, action] = positionals;

  if (group === "daemon") {
    const config = readConfig(paths.config);
    if (!config) throw new Error(`not enrolled (${paths.config}); run "kherep-node node onboard" first`);
    const daemon = startDaemon(config);
    const stop = () => daemon.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await daemon.done;
    return 0;
  }
  if (group !== "node") {
    console.error(USAGE);
    return 2;
  }
  if (action === "onboard") {
    const code = values.code ?? process.env.KHEREP_ENROLL_CODE;
    if (!values.url || !code) {
      console.error(USAGE);
      return 2;
    }
    const config = await onboard({ controlUrl: values.url, code, ...(values.name ? { name: values.name } : {}), paths });
    console.log(JSON.stringify({ enrolled: true, nodeId: config.nodeId, name: config.name, config: paths.config }, null, 2));
    return 0;
  }
  if (action === "status") {
    console.log(JSON.stringify(nodeStatus(paths), null, 2));
    return 0;
  }
  if (action === "unenroll") {
    const { nodeId } = unenroll(paths);
    console.log(JSON.stringify({
      unenrolled: nodeId !== null, nodeId,
      next: nodeId ? `ask an operator to revoke it: DELETE /api/nodes/${nodeId}` : "nothing was enrolled",
    }, null, 2));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) only matches after realpath.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(`kherep-node: ${(error as Error).message ?? String(error)}`);
    process.exitCode = 1;
  });
}

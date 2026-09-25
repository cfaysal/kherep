import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { decision } from "./acceptance-policy.mts";

export { decision } from "./acceptance-policy.mts";
export type { StopInput, StopDecision } from "./acceptance-policy.mts";

function main(): void {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const result = decision(input);
  if (result) process.stdout.write(JSON.stringify(result));
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) only matches after realpath.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();

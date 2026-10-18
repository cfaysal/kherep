import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAvailableModels } from "../lib/model-catalog-process.mts";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch { return false; }
}

if (isMainModule()) {
  try { process.stdout.write(`${JSON.stringify(await readAvailableModels())}\n`); }
  catch { process.stderr.write("Unable to collect a complete Codex model catalog; installation must keep its existing resolution.\n"); process.exitCode = 1; }
}

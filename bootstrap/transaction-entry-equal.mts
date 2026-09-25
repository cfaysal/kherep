import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function relevantMode(stat: fs.Stats): number {
  return stat.mode & 0o7777;
}

export function entriesEqual(source: string, target: string): boolean {
  const sourceStat = fs.lstatSync(source);
  const targetStat = fs.lstatSync(target);
  if (sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) return false;
  if (sourceStat.isFile() !== targetStat.isFile()
      || sourceStat.isDirectory() !== targetStat.isDirectory()) return false;
  if (relevantMode(sourceStat) !== relevantMode(targetStat)) return false;
  if (sourceStat.isFile()) {
    return sourceStat.size === targetStat.size
      && fs.readFileSync(source).equals(fs.readFileSync(target));
  }
  if (!sourceStat.isDirectory()) throw new Error("unsupported transaction entry type");
  const sourceNames = fs.readdirSync(source).sort();
  const targetNames = fs.readdirSync(target).sort();
  if (sourceNames.length !== targetNames.length) return false;
  for (let index = 0; index < sourceNames.length; index += 1) {
    if (sourceNames[index] !== targetNames[index]) return false;
    if (!entriesEqual(path.join(source, sourceNames[index]), path.join(target, targetNames[index]))) {
      return false;
    }
  }
  return true;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  if (process.argv.length !== 4) process.exitCode = 2;
  else {
    try { process.exitCode = entriesEqual(process.argv[2], process.argv[3]) ? 0 : 1; }
    catch { process.exitCode = 2; }
  }
}

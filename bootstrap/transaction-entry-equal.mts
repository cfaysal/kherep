import fs from "node:fs";
import path from "node:path";

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

if (import.meta.main) {
  if (process.argv.length !== 4) process.exitCode = 2;
  else {
    try { process.exitCode = entriesEqual(process.argv[2], process.argv[3]) ? 0 : 1; }
    catch { process.exitCode = 2; }
  }
}

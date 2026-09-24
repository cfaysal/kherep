import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function walk(root: string): string[] {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin component symlink is not allowed: ${target}`);
    if (entry.isDirectory()) result.push(...walk(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

export function componentHash(root: string): string {
  const inputs = ["agents", "commands", "skills"]
    .flatMap((name) => walk(path.join(root, name)))
    .sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash("sha256");
  for (const file of inputs) {
    hash.update(path.relative(root, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

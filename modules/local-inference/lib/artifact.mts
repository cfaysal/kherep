// File boundaries of a run: inputs must sit under an approved root, the
// artifact must land under KHEREP_LOCAL_OUTPUT_ROOT without following a
// symlink out of it, and an existing artifact is never overwritten.
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { within } from "./profile.mts";

export interface InputFile { path: string; size: number; bytes: Buffer; content: string }

export function resolveInput(file: string | undefined, roots: string[]): InputFile {
  if (!file) throw new Error("--input-file requires a path");
  const real = fs.realpathSync(file);
  if (!roots.some((root) => within(real, root))) throw new Error("Input path is outside approved local roots");
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > 500_000) throw new Error("Input must be a file <= 500000 bytes");
  const bytes = fs.readFileSync(real);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Input must be valid UTF-8 text"); }
  return { path: real, size: stat.size, bytes, content };
}

export function outputPath(requested: string | undefined, id: string, root: string): string {
  const lexicalRoot = path.resolve(root);
  fs.mkdirSync(lexicalRoot, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(lexicalRoot);
  if (path.relative(realRoot, lexicalRoot) !== "") {
    throw new Error("KHEREP_LOCAL_OUTPUT_ROOT may not be a symlink");
  }
  const requestedTarget = path.resolve(requested || path.join(lexicalRoot, `${id}.json`));
  if (requestedTarget === lexicalRoot || !within(requestedTarget, lexicalRoot)) {
    throw new Error("Output path is outside KHEREP_LOCAL_OUTPUT_ROOT");
  }

  const requestedParent = path.dirname(requestedTarget);
  let ancestor = requestedParent;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Cannot resolve output parent");
    ancestor = parent;
  }
  if (!within(fs.realpathSync(ancestor), realRoot)) {
    throw new Error("Output parent escapes KHEREP_LOCAL_OUTPUT_ROOT through a symlink");
  }
  fs.mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  const target = path.join(fs.realpathSync(requestedParent), path.basename(requestedTarget));
  if (!within(target, realRoot)) {
    throw new Error("Output parent escapes KHEREP_LOCAL_OUTPUT_ROOT through a symlink");
  }
  try {
    fs.lstatSync(target);
    throw new Error("Output artifact already exists; refusing to overwrite it");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import type { ServiceBinding } from "./service-types.mts";

const file = (paths: NodePaths): string => path.join(paths.dir, "service", "launch-permit.json");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
};
const bindingDigest = (binding: ServiceBinding): string => crypto.createHash("sha256").update(canonical(binding)).digest("hex");

interface Permit { version: 1; generation: string; bindingDigest: string }
const expectedPermit = (binding: ServiceBinding): Permit => {
  if (binding.platform !== "win32" || !binding.supervisorGeneration) throw new Error("Windows supervisor generation is unavailable");
  return { version: 1, generation: binding.supervisorGeneration, bindingDigest: bindingDigest(binding) };
};
const read = (permitFile: string): { value: Permit; bytes: string } => {
  const stat = fs.lstatSync(permitFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("service launch permit is unsafe");
  }
  const bytes = fs.readFileSync(permitFile, "utf8");
  const value = JSON.parse(bytes) as Permit;
  if (value.version !== 1 || typeof value.generation !== "string" || typeof value.bindingDigest !== "string") {
    throw new Error("service launch permit is invalid");
  }
  return { value, bytes };
};
const matches = (left: Permit, right: Permit): boolean => left.version === right.version
  && left.generation === right.generation && left.bindingDigest === right.bindingDigest;

export function issueServiceLaunchPermit(paths: NodePaths, binding: ServiceBinding): () => void {
  const permitFile = file(paths);
  const bytes = `${JSON.stringify(expectedPermit(binding))}\n`;
  fs.mkdirSync(path.dirname(permitFile), { recursive: true, mode: 0o700 });
  let handle: number;
  try { handle = fs.openSync(permitFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    read(permitFile);
    const stale = `${permitFile}.stale-${process.pid}-${crypto.randomUUID()}`;
    fs.renameSync(permitFile, stale);
    fs.rmSync(stale);
    handle = fs.openSync(permitFile, "wx", 0o600);
  }
  fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); fs.closeSync(handle);
  return () => {
    try { if (fs.readFileSync(permitFile, "utf8") === bytes) fs.rmSync(permitFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}

export function claimServiceLaunchPermit(paths: NodePaths, binding: ServiceBinding): boolean {
  const permitFile = file(paths);
  let observed: ReturnType<typeof read>;
  try { observed = read(permitFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const expected = expectedPermit(binding);
  if (!matches(observed.value, expected)) return false;
  const claim = `${permitFile}.claim-${process.pid}-${crypto.randomUUID()}`;
  try { fs.renameSync(permitFile, claim); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const claimed = read(claim);
    if (claimed.bytes !== observed.bytes || !matches(claimed.value, expected)) {
      throw new Error("service launch permit changed during claim");
    }
    return true;
  } finally { fs.rmSync(claim, { force: true }); }
}

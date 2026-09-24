import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CompilerLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const EXPECTED_TYPESCRIPT_VERSION = "7.0.2";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Compiled output proof: ${message}`);
}

function readJson(file: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fail(`cannot read ${label}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`invalid ${label}`);
  return value as Record<string, unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`invalid ${label}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) return fail(`invalid ${label}`);
  return value;
}

function compilerPath(moduleRoot: string): string {
  const manifest = readJson(path.join(moduleRoot, "package.json"), "module package.json");
  const lock = readJson(path.join(moduleRoot, "package-lock.json"), "module package-lock.json");
  const installedRoot = path.join(moduleRoot, "node_modules", "typescript");
  const installed = readJson(path.join(installedRoot, "package.json"), "installed TypeScript compiler package.json");
  const packages = record(lock.packages, "module lock packages");
  const lockRoot = record(packages[""], "module root lock entry");
  const lockPackage = record(packages["node_modules/typescript"], "TypeScript lock package entry");
  const versions = [
    text(record(manifest.devDependencies, "module devDependencies").typescript, "module TypeScript pin"),
    text(record(lockRoot.devDependencies, "root lock devDependencies").typescript, "root lock TypeScript pin"),
    text(lockPackage.version, "locked TypeScript version"),
    text(installed.version, "installed TypeScript version"),
  ];
  if (versions.some((version) => version !== EXPECTED_TYPESCRIPT_VERSION)) {
    return fail(`TypeScript version mismatch; package, lock and installed compiler must be ${EXPECTED_TYPESCRIPT_VERSION}`);
  }
  const relativeBin = text(record(installed.bin, "installed TypeScript bin map").tsc, "installed tsc bin path");
  const absolute = path.resolve(installedRoot, relativeBin);
  const relative = path.relative(installedRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return fail("installed compiler path escapes package");
  try {
    if (!fs.lstatSync(absolute).isFile()) return fail("installed TypeScript compiler is not a regular file");
  } catch {
    return fail("installed TypeScript compiler is unavailable");
  }
  return absolute;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR"] as const) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) return fail(`${label} must be a positive integer`);
  return resolved;
}

export function withCompilerEmission<T>(
  moduleRoot: string,
  limits: CompilerLimits,
  inspect: (outputRoot: string) => T,
): T {
  const compiler = compilerPath(moduleRoot);
  const timeout = positive(limits.timeoutMs, DEFAULT_TIMEOUT_MS, "timeout");
  const maxBuffer = positive(limits.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "output bound");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-ts-output-proof-"));
  const outputRoot = path.join(temporaryRoot, "dist");
  try {
    const result = childProcess.spawnSync(process.execPath, [
      compiler,
      "--project", path.join(moduleRoot, "tsconfig.json"),
      "--outDir", outputRoot,
      "--declarationDir", path.join(temporaryRoot, "declarations"),
      "--tsBuildInfoFile", path.join(temporaryRoot, "typescript.tsbuildinfo"),
    ], {
      cwd: moduleRoot,
      encoding: "utf8",
      env: childEnvironment(),
      maxBuffer,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      windowsHide: true,
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT") return fail("compiler timed out");
    if (code === "ENOBUFS") return fail("compiler output exceeded the configured bound");
    if (result.error) return fail("compiler could not start");
    if (result.signal) return fail(`compiler was terminated by signal ${result.signal}`);
    if (result.status !== 0) return fail(`compiler exited unsuccessfully with code ${result.status}`);
    return inspect(outputRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

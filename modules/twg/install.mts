#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { adaptSkillText } from "./component-render-bridge.mts";

type Runtime = "claude" | "codex";
type Rename = (from: string, to: string) => void;

interface InstallOptions {
  runtime: string;
  homeDir: string;
  repoRoot: string;
  now?: string;
  renameSync?: Rename;
}

interface Definition {
  name: string;
  target: string;
  populate(stage: string): void;
}

interface Change extends Definition {
  stage: string;
  existed: boolean;
}

interface AppliedChange extends Change {
  backup: string | null;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "").replace(/\d{3}Z$/, "Z");
}

function filesBelow(root: string, relative = ""): string[] {
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error("TWG install sources and targets must contain only regular files.");
  }
  return files;
}

function treeDigest(root: string): string | null {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return null;
  const hash = crypto.createHash("sha256");
  for (const relative of filesBelow(root)) {
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copyContents(source: string, target: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: entry.isDirectory(),
    });
  }
}

function assertNoLinkAncestry(target: string): void {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error("TWG install target ancestry contains a symbolic link or junction.");
  }
}

function validateOptions({ runtime, homeDir, repoRoot }: InstallOptions): { runtimeSource: string; skillSource: string } {
  if (runtime !== "claude" && runtime !== "codex") throw new Error("runtime must be claude or codex");
  if (!path.isAbsolute(homeDir)) throw new Error("home must be absolute");
  if (!path.isAbsolute(repoRoot)) throw new Error("repo root must be absolute");
  const runtimeSource = path.join(repoRoot, "modules", "twg", "runtime");
  const skillSource = path.join(repoRoot, "claude", "skills", "kherep-twg", "SKILL.md");
  if (!fs.statSync(runtimeSource, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("TWG runtime source is missing.");
  }
  if (!fs.statSync(skillSource, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("TWG skill source is missing.");
  }
  return { runtimeSource, skillSource };
}

export function installFocused(options: InstallOptions): {
  runtime: Runtime;
  backupRoot: string | null;
  components: Array<{ name: string; status: string }>;
} {
  const runtime = options.runtime as Runtime;
  const sources = validateOptions({ runtime, homeDir: options.homeDir, repoRoot: options.repoRoot });
  const homeDir = path.resolve(options.homeDir);
  const runStamp = options.now || timestamp();
  const renameSync: Rename = options.renameSync || ((from, to) => fs.renameSync(from, to));
  if (!/^[0-9]{8}T[0-9]{6}Z$/.test(runStamp)) throw new Error("install timestamp is invalid");

  const definitions: Definition[] = [
    {
      name: "runtime",
      target: path.join(homeDir, "kherep", "twg"),
      populate(stage) { copyContents(sources.runtimeSource, stage); },
    },
    {
      name: "skill",
      target: path.join(homeDir, "skills", "kherep-twg"),
      populate(stage) {
        const source = fs.readFileSync(sources.skillSource, "utf8");
        fs.writeFileSync(path.join(stage, "SKILL.md"), runtime === "codex" ? adaptSkillText(source) : source);
      },
    },
  ];

  const plannedBackupRoot = path.join(homeDir, "backups", "kherep-twg", runStamp);
  assertNoLinkAncestry(homeDir);
  for (const definition of definitions) assertNoLinkAncestry(definition.target);
  assertNoLinkAncestry(plannedBackupRoot);

  const components: Array<{ name: string; status: string }> = [];
  const changes: Change[] = [];
  for (const definition of definitions) {
    fs.mkdirSync(path.dirname(definition.target), { recursive: true });
    const stage = fs.mkdtempSync(path.join(path.dirname(definition.target), ".kherep-twg-stage-"));
    definition.populate(stage);
    if (treeDigest(stage) === treeDigest(definition.target)) {
      fs.rmSync(stage, { force: true, recursive: true });
      components.push({ name: definition.name, status: "unchanged" });
    } else {
      changes.push({ ...definition, stage, existed: fs.existsSync(definition.target) });
    }
  }

  let backupRoot = changes.some((entry) => entry.existed)
    ? plannedBackupRoot
    : null;
  const applied: AppliedChange[] = [];
  try {
    for (const change of changes) {
      let backup = null;
      if (change.existed) {
        backup = path.join(backupRoot ?? plannedBackupRoot, path.relative(homeDir, change.target));
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        renameSync(change.target, backup);
      }
      applied.push({ ...change, backup });
      renameSync(change.stage, change.target);
      components.push({
        name: change.name,
        status: change.existed ? "replaced-with-backup" : "installed",
      });
    }
  } catch (error) {
    backupRoot ||= plannedBackupRoot;
    for (const change of applied.reverse()) {
      if (fs.existsSync(change.target)) {
        const failed = path.join(backupRoot, "failed", path.relative(homeDir, change.target));
        fs.mkdirSync(path.dirname(failed), { recursive: true });
        renameSync(change.target, failed);
      }
      if (change.backup && fs.existsSync(change.backup)) {
        fs.mkdirSync(path.dirname(change.target), { recursive: true });
        renameSync(change.backup, change.target);
      }
    }
    throw error;
  } finally {
    for (const change of changes) {
      if (fs.existsSync(change.stage)) fs.rmSync(change.stage, { force: true, recursive: true });
    }
  }
  components.sort((a, b) => definitions.findIndex((entry) => entry.name === a.name)
    - definitions.findIndex((entry) => entry.name === b.name));
  return { runtime, backupRoot, components };
}

function parseArgs(argv: string[]): { runtime: Runtime; homeDir: string } {
  let runtime: Runtime | undefined;
  let homeDir: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag || "argument"}`);
    if (flag === "--runtime" && (value === "claude" || value === "codex")) runtime = value;
    else if (flag === "--runtime") throw new Error("runtime must be claude or codex");
    else if (flag === "--home") homeDir = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (runtime !== "claude" && runtime !== "codex") throw new Error("runtime must be claude or codex");
  const envHome = runtime === "claude" ? process.env.CLAUDE_HOME : process.env.CODEX_HOME;
  return { runtime, homeDir: path.resolve(homeDir || envHome || path.join(os.homedir(), `.${runtime}`)) };
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
  try {
    const args = parseArgs(process.argv.slice(2));
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const receipt = installFocused({ ...args, repoRoot: path.resolve(moduleDir, "..", "..") });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "TWG installation failed."}\n`);
    process.exitCode = 1;
  }
}

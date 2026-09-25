#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { componentHash } from "../lib/component-hash.mts";
import type { Capabilities } from "../lib/contracts.mts";
import { newest } from "../lib/parity-projection.mts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const capabilities = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "codex", "parity", "capabilities.json"), "utf8"),
) as Capabilities;
const targetRoot = path.join(repoRoot, "codex", "parity", "plugin-sources");

interface SnapshotEntry {
  id: string;
  version: string;
  path: string;
  contentSha256: string;
}

function directoryName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

function copyProjectionSource(sourceRoot: string, targetRoot: string): void {
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, ".canonical-source"), "Kherep Codex canonical plugin projection source.\n");
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isFile() && /^(license|notice|copying)(?:\.|$)/i.test(entry.name)) {
      fs.copyFileSync(path.join(sourceRoot, entry.name), path.join(targetRoot, entry.name));
    }
  }
  for (const name of ["agents", "commands", "skills"]) {
    const source = path.join(sourceRoot, name);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Plugin component link is not allowed: ${source}`);
    if (!stat?.isDirectory()) continue;
    fs.cpSync(source, path.join(targetRoot, name), { recursive: true, errorOnExist: true });
  }
}

export function normalizeTextTree(root: string): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) normalizeTextTree(target);
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(target);
      if (bytes.includes(0)) continue;
      try {
        const text = decoder.decode(bytes);
        fs.writeFileSync(target, text.replace(/\r\n/g, "\n"), "utf8");
      } catch {
        // Preserve non-UTF-8 assets byte-for-byte.
      }
    }
  }
}

export function snapshot(registry: Record<string, unknown>, destination: string = targetRoot): SnapshotEntry[] {
  if (fs.existsSync(destination)) {
    throw new Error(`Snapshot target already exists; move it to _deprecated before regenerating: ${destination}`);
  }
  const stage = `${destination}.stage-${process.pid}-${Date.now()}`;
  const plugins: SnapshotEntry[] = [];
  try {
    for (const plugin of capabilities.plugins.filter((entry) => ["agent", "project"].includes(entry.mode))) {
      const installed = newest(registry[plugin.id]);
      if (!installed) throw new Error(`Installed Claude plugin source missing: ${plugin.id}`);
      const installPath = String(installed.installPath || "");
      if (!installPath || !path.isAbsolute(installPath)) {
        throw new Error(`Installed Claude plugin path is invalid: ${plugin.id}`);
      }
      const sourceRoot = path.resolve(installPath);
      const sourceStat = fs.lstatSync(sourceRoot, { throwIfNoEntry: false });
      if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
        throw new Error(`Installed Claude plugin directory is missing or linked: ${plugin.id}`);
      }
      componentHash(sourceRoot);
      const relative = directoryName(plugin.id);
      const target = path.join(stage, relative);
      copyProjectionSource(sourceRoot, target);
      normalizeTextTree(target);
      plugins.push({
        id: plugin.id,
        version: String(installed.version || "unknown"),
        path: relative,
        contentSha256: componentHash(target),
      });
    }
    fs.writeFileSync(
      path.join(stage, "manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`,
    );
    fs.renameSync(stage, destination);
    return plugins;
  } catch (error) {
    fs.rmSync(stage, { force: true, recursive: true });
    throw error;
  }
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

if (isMainModule()) {
  const claudeHome = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const registryFile = path.join(claudeHome, "plugins", "installed_plugins.json");
  const registry = (JSON.parse(fs.readFileSync(registryFile, "utf8")) as { plugins?: Record<string, unknown> }).plugins || {};
  process.stdout.write(`Snapshotted ${snapshot(registry).length} canonical plugin sources.\n`);
}

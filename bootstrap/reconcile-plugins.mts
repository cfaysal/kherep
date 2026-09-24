#!/usr/bin/env node
// Idempotent, fail-closed Claude marketplace/plugin reconciliation. Child
// processes always use argv form; captured list/MCP data is never logged.

import childProcess from "node:child_process";
import fs from "node:fs";

import { productEnv } from "../lib/product-env.mts";
import {
  ReconcileError,
  assertNoMarketplaceCollision,
  marketplaceMatches,
  parseMarketplaceList,
  parseMarketplaceManifest,
  parsePluginList,
  parsePluginManifest,
  pluginInstalled,
  pluginSatisfied,
  safeString,
  verifyFinalState,
  type ClaudeState,
  type MarketplaceExpectation,
} from "./plugin-contract.mts";
import { errorStatus, isArgvList, isRecord } from "./shape.mts";

const MAX_OUTPUT = 16 * 1024 * 1024;

interface ClaudeCommand {
  executable: string;
  prefixArgs: string[];
}

interface ClaudeFailure {
  failed: true;
  status: number;
}

function fail(message: string): never {
  throw new ReconcileError(message);
}

function readManifest(file: string, label: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${label} manifest`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`malformed ${label} manifest JSON`);
  }
}

function getClaudeCommand(env: NodeJS.ProcessEnv = process.env): ClaudeCommand {
  const executable = productEnv(env, "CLAUDE_BIN") ?? "claude";
  if (!safeString(executable)) fail("invalid Claude executable configuration");
  let prefixArgs: unknown = [];
  const rawArgs = productEnv(env, "CLAUDE_BIN_ARGS_JSON");
  if (rawArgs !== undefined) {
    try {
      prefixArgs = JSON.parse(rawArgs);
    } catch {
      fail("invalid Claude executable argument configuration");
    }
  }
  if (!isArgvList(prefixArgs)) fail("invalid Claude executable argument configuration");
  return { executable, prefixArgs };
}

// A nonzero exit is reported as a value, never thrown: the caller decides from
// the re-read state whether the mutation converged anyway.
function execClaude(command: ClaudeCommand, args: string[], captureStdout: boolean): string | ClaudeFailure {
  try {
    return childProcess.execFileSync(command.executable, [...command.prefixArgs, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
      shell: false,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return { failed: true, status: errorStatus(error) ?? 1 };
  }
}

function isFailure(result: unknown): result is ClaudeFailure {
  return isRecord(result) && result.failed === true;
}

function runClaudeJson(command: ClaudeCommand, args: string[], label: string): unknown {
  const result = execClaude(command, args, true);
  if (isFailure(result)) fail(`Claude ${label} failed`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    fail(`Claude ${label} returned malformed JSON`);
  }
  return parsed;
}

function readState(command: ClaudeCommand): ClaudeState {
  const marketplaces = parseMarketplaceList(
    runClaudeJson(command, ["plugin", "marketplace", "list", "--json"], "marketplace list"),
  );
  const plugins = parsePluginList(
    runClaudeJson(command, ["plugin", "list", "--json"], "plugin list"),
  );
  return { marketplaces, plugins };
}

function runMutation(command: ClaudeCommand, args: string[]): { ok: boolean } {
  const result = execClaude(command, args, false);
  return isFailure(result) ? { ok: false } : { ok: true };
}

function reconcileMarketplace(command: ClaudeCommand, state: ClaudeState, expected: MarketplaceExpectation): ClaudeState {
  assertNoMarketplaceCollision(state, expected);
  if (marketplaceMatches(state.marketplaces.get(expected.name), expected)) return state;
  process.stdout.write(`reconcile-plugins: add marketplace ${expected.name}\n`);
  const result = runMutation(command, [
    "plugin", "marketplace", "add", "--scope", "user", expected.ref,
  ]);
  const refreshed = readState(command);
  assertNoMarketplaceCollision(refreshed, expected);
  if (!marketplaceMatches(refreshed.marketplaces.get(expected.name), expected)) {
    fail(result.ok
      ? `marketplace add returned success without required state: ${expected.name}`
      : `marketplace add failed without required state: ${expected.name}`);
  }
  if (!result.ok) {
    process.stdout.write(`reconcile-plugins: marketplace converged after nonzero response: ${expected.name}\n`);
  }
  return refreshed;
}

function reconcilePlugin(command: ClaudeCommand, state: ClaudeState, id: string): ClaudeState {
  if (pluginSatisfied(state, id)) return state;
  let current = state;
  if (!pluginInstalled(current, id)) {
    process.stdout.write(`reconcile-plugins: install plugin ${id}\n`);
    const result = runMutation(command, ["plugin", "install", "--scope", "user", id]);
    current = readState(command);
    if (!result.ok) {
      if (!pluginSatisfied(current, id)) fail(`plugin install failed without required state: ${id}`);
      process.stdout.write(`reconcile-plugins: plugin converged after nonzero response: ${id}\n`);
      return current;
    }
    if (!pluginInstalled(current, id)) {
      fail(`plugin install returned success without installed state: ${id}`);
    }
  }
  if (!pluginSatisfied(current, id)) {
    process.stdout.write(`reconcile-plugins: enable plugin ${id}\n`);
    const result = runMutation(command, ["plugin", "enable", "--scope", "user", id]);
    current = readState(command);
    if (!pluginSatisfied(current, id)) {
      fail(result.ok
        ? `plugin enable returned success without required state: ${id}`
        : `plugin enable failed without required state: ${id}`);
    }
    if (!result.ok) {
      process.stdout.write(`reconcile-plugins: plugin converged after nonzero response: ${id}\n`);
    }
  }
  return current;
}

export function reconcile(marketplaceManifestPath: string, pluginManifestPath: string, env: NodeJS.ProcessEnv = process.env): void {
  const marketplaces = parseMarketplaceManifest(readManifest(marketplaceManifestPath, "marketplaces"));
  const names = new Set(marketplaces.map((item) => item.name));
  const requiredPlugins = parsePluginManifest(readManifest(pluginManifestPath, "plugins"), names);
  const command = getClaudeCommand(env);

  let state = readState(command); // Complete list-json preflight before any mutator.
  for (const expected of marketplaces) assertNoMarketplaceCollision(state, expected);
  for (const expected of marketplaces) state = reconcileMarketplace(command, state, expected);
  for (const id of requiredPlugins) state = reconcilePlugin(command, state, id);

  state = readState(command); // Independent final capability snapshot.
  verifyFinalState(state, marketplaces, requiredPlugins);
  process.stdout.write("reconcile-plugins: required marketplaces and plugins verified\n");
}

function cli(): void {
  if (process.argv.length !== 4) fail("usage: reconcile-plugins.mts <marketplaces.json> <plugins.json>");
  reconcile(process.argv[2], process.argv[3]);
}

if (import.meta.main) {
  try {
    cli();
  } catch (error) {
    const message = error instanceof ReconcileError ? error.message : "unexpected internal error";
    process.stderr.write(`reconcile-plugins: FATAL: ${message}\n`);
    process.exitCode = 1;
  }
}

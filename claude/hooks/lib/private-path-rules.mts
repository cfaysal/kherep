// OP-1137. Die Wurzel-Regeln der Privacy-Policy: WELCHE Verzeichnisse als
// Credentials- oder Artefakt-Wurzel gelten. Herausgelöst aus
// private-path-policy.mts, das mit Typen über die 250-Zeilen-Grenze aus
// CLAUDE.md gelaufen wäre. Verhalten unverändert, und die Trennlinie lag schon
// im JavaScript: hier die Wurzeln, dort das Absuchen der Strings.

import fs from "node:fs";
import path from "node:path";

import {
  configuredWorkspace,
  joinPathLike,
  normalizePathLike,
  workspaceForPayload,
  type EnvLike,
  type ScopePayload,
} from "./workspace-scope.mts";

// Die Wurzeln plus der Workspace, gegen den relative Angaben aufgelöst wurden.
// Der Workspace reist mit, weil der Aufrufer denselben Wert braucht, um einen
// workspace-relativen Teilpfad zu vergleichen.
export interface RootContext {
  roots: string[];
  workspace: string;
}

// Aus einer local-inference-Konfiguration werden genau diese Felder gelesen.
// Alles andere darin bleibt ungelesen und deshalb ungetypt.
interface LocalInferenceConfig {
  outputRoot?: unknown;
  output_root?: unknown;
  output?: { root?: unknown } | null;
  privacy?: { outputRoot?: unknown; output_root?: unknown } | null;
}

// Eine unlesbare, kaputte oder leere Konfiguration ist hier dasselbe wie eine
// ohne die gesuchten Felder, deshalb fällt beides auf das leere Objekt.
function readJson(file: string): LocalInferenceConfig {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
  catch { return {}; }
}

export function expandHome(value: unknown): string {
  const raw = String(value || "");
  if (!/^~[\\/]/.test(raw)) return raw;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return joinPathLike(home, raw.slice(2));
}

function addRoot(roots: Set<string>, value: unknown, workspace: string): void {
  if (typeof value !== "string" || !value.trim()) return;
  let root = normalizePathLike(expandHome(value));
  if (!/^(?:[A-Za-z]:\/|\/)/.test(root) && workspace) root = joinPathLike(workspace, root);
  if (root) roots.add(root);
}

function productValues(env: EnvLike, suffix: string): string[] {
  return [...new Set([env[`KHEREP_${suffix}`]]
    .filter((value): value is string => typeof value === "string" && value.trim() !== ""))];
}

// Beide Wurzel-Listen leiten dieselben zwei Workspace-Kandidaten ab: gegen
// workspace werden relative Angaben aufgelöst, und jeder vorhandene Kandidat
// steuert zusätzlich eine eigene Wurzel bei.
function workspaceCandidates(payload: ScopePayload, env: EnvLike): { candidates: string[]; workspace: string } {
  const explicitWorkspace = configuredWorkspace(env);
  const payloadWorkspace = workspaceForPayload(payload, env);
  return {
    candidates: [explicitWorkspace, payloadWorkspace].filter(Boolean),
    workspace: payloadWorkspace || explicitWorkspace,
  };
}

export function artifactRoots(payload: ScopePayload, env: EnvLike = process.env): RootContext {
  const roots = new Set<string>();
  const { candidates, workspace } = workspaceCandidates(payload, env);
  productValues(env, "LOCAL_OUTPUT_ROOT").forEach((value) => addRoot(roots, value, workspace));

  const userHome = env.USERPROFILE || env.HOME || "";
  const claudeHome = env.CLAUDE_HOME || path.join(userHome, ".claude");
  const codexHome = env.CODEX_HOME || path.join(userHome, ".codex");
  const configFiles = new Set([
    ...productValues(env, "LOCAL_CONFIG"),
    path.join(claudeHome, "kherep", "local-inference", "config.json"),
    path.join(codexHome, "kherep", "local-inference", "config.json"),
  ]);
  for (const configFile of configFiles) {
    const config = readJson(configFile);
    [config.outputRoot, config.output_root, config.output?.root,
      config.privacy?.outputRoot, config.privacy?.output_root]
      .forEach((value) => addRoot(roots, value, workspace));
  }

  candidates.forEach((root) => addRoot(roots, joinPathLike(root, "analysis/local-inference"), root));
  return { roots: [...roots], workspace };
}

export function credentialsRoots(payload: ScopePayload, env: EnvLike = process.env): RootContext {
  const roots = new Set<string>();
  const { workspace } = workspaceCandidates(payload, env);
  productValues(env, "CREDENTIALS_ROOT").forEach((value) => addRoot(roots, value, workspace));

  const userHome = env.USERPROFILE || env.HOME || "";
  addRoot(roots, joinPathLike(userHome, ".kherep/credentials"), workspace);
  return { roots: [...roots], workspace };
}

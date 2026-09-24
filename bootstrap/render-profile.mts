#!/usr/bin/env node
// Renders the host-specific files bootstrap/install.sh writes: the merged
// settings pair and the local-inference config.
// Path rewriting lives in render-profile-paths.mts, the merge in
// render-profile-settings.mts.

import fs from "node:fs";
import path from "node:path";

import { retireCentralBrainHooks } from "./central-brain-retirement.mts";
import { substituteTemplatePaths, toBashPath } from "./render-profile-paths.mts";
import { filterMacPermissions, filterManagedDisallowedPermissions, mergeSettings, unique, type Settings } from "./render-profile-settings.mts";
import { errorMessage } from "./shape.mts";

interface LocalInferenceConfig {
  backends?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  installedProfile?: string;
  [key: string]: unknown;
}

export function mergeLocalInferenceConfig(
  profile: string, source: LocalInferenceConfig, existing: LocalInferenceConfig = {},
): LocalInferenceConfig {
  if (!source.profiles || !source.profiles[profile]) {
    throw new Error(`Local-inference config has no '${profile}' profile`);
  }
  const sourceBackends = source.backends || {};
  const selected = source.profiles[profile];
  const profileBackends = selected && typeof selected === "object" && "backends" in selected
    && selected.backends && typeof selected.backends === "object" ? selected.backends : {};
  const neutralSource = Object.keys(sourceBackends).length === 0 && Object.keys(profileBackends).length === 0;
  return neutralSource && Object.keys(existing).length > 0 ? existing : { ...source, installedProfile: profile };
}

// The files are repo-owned or host-owned JSON whose shape the caller asserts;
// `optional` turns an absent file (or the `-` placeholder) into an empty object.
function readJson<T>(file: string, optional = false): T {
  if (optional && (!file || file === "-" || !fs.existsSync(file))) return {} as T;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch { throw new Error("Cannot read required JSON configuration."); }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function renderSettings(args: string[]): void {
  const [profile, workspace, credentialsRoot, claudeHome, sourceUserFile, sourceProjectFile,
    existingUserFile, existingProjectFile, outputUserFile, outputProjectFile] = args;
  if (!["win", "mac"].includes(profile) || !outputProjectFile) {
    throw new Error("settings usage: <win|mac> <workspace> <credentials> <claude-home> <source-user> <source-project> <existing-user|-> <existing-project|-> <output-user> <output-project>");
  }
  let sourceUser = readJson<Settings>(sourceUserFile);
  let sourceProject = readJson<Settings>(sourceProjectFile);
  const retired = retireCentralBrainHooks(readJson<Settings>(existingUserFile, true));
  const existingUser = retired.settings;
  if (retired.removed) console.error(`central-brain: removed ${retired.removed} retired hook command(s) from settings.json`);
  let existingProject = readJson<Settings>(existingProjectFile, true);
  sourceUser = substituteTemplatePaths(sourceUser, profile, workspace, credentialsRoot, claudeHome);
  sourceProject = substituteTemplatePaths(sourceProject, profile, workspace, credentialsRoot, claudeHome);
  const user = mergeSettings(sourceUser, existingUser);
  const project = mergeSettings(sourceProject, existingProject);
  filterManagedDisallowedPermissions(user);
  filterManagedDisallowedPermissions(project);
  if (profile === "mac") {
    filterMacPermissions(user);
    filterMacPermissions(project);
  }
  project.permissions = project.permissions || {};
  project.permissions.additionalDirectories = unique(project.permissions.additionalDirectories || []);
  // OP-754. Der Credentials-Root wird in die Session-Umgebung gehoben, damit
  // verwaltete Skripte ihn aus `$KHEREP_CREDENTIALS_ROOT` aufloesen statt ihn als
  // Literal zu fuehren. Der Wert kommt aus dem Aufruf (install.sh), nicht aus
  // dieser Datei - sonst stuende der bewachte Pfad hier im Quelltext.
  // Der Wert MUSS bash-sichtbar sein: fuehrender Slash, keine Backslashes.
  // `kherep_validate_shell_path` (profile.sh) bricht sonst fail-closed ab, und
  // weil die Harness diesen env-Block in jeden Tool-Aufruf injiziert, wuerde ein
  // falscher Wert install.sh und drift-check.sh gleichermassen lahmlegen - der
  // Installer koennte sich dann nicht einmal mehr selbst reparieren.
  //
  // install.sh uebergibt die Bash-Form, aber MSYS wandelt Argumente an node.exe
  // in die Laufwerksform um (/d/x wird zu D:/x). Der Renderer sieht die
  // Bash-Form also nie und muss zurueckwandeln.
  user.env = {
    ...(user.env || {}),
    KHEREP_WORKSPACE: toBashPath(workspace),
    KHEREP_CREDENTIALS_ROOT: toBashPath(credentialsRoot),
  };
  writeJson(outputUserFile, user);
  writeJson(outputProjectFile, project);
}

export function renderLocalInference(args: string[]): void {
  const [profile, sourceFile, existingFile, outputFile] = args;
  if (!["win", "mac"].includes(profile) || !outputFile) {
    throw new Error("local-inference usage: <win|mac> <source> <existing|-> <output>");
  }
  const source = readJson<LocalInferenceConfig>(sourceFile);
  const existing = readJson<LocalInferenceConfig>(existingFile, true);
  writeJson(outputFile, mergeLocalInferenceConfig(profile, source, existing));
}

function main(argv: string[]): void {
  const [mode, ...args] = argv;
  if (mode === "settings") renderSettings(args);
  else if (mode === "local-inference") renderLocalInference(args);
  else throw new Error("mode must be settings or local-inference");
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`FATAL: profile render failed: ${errorMessage(error)}`); process.exit(1); }
}

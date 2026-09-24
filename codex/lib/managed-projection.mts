import fs from "node:fs";
import path from "node:path";

import { normalizeName } from "./component-render.mts";
import type { ProjectionContext, ProjectionReceipt } from "./contracts.mts";

export interface PriorManaged {
  agents: Set<string>;
  skills: Set<string>;
}

function directories(root: string): string[] {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function files(root: string, extension: string): string[] {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(root, entry.name));
}

// Only a name that survives normalizeName unchanged may be treated as a
// managed target: a hostile receipt entry such as "../orchestra" must never
// turn into a removal path.
function safeNames(entries: unknown[]): string[] {
  return entries
    .map((entry) => (entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === "string" && name.length > 0 && name === normalizeName(name));
}

export function previousManaged(codexHome: string): PriorManaged {
  const file = path.join(codexHome, "orchestra", "parity-receipt.json");
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return { agents: new Set(), skills: new Set() };
  try {
    const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as { projection?: Record<string, unknown> };
    const projection = receipt.projection || {};
    // A malformed list throws here and lands in the catch below, exactly as the
    // untyped `.map` did: a receipt that cannot be read manages nothing.
    const list = (value: unknown): unknown[] => (value ? value as unknown[] : []);
    return {
      agents: new Set(safeNames(list(projection.agents))),
      skills: new Set(safeNames([...list(projection.skills), ...list(projection.commands)])),
    };
  } catch {
    return { agents: new Set(), skills: new Set() };
  }
}

export function reservePersonalTargets(codexHome: string, usedSkills: Set<string>, usedAgents: Set<string>, prior: PriorManaged): void {
  for (const directory of directories(path.join(codexHome, "skills"))) {
    const name = normalizeName(path.basename(directory));
    if (!prior.skills.has(name)) usedSkills.add(name);
  }
  for (const file of files(path.join(codexHome, "agents"), ".toml")) {
    const name = normalizeName(path.basename(file, ".toml"));
    if (!prior.agents.has(name)) usedAgents.add(name);
  }
}

export function removeStaleManaged(context: ProjectionContext, prior: PriorManaged, receipt: ProjectionReceipt): void {
  const currentSkills = new Set([...receipt.skills, ...receipt.commands].map((entry) => entry.name));
  const currentAgents = new Set(receipt.agents.map((entry) => entry.name));
  receipt.removed = { agents: [], skills: [] };
  for (const name of prior.skills) {
    if (currentSkills.has(name)) continue;
    context.transaction.remove(path.join(context.codexHome, "skills", name));
    receipt.removed.skills.push(name);
  }
  for (const name of prior.agents) {
    if (currentAgents.has(name)) continue;
    context.transaction.remove(path.join(context.codexHome, "agents", `${name}.toml`));
    receipt.removed.agents.push(name);
  }
}

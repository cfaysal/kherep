// Zweck: npm-globals-Manifeste lesen und je Host mergen (Pins, Overrides, Ledger-Schutz).
// Grund fuer die Trennung: bootstrap/npm-globals lag mit 253 LOC ueber der 250-LOC-Grenze (OP-1087).
// Der Planer (Plan, npm-Aufrufe, CLI) bleibt unveraendert in bootstrap/npm-globals.mts.

import fs from "node:fs";
import path from "node:path";

import { errorCode } from "./shape.mts";

export class GlobalsError extends Error {}

export function fail(message: string): never {
  throw new GlobalsError(message);
}

export function safeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

// Eine Manifestzeile: `name` (unpinned) oder `name@version` (Pin).
export interface ManifestEntry {
  name: string;
  pin: string;
}

// Nach dem Merge: `override` nennt die Datei, die den Basiseintrag ersetzt hat,
// sonst "".
export interface MergedEntry extends ManifestEntry {
  override: string;
}

// Nur ENOENT heisst "gibt es nicht". Ein Verzeichnis, EACCES oder ein anderer
// Lesefehler an einem optionalen Override ist ein Fehler, kein leeres Ergebnis:
// ein gescheiterter Read und "keine Overrides" duerfen nicht dasselbe liefern
// (Golden Rule 12, Review OP-1087).
export function manifestState(file: string): string {
  try {
    return fs.statSync(file).isFile() ? "file" : "not-a-file";
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? "absent" : `unreadable (${code || "error"})`;
  }
}

export function readManifest(file: string): ManifestEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    fail(`cannot read npm-globals manifest: ${file}`);
  }
  const entries: ManifestEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!safeString(line) || /\s/.test(line)) fail(`malformed manifest entry: ${line}`);
    // `@scope/name@1.2.3`: the version separator is the LAST `@`, never the scope `@`.
    const at = line.lastIndexOf("@");
    if (at <= 0) { entries.push({ name: line, pin: "" }); continue; }
    const name = line.slice(0, at);
    const pin = line.slice(at + 1);
    if (!safeString(name) || !safeString(pin)) fail(`malformed manifest entry: ${line}`);
    entries.push({ name, pin });
  }
  return entries;
}

// Mehrere Manifeste: das spaetere gewinnt je Paketname, fuer Pin wie unpinned.
// WARUM (Director-Regel 2026-09-02, OP-1087): Pins verhindern stille Aenderung,
// sie erzwingen KEINE Paritaet zwischen den Boxen. Eine Box darf deshalb per
// Host-Override (npm-globals.<profil>.txt) bewusst auf einem anderen Pin bleiben.
// Ein fehlendes Manifest ist ein Fehler (fail-closed), ausser es traegt das
// `?`-Praefix - dann heisst "fehlt" schlicht "keine Overrides".
export function mergeManifests(args: string[]): MergedEntry[] {
  const merged = new Map<string, MergedEntry>();
  args.forEach((arg) => {
    const optional = arg.startsWith("?");
    const file = optional ? arg.slice(1) : arg;
    if (optional) {
      const state = manifestState(file);
      if (state === "absent") return;
      if (state !== "file") return fail(`optional manifest ${file} is ${state}`);
    }
    const source = path.basename(file);
    for (const entry of readManifest(file)) {
      const override = merged.has(entry.name) ? source : "";
      merged.set(entry.name, { ...entry, override });
    }
  });
  return [...merged.values()];
}

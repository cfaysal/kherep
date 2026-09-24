// OP-1137. Jeder relative Modulverweis unter claude/hooks und codex/hooks
// zeigt auf eine Datei, die es gibt - und zwar in der Schreibweise, mit der
// Node sie zur Laufzeit tatsächlich auflöst.
//
// WARUM DIESE DATEI EXISTIERT. Die Hook-Libs wandern nach TypeScript
// (OP-1125). Gemessen unter Node 24: ein CommonJS-Hook darf
// require("./lib/workspace-scope.mts") MIT expliziter Endung, aber ein
// endungsloses require("./lib/workspace-scope") findet eine .mts NICHT
// (MODULE_NOT_FOUND). Ein beim Rename vergessener Konsument fällt deshalb
// nicht beim Typecheck auf und nicht im Build, sondern erst wenn der Hook auf
// einer echten Box startet - dort, wo ein kaputter Hook still ist.
//
// Der Test ist der runtime-unabhängige Durchsetzungspunkt dafür (Golden
// Rule 16): er liest die Verweise statisch aus der Quelle und lädt keinen
// Hook, denn ein geladener Hook wartet auf stdin.
//
// NICHT GESCANNT, mit Grund an der Stelle: _deprecated/ (Friedhof aus Golden
// Rule 1) und die .hook-adapter-* Laufzeitfixtures eines Codex-Tests.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const HOOK_ROOTS = ["claude/hooks", "codex/hooks"];
const SKIPPED_DIRS = /^(?:_deprecated|node_modules|\.hook-adapter-)/;
const SOURCE = /\.(?:js|mts)$/;
// require("./x") und require('./x'), plus die ESM-Form import ... from "./x.mts".
const REQUIRE_SPECIFIER = /require\(\s*(["'])(\.[^"']*)\1\s*\)/g;
const IMPORT_SPECIFIER = /\bfrom\s*(["'])(\.[^"']*)\1/g;

interface Reference {
  file: string;
  specifier: string;
  esm: boolean;
}

function sourceFiles(dir: string, rel: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.test(entry.name)) found.push(...sourceFiles(path.join(dir, entry.name), childRel));
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      found.push(childRel);
    }
  }
  return found;
}

function referencesIn(rel: string): Reference[] {
  const text = fs.readFileSync(path.join(repo, rel), "utf8");
  const found: Reference[] = [];
  for (const [pattern, esm] of [[REQUIRE_SPECIFIER, false], [IMPORT_SPECIFIER, true]] as const) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) found.push({ file: rel, specifier: match[2], esm });
  }
  return found;
}

const references = HOOK_ROOTS
  .flatMap((root) => sourceFiles(path.join(repo, root), root))
  .flatMap(referencesIn);

// Ein Verweis wird relativ zur verweisenden Datei aufgelöst, nicht zur
// Repo-Wurzel. Beide Prüfungen unten brauchen genau diesen Pfad.
function targetOf(reference: Reference): string {
  return path.resolve(repo, path.dirname(reference.file), reference.specifier);
}

// Die Auflösung wird nicht geraten, sondern nachgebaut: CommonJS ohne Endung
// probiert .js und .json und /index.js, ESM und jede explizite Endung nehmen
// den Pfad wie er dasteht.
function resolves(reference: Reference): boolean {
  const target = targetOf(reference);
  if (reference.esm || /\.(?:js|json|mts|mjs|cjs)$/.test(reference.specifier)) return fs.existsSync(target);
  return [`${target}.js`, `${target}.json`, path.join(target, "index.js")].some((candidate) => fs.existsSync(candidate));
}

test("jeder relative Hook-Verweis löst auf eine vorhandene Datei auf", () => {
  assert.ok(references.length > 20,
    `nur ${references.length} relative Verweise gefunden - die Form hat sich geändert und dieser Test misst nichts mehr`);
  const broken = references
    .filter((reference) => !resolves(reference))
    .map((reference) => `${reference.file} -> ${reference.specifier}`)
    .sort();
  assert.deepEqual(broken, [], `Verweis ohne Datei:\n  ${broken.join("\n  ")}`);
});

test("kein endungsloses require zeigt auf eine migrierte .mts: Node löst das nicht auf", () => {
  const stale = references
    .filter((reference) => !reference.esm && !/\.[a-z]+$/.test(reference.specifier))
    .filter((reference) => fs.existsSync(`${targetOf(reference)}.mts`))
    .map((reference) => `${reference.file} -> ${reference.specifier} (".mts" ergänzen)`)
    .sort();
  assert.deepEqual(stale, [],
    `endungsloses require auf eine TypeScript-Datei, zur Laufzeit MODULE_NOT_FOUND:\n  ${stale.join("\n  ")}`);
});

// codex/hooks/privacy-boundary-guard.mts lädt die Policy-Libs über
// require(path.join(libRoot, "<name>")): der Pfad steht erst zur Laufzeit fest,
// der Dateiname aber im Quelltext. Genau dieser Name fällt beim Rename durch.
test("der Codex-Privacy-Guard benennt Lib-Dateien, die in claude/hooks/lib liegen", () => {
  const guard = path.join("codex", "hooks", "privacy-boundary-guard.mts");
  const text = fs.readFileSync(path.join(repo, guard), "utf8");
  const named = [...text.matchAll(/path\.join\(\s*libRoot\s*,\s*(["'])([^"']+)\1\s*\)/g)].map((m) => m[2]);
  assert.ok(named.length > 0, `${guard} lädt die Libs nicht mehr über path.join(libRoot, ...) - Test nachziehen`);
  const libDir = path.join(repo, "claude", "hooks", "lib");
  const missing = named
    .filter((name) => ![name, `${name}.js`].some((candidate) => fs.existsSync(path.join(libDir, candidate))))
    .sort();
  assert.deepEqual(missing, [], `benannt, aber nicht in claude/hooks/lib: ${JSON.stringify(missing)}`);
});

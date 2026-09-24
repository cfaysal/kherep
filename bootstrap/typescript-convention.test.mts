// OP-1121. Neuer Code in diesem Repo ist TypeScript (.mts, direkt unter Node).
// Diese Datei ist der runtime-unabhaengige Durchsetzungspunkt dafuer (Golden
// Rule 16): eine Regel in CLAUDE.md bindet nur den, der CLAUDE.md liest.
//
// WIE. bootstrap/manifest/legacy-javascript.txt fuehrt jede noch nicht
// migrierte JavaScript-Datei. Die Platte wird gegen die Liste gehalten, in
// beide Richtungen: eine neue .js/.mjs/.cjs ausserhalb der Liste ist ein
// Verstoss (als .mts anlegen, nicht eintragen), ein Eintrag ohne Datei ist
// eine erledigte Migration, die nicht ausgetragen wurde. Die Liste ist damit
// zugleich der sichtbare Restbestand der Migration.
// Der exakte dist-Baum jedes Pakets in COMPILED_MODULES wird VOR dem Inventar
// gegen eine frische Emission des gepinnten Compilers geprueft. Nur byte- und
// pfadgleiche JavaScript-Ausgaben werden aus der Population des Autoren-Codes
// entfernt.
//
// NICHT GESCANNT, mit Grund an der Stelle: .git und node_modules (fremd),
// .worktrees und .claude/worktrees (lokale beziehungsweise von der
// Agent-Laufzeit angelegte Implementierungs-Worktrees, laut .gitignore volle
// Repo-Kopien), _deprecated/ (die Friedhoefe aus Golden Rule 1, dorthin wird
// verschoben, nie neu geschrieben), codex/parity/plugin-sources (vendored
// Snapshot fremder Plugins, der byte-identisch bleiben muss) und die
// .hook-adapter-* Laufzeit-Fixtures eines Codex-Tests. Bewusst ein
// Dateisystem-Walk statt `git ls-files`: der Test muss auch in der Archiv-Kopie
// laufen, die smoke-test.sh ohne .git anlegt. Diese Verzeichnis-Ausnahmen
// gelten nicht innerhalb der oben genannten dist-Baeume.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { loadTypeScriptConvention } from "./typescript-convention.mts";

const repo = path.resolve(import.meta.dirname, "..");
const { inventory, unlisted, stale } = loadTypeScriptConvention(repo);

test("jede JavaScript-Datei im Repo steht im Legacy-Inventar: neuer Code ist TypeScript", () => {
  assert.deepEqual(unlisted, [],
    "JavaScript ausserhalb von bootstrap/manifest/legacy-javascript.txt - als .mts anlegen, nicht eintragen (OP-1121):\n  "
    + unlisted.join("\n  "));
});

test("jeder Inventareintrag liegt noch als JavaScript auf Platte: migriert heisst austragen", () => {
  assert.deepEqual(stale, [],
    "im Inventar, aber nicht mehr auf Platte - Eintrag aus legacy-javascript.txt entfernen:\n  "
    + stale.join("\n  "));
});

test("das Inventar ist sortiert und frei von Duplikaten, damit jeder Diff eine Zeile pro Datei ist", () => {
  assert.deepEqual(inventory, [...new Set(inventory)].sort());
});

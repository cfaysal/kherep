import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readManifest } from "./npm-globals-manifest.mts";

// Director-Entscheid 2026-09-07 (OP-1128): der Installer darf das Claude-Code-CLI
// nie downgraden. Ein Pin wird von bootstrap/npm-globals.mts in beide Richtungen
// erzwungen; Claude Code aktualisiert sich selbst, also dreht jeder install.sh-Lauf
// einen Pin zurueck (gemessen 2026-09-07 auf dem Mac: 2.1.261 -> 2.1.258).
// Unpinned heisst: nur installieren wenn es fehlt, nie still aendern.
const NEVER_PINNED = ["@anthropic-ai/claude-code"];

const manifestDir = path.join(import.meta.dirname, "manifest");
const manifests = fs.readdirSync(manifestDir)
  .filter((name) => /^npm-globals(\.[a-z]+)?\.txt$/.test(name))
  .map((name) => path.join(manifestDir, name));

test("npm-globals manifests exist for the shared list and every host profile", () => {
  assert.ok(manifests.some((file) => path.basename(file) === "npm-globals.txt"));
});

for (const file of manifests) {
  test(`${path.basename(file)} pinnt kein Werkzeug aus der Nie-Pinnen-Liste (OP-1128)`, () => {
    const pinned = readManifest(file)
      .filter((entry) => NEVER_PINNED.includes(entry.name) && entry.pin)
      .map((entry) => `${entry.name}@${entry.pin}`);
    assert.deepEqual(pinned, []);
  });
}

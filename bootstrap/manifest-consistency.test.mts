// OP-1054 / S2. Hält die Deklarationsorte einer Capability gegeneinander.
//
// WARUM DIESE DATEI EXISTIERT. Dieselbe Tatsache steht an mehreren Orten: auf
// Platte unter claude/, in bootstrap/manifest/files.txt (was installiert wird),
// in bootstrap/manifest/capabilities.json (was der Contract fordert) und - für
// den project-Scope - als hart kodierte Liste in bootstrap/drift-check.sh.
// Nichts hielt sie zusammen. OP-1044 hat einen Skill in files.txt deklariert
// und capabilities.json vergessen; der Fehlschlag fiel erst im manuellen,
// 15 Minuten langen Smoke-Test auf, und zwar auf beiden Profilen identisch -
// es war nie ein Plattformproblem, sondern Deklarations-Drift.
//
// RELATIONEN SIND NICHT ÜBERALL GLEICH. Das ist der Grund, warum hier nicht
// pauschal auf Gleichheit geprüft wird:
//   skills, commands  -> Gleichheit über alle drei Orte.
//   requiredHooks     -> bewusst eine TEILMENGE von files.txt (13 von 33).
//                        "required" heisst: ohne diese Hooks ist der Host
//                        nicht vertragsgemäss. Die übrigen sind Komfort.
//   hand-deklariert   -> eigener Ort, gar nicht in den Manifesten. Geprüft
//                        wird nur, dass die referenzierten Quellen existieren.
// Eine Gleichheitsprüfung auf requiredHooks oder auf die hand-deklarierten
// Einträge wäre falsch-by-construction und würde bei jeder Erweiterung rot.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const claudeSrc = path.join(repo, "claude");
const manifestDir = path.join(repo, "bootstrap", "manifest");

interface Capabilities {
  skills: string[];
  commands: string[];
  requiredHooks: string[];
}

const capabilities = JSON.parse(
  fs.readFileSync(path.join(manifestDir, "capabilities.json"), "utf8"),
) as Capabilities;

// files.txt führt Pfade relativ zu claude/. Leerzeilen und Kommentare fliegen
// raus, damit ein späterer Kommentar im Manifest nicht als Eintrag zählt.
const fileEntries = fs
  .readFileSync(path.join(manifestDir, "files.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const under = (prefix: string): string[] =>
  fileEntries.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));

const missing = (from: Iterable<string>, inSet: Set<string>): string[] => [...from].filter((x) => !inSet.has(x)).sort();

function report(label: string, left: Iterable<string>, right: Set<string>): string {
  const gap = missing(left, right);
  return gap.length ? `${label}: ${JSON.stringify(gap)}` : "";
}

function threeWay(disk: Set<string>, files: Set<string>, caps: Set<string>): string[] {
  return [
    report("auf Platte, fehlt in files.txt", disk, files),
    report("in files.txt, fehlt auf Platte", files, disk),
    report("in files.txt, fehlt in capabilities.json", files, caps),
    report("in capabilities.json, fehlt in files.txt", caps, files),
  ].filter(Boolean);
}

test("skills stimmen ueber Platte, files.txt und capabilities.json ueberein", () => {
  const disk = new Set(
    fs.readdirSync(path.join(claudeSrc, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  const findings = threeWay(disk, new Set(under("skills/")), new Set(capabilities.skills));
  assert.deepStrictEqual(findings, [], `Skill-Deklaration driftet:\n  ${findings.join("\n  ")}`);
});

test("commands stimmen ueber Platte, files.txt und capabilities.json ueberein", () => {
  const disk = new Set(
    fs.readdirSync(path.join(claudeSrc, "commands")).filter((f) => f.endsWith(".md")),
  );
  const findings = threeWay(disk, new Set(under("commands/")), new Set(capabilities.commands));
  assert.deepStrictEqual(findings, [], `Command-Deklaration driftet:\n  ${findings.join("\n  ")}`);
});

test("jeder requiredHook ist installierbar und liegt auf Platte", () => {
  // Teilmengen-Richtung, siehe Kopfkommentar. Geprüft wird nur, dass kein
  // geforderter Hook ohne Installationsweg oder ohne Quelldatei dasteht.
  const files = new Set(under("hooks/"));
  const findings = [
    report("in capabilities.json gefordert, fehlt in files.txt",
      new Set(capabilities.requiredHooks), files),
    ...capabilities.requiredHooks
      .filter((h) => !fs.existsSync(path.join(claudeSrc, "hooks", h)))
      .map((h) => `gefordert, aber nicht auf Platte: ${h}`),
  ].filter(Boolean);
  assert.deepStrictEqual(findings, [], `requiredHooks driftet:\n  ${findings.join("\n  ")}`);
});

// files.txt führt INSTALL-ZIELE, nicht durchgängig Quellpfade. Zwei Einträge
// werden nicht kopiert sondern erzeugt: settings.json wird aus
// settings.project.json plus settings.user.json gerendert, CLAUDE.md kommt aus
// CLAUDE.user.md. install.sh nimmt beide mit `case "$rel" in ...) continue`
// aus der Kopierschleife heraus.
//
// DIESE LISTE WIRD GELESEN, NICHT WIEDERHOLT. Eine hartkodierte Kopie hier
// wäre ein weiterer Ort, der mitgepflegt werden muss - exakt die Krankheit,
// gegen die dieser Test antritt.
function generatedTargets(): Set<string> {
  const installSh = fs.readFileSync(path.join(repo, "bootstrap", "install.sh"), "utf8");
  const line = installSh.match(/case\s+"\$rel"\s+in\s+([^)]*)\)\s*continue/);
  assert.ok(line, 'install.sh fuehrt die Skip-Liste nicht mehr als `case "$rel" in ...) continue`'
    + " - dieser Test muss nachgezogen werden, statt still durchzuwinken");
  return new Set(line[1].split("|").map((s) => s.trim()).filter(Boolean));
}

test("jeder kopierte files.txt-Eintrag existiert auf Platte", () => {
  // Faengt die Gegenrichtung: ein Eintrag, dessen Quelldatei geloescht wurde,
  // laesst install.sh sonst erst zur Laufzeit auf dem Zielhost auflaufen.
  const generated = generatedTargets();
  const orphans = fileEntries
    .filter((entry) => !generated.has(entry))
    .filter((entry) => !fs.existsSync(path.join(claudeSrc, entry)))
    .sort();
  assert.deepStrictEqual(orphans, [],
    `files.txt zeigt auf nicht existierende Quellen: ${JSON.stringify(orphans)}`);
});

// DER DRITTE DEKLARATIONSORT (OP-1054, von der WIN-Session gefunden).
//
// Ein Teil der geprüften Dateien steht in KEINEM der beiden Manifeste, sondern
// von Hand in drift-check.sh: der project-Scope und die runtime-Einträge.
// mpac.ps1 lebt ausschliesslich dort - und genau an dieser Datei hatte die
// WIN-Box echte, unversionierte Drift. Ein Test, der nur files.txt und
// capabilities.json abgleicht, hätte sie nie gesehen.
//
// Geprüft wird bewusst NUR, dass jede referenzierte Repo-Quelle existiert.
// Eine Gleichheitsforderung gegen die Manifeste wäre falsch: der project-Scope
// installiert in den Workspace, die Manifeste in ~/.claude. Zwei Ziele, zwei
// Listen, und das ist hier kein Fehler.
//
// Erfasst werden cmp_file UND cmp_tree, denn beide deklarieren von Hand. Das
// Unterscheidungsmerkmal ist das LITERALE Label: die schleifengetriebenen
// Aufrufe tragen dort eine Variable ($rel, $label/$sub) und werden bereits
// über files.txt geprüft. Ein literales Label heisst: hier hat jemand einen
// Eintrag von Hand hingeschrieben, und genau das ist der dritte Ort.
function handDeclaredSources(): { label: string; source: string }[] {
  const driftCheck = fs.readFileSync(path.join(repo, "bootstrap", "drift-check.sh"), "utf8")
    .replace(/\\\n\s*/g, " "); // Zeilenfortsetzungen zusammenziehen
  const found: { label: string; source: string }[] = [];
  const pattern = /cmp_(?:file|tree)\s+"([^"$]+)"\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(driftCheck)) !== null) {
    found.push({ label: match[1], source: match[2] });
  }
  return found;
}

test("jede hand-deklarierte Quelle in drift-check.sh existiert", () => {
  const entries = handDeclaredSources();
  assert.ok(entries.length > 0,
    "keine hand-deklarierte cmp_file- oder cmp_tree-Zeile in drift-check.sh gefunden - die Form hat sich geaendert"
    + " und dieser Test misst nichts mehr (ein leeres Ergebnis ist kein Beweis)");

  const orphans: string[] = [];
  for (const { label, source } of entries) {
    // EXPECTED_DIR ist `mktemp -d` (drift-check.sh Zeile 44), also zur Laufzeit
    // erzeugt. Statisch nicht pruefbar, deshalb hier ausgenommen - mit Grund an
    // der Stelle statt in einer zentralen Liste.
    if (source.includes("$EXPECTED_DIR")) continue;
    const resolved = source
      .replace("$HERE/..", repo)
      .replace("$CLAUDE_SRC", claudeSrc);
    if (resolved.includes("$")) {
      orphans.push(`${label}: unaufgeloeste Variable in der Quelle: ${source}`);
    } else if (!fs.existsSync(resolved)) {
      orphans.push(`${label}: Quelle fehlt: ${source}`);
    }
  }
  assert.deepStrictEqual(orphans, [],
    `hand-deklarierte Eintraege zeigen auf nicht existierende Quellen:\n  ${orphans.join("\n  ")}`);
});

// DER VIERTE ORT: bootstrap/manifest/retired.txt (OP-1136).
//
// retired.txt führt Live-Dateien, die der Installer PARKT statt sie stehen zu
// lassen: install.sh installiert nach Namen und kennt kein Entfernen, also
// überlebt eine nicht mehr verwaltete Datei jede Installation, unverwaltet und
// für drift-check unsichtbar. Sie ist damit die Gegenrichtung zu files.txt.
//
// NICHT ZU VERWECHSELN mit deprecated.txt: die ist ausschliesslich ein
// Ausschluss für capture.sh, damit ein Capture-Lauf toten Bestand nicht wieder
// ins Repo zieht. Sie bewegt auf der Zielbox nichts.
//
// Geprüft wird das eine, was still falsch sein kann: eine Datei, die
// gleichzeitig verwaltet und zurückgezogen ist. install.sh würde sie erst
// installieren und dann sofort wieder wegräumen - bei jedem Lauf, ohne dass
// irgendwer es merkt.
const retiredEntries = fs
  .readFileSync(path.join(manifestDir, "retired.txt"), "utf8")
  .split("\n")
  .map((line) => line.replace(/\r$/, "").trim())
  .filter((line) => line && !line.startsWith("#"));

test("keine Datei ist gleichzeitig verwaltet und zurueckgezogen", () => {
  const managed = new Set(fileEntries);
  const both = retiredEntries.filter((entry) => managed.has(entry)).sort();
  assert.deepStrictEqual(both, [],
    "in files.txt UND in retired.txt - install.sh wuerde sie bei jedem Lauf installieren und wieder parken:\n  "
    + both.join("\n  "));
});

test("retired.txt ist sortiert und traegt Kommentare nur als eigene Zeile", () => {
  const findings = retiredEntries
    .filter((entry) => entry.includes("#"))
    .map((entry) => `Inline-Kommentar: ${entry}`);
  if (retiredEntries.join("\n") !== [...retiredEntries].sort().join("\n")) {
    findings.push("nicht sortiert - ein Diff soll eine Zeile pro Datei zeigen");
  }
  assert.deepStrictEqual(findings, [], `retired.txt driftet:\n  ${findings.join("\n  ")}`);
});

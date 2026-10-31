import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { renderIntercom } from "../bootstrap/render-intercom.mts";
import { launcherCommand } from "../modules/control-plane/node/launcher.mts";

export const binding = { configRoot: "C:/Public/Kherep", exampleTarget: "public-node/session", platform: "win32" as const };
export const predecessorFile = path.join(import.meta.dirname, "parity/routing-predecessor.json");
export function rendered(text: string): Buffer {
  return Buffer.from(renderIntercom(text, { command: launcherCommand(binding.configRoot, binding.platform), exampleTarget: binding.exampleTarget }));
}
export function predecessor(): Buffer { return rendered(JSON.parse(fs.readFileSync(predecessorFile, "utf8")).content); }
export function current(): Buffer { return rendered(fs.readFileSync(path.join(import.meta.dirname, "ROUTING.md"), "utf8")); }
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name), key = path.relative(root, file).split(path.sep).join("/");
      if (e.isDirectory()) out[key] = "directory";
      else if (e.isSymbolicLink()) out[key] = `link:${fs.readlinkSync(file)}`;
      else out[key] = `${fs.readFileSync(file).toString("base64")}:${fs.statSync(file).mtimeMs}`;
      if (e.isDirectory()) walk(file);
    }
  }
  walk(root); return out;
}
export function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "routing-707-")), home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(home, "orchestra/ROUTING.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, predecessor());
  const protectedPaths = ["home/config.toml", "home/models.json", "home/hooks/state.json", "home/orchestra/parity-receipt.json", "home/integrations/settings.json", "claude/settings.json"];
  for (const file of protectedPaths) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `synthetic sentinel ${file}`);
  }
  const protectedBytes = Object.fromEntries(protectedPaths.map(file => {
    assert.ok(fs.existsSync(path.join(root, file))); return [file, fs.readFileSync(path.join(root, file))];
  }));
  const assertProtected = () => { for (const [file, bytes] of Object.entries(protectedBytes)) {
    assert.ok(fs.existsSync(path.join(root, file))); assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
  } };
  return { root, home, target, assertProtected, options: { codexHome: home, ...binding } };
}

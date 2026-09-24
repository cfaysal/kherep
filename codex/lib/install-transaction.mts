import fs from "node:fs";
import path from "node:path";

interface Entry {
  existed: boolean;
  relative: string;
  target: string;
}

export class InstallTransaction {
  root: string;
  backupRoot: string;
  entries: Map<string, Entry>;
  onWrite: ((target: string) => void) | null;

  constructor(root: string, backupRoot: string, onWrite: ((target: string) => void) | null = null) {
    this.root = path.resolve(root);
    this.backupRoot = path.resolve(backupRoot);
    this.entries = new Map();
    this.onWrite = onWrite;
    fs.mkdirSync(this.backupRoot, { recursive: true });
  }

  relative(target: string): { relative: string; resolved: string } {
    const resolved = path.resolve(target);
    const relative = path.relative(this.root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Install target escapes Codex home: ${resolved}`);
    }
    return { relative, resolved };
  }

  stage(target: string): string {
    const { relative, resolved } = this.relative(target);
    if (this.entries.has(resolved)) return resolved;
    const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
    const entry: Entry = { existed: Boolean(stat), relative, target: resolved };
    this.entries.set(resolved, entry);
    if (stat) {
      const backup = path.join(this.backupRoot, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.cpSync(resolved, backup, { recursive: stat.isDirectory() });
    }
    return resolved;
  }

  remove(target: string): string {
    const resolved = this.stage(target);
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { force: true, recursive: true });
    return resolved;
  }

  installDir(source: string, target: string): string {
    const sourceStat = fs.statSync(source, { throwIfNoEntry: false });
    if (!sourceStat?.isDirectory()) throw new Error(`Install source directory missing: ${source}`);
    const resolved = this.remove(target);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.cpSync(source, resolved, { recursive: true });
    this.onWrite?.(resolved);
    return resolved;
  }

  copyFile(source: string, target: string): string {
    const sourceStat = fs.statSync(source, { throwIfNoEntry: false });
    if (!sourceStat?.isFile()) throw new Error(`Install source file missing: ${source}`);
    const resolved = this.remove(target);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.copyFileSync(source, resolved);
    this.onWrite?.(resolved);
    return resolved;
  }

  writeFile(target: string, content: string): string {
    const resolved = this.stage(target);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    this.onWrite?.(resolved);
    return resolved;
  }

  rollback(): void {
    for (const entry of [...this.entries.values()].reverse()) {
      if (fs.existsSync(entry.target)) fs.rmSync(entry.target, { force: true, recursive: true });
      if (entry.existed) {
        const backup = path.join(this.backupRoot, entry.relative);
        fs.mkdirSync(path.dirname(entry.target), { recursive: true });
        const stat = fs.statSync(backup);
        fs.cpSync(backup, entry.target, { recursive: stat.isDirectory() });
      }
    }
  }

  targets(): string[] {
    return [...this.entries.keys()];
  }
}

import fs from "node:fs";
import path from "node:path";

interface Entry {
  existed: boolean;
  relative: string;
  target: string;
}

function exists(target: string): boolean {
  return Boolean(fs.lstatSync(target, { throwIfNoEntry: false }));
}

function retireStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

export class InstallTransaction {
  root: string;
  backupRoot: string;
  entries: Map<string, Entry>;
  createdGraveyards: string[];
  onWrite: ((target: string) => void) | null;

  constructor(root: string, backupRoot: string, onWrite: ((target: string) => void) | null = null) {
    this.root = path.resolve(root);
    this.backupRoot = path.resolve(backupRoot);
    this.entries = new Map();
    this.createdGraveyards = [];
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

  // #44. Retirement parks instead of deleting, as bootstrap/transaction-retire.sh
  // does: the file moves into a _deprecated/ sibling after its backup is staged,
  // so rollback puts it back at the original path. An occupied destination gets
  // the dated suffix .<YYYYmmdd-HHMMSS>, counted up -1, -2, ... until free; a
  // parked file is never overwritten. The stamp parameter exists for tests only.
  park(target: string, stamp: string = retireStamp()): string {
    const resolved = this.stage(target);
    const graveyard = path.join(path.dirname(resolved), "_deprecated");
    if (!exists(graveyard)) {
      fs.mkdirSync(graveyard);
      this.createdGraveyards.push(graveyard);
    }
    let dest = path.join(graveyard, path.basename(resolved));
    if (exists(dest)) {
      const dated = `${dest}.${stamp}`;
      dest = dated;
      for (let attempt = 1; exists(dest); attempt += 1) dest = `${dated}-${attempt}`;
    }
    fs.renameSync(resolved, dest);
    this.onWrite?.(dest);
    return dest;
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
    // A parked copy stays where it is: removing it would be the delete park()
    // avoids. A _deprecated/ this run created goes only while it is empty.
    for (const graveyard of this.createdGraveyards.reverse()) {
      try { fs.rmdirSync(graveyard); } catch { /* holds a parked copy */ }
    }
    this.createdGraveyards = [];
  }

  targets(): string[] {
    return [...this.entries.keys()];
  }
}

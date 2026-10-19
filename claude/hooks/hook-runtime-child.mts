// Child processes of the hook-runtime suites (issue #507, part 2): one fixed
// program, started as `node hook-runtime-child.mts <scenario> <data.json>`. The
// suites never build program text: every path, byte string and module location
// arrives as data, and the scenario name picks one of the fixed steps below.
// Several of them end the process with SIGKILL at a chosen point, which is the
// crash the suites study.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Data {
  runtime: string; hooks: string; rel?: string; text?: string; prefix?: string; go?: string; bound?: string; swap?: string;
  args?: Record<string, string>; target?: string; guard?: string;
}

const [scenario, dataFile] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(dataFile!, "utf8")) as Data;
const runtime = (name: string): Promise<Record<string, any>> => import(pathToFileURL(path.join(data.runtime, name)).href);
const kill = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("not reached"); };
const bytes = (): Uint8Array => new TextEncoder().encode(data.text!);
const waitFor = (file: string): void => { while (!fs.existsSync(file)) { const t = Date.now(); while (Date.now() - t < 20); } };
const waitAsync = async (file: string): Promise<void> => { while (!fs.existsSync(file)) await new Promise((r) => setTimeout(r, 20)); };

const db = await runtime("coordinator-db.mts");
const it = await runtime("coordinator-intent.mts");
const writeExact = (await runtime("recovery/restore-write.mts")).writeExact;

// Writers for the persisted-intent crash matrix: each stands in for writeExact.
const writers: Record<string, (file: string, b: Uint8Array, ...rest: unknown[]) => string> = {
  truncate: (file) => { fs.truncateSync(file, 0); return kill(); },
  prefix: (file) => { fs.writeFileSync(file, data.prefix!); return kill(); },
  "no-fsync": (file, b) => { const fd = fs.openSync(file, "r+"); fs.writeSync(fd, b); return kill(); },
  proven: (...a) => { const why = writeExact(...a); if (why) throw new Error(why); return kill(); },
  denied: () => "open failed (EACCES); nothing was written",
  "disk-full": (file) => { fs.writeFileSync(file, data.prefix!); return "write failed (ENOSPC)"; },
};

async function recorded(): Promise<any> {
  const o = await db.openDatabase(data.hooks);
  db.initialize(o.conn);
  o.conn.exec("BEGIN EXCLUSIVE");
  it.recordIntent(o, data.rel!, bytes());
  o.conn.exec("COMMIT");
  return o;
}

// The replay command's seams, by name.
function seams(name: string): Record<string, unknown> {
  switch (name) {
    case "kill-after-rebind": return { afterRebind: kill };
    case "kill-after-rebind-commit": return { afterRebindCommit: kill };
    case "kill-at-write": return { write: { writeChunk: kill } };
    case "kill-after-prefix": return { write: { writeChunk: (fd: number) => { fs.writeSync(fd, data.prefix!); return kill(); } } };
    case "kill-before-clear-commit": return { beforeClearCommit: kill };
    case "pause-after-rebind-commit": return { afterRebindCommit: () => { fs.writeFileSync(data.bound!, ""); waitFor(data.go!); } };
    case "swap-before-open": return { write: { beforeOpen: (file: string) => fs.renameSync(data.swap!, file) } };
    case "swap-parent-before-open": return { write: { beforeOpen: (file: string) => {
      const dir = path.dirname(file); // a Windows target is joined with backslashes
      fs.renameSync(dir, `${dir}-old`);
      fs.symlinkSync(data.swap!, dir, "dir");
    } } };
    case "write-denied": return { writer: writers.denied };
    default: throw new Error(`unknown seam ${name}`);
  }
}

const [step, variant] = scenario!.split(":");
switch (step) {
  case "init-crash": {
    const o = await db.openDatabase(data.hooks);
    db.initialize(o.conn, { afterCreate: kill });
    break;
  }
  case "init-retry": {
    for (let i = 0; i < 200; i++) {
      try { const o = await db.openDatabase(data.hooks); db.initialize(o.conn); o.conn.close(); break; } catch (e) {
        if ((e as { kherepKind?: string }).kherepKind !== "busy") throw e;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    break;
  }
  case "record": { // record, then: kill | exclusive-kill | apply-<writer>[-commit] | apply-real-commit-kill | (nothing)
    const o = await recorded();
    if (variant === "kill") kill();
    if (variant === "exclusive-kill") { o.conn.exec("BEGIN EXCLUSIVE"); kill(); }
    if (variant?.startsWith("apply-")) {
      const [, writer, then] = /^apply-(.+?)(-commit|-commit-kill)?$/.exec(variant)!;
      o.conn.exec("BEGIN EXCLUSIVE");
      it.applyPending(o, writer === "real" ? writeExact : writers[writer!]);
      if (then) o.conn.exec("COMMIT");
      if (then === "-commit-kill") kill();
    }
    break;
  }
  case "writer-a": { // admitted writer: records its repair, waits in the commit gap, then reports
    const c = await runtime("coordinator.mts");
    const cap = await c.admit({ v: 1, mode: "writer", root: data.hooks, target: data.target, deadline: Date.now() + 60_000 });
    const r = await cap.repair(data.rel, bytes(), { afterPrepare: async () => { process.stdout.write("prepared\n"); await waitAsync(data.go!); } });
    cap.end();
    process.stdout.write(JSON.stringify(r));
    break;
  }
  case "writer-b": { // admitted writer in A's gap: what does the target hold once admitted?
    const c = await runtime("coordinator.mts");
    const cap = await c.admit({ v: 1, mode: "writer", root: data.hooks, target: data.target, deadline: Date.now() + 60_000 });
    process.stdout.write(fs.readFileSync(data.guard!, "utf8") === data.text ? "A's bytes" : "other");
    cap.end();
    break;
  }
  case "replay": {
    const r = await runtime("replay-pending.mts");
    const a = data.args!;
    const out = await r.replay({ hooksRoot: a["--hooks-root"], intent: a["--intent"], desiredSha: a["--desired-sha"],
      currentDev: a["--current-dev"], currentIno: a["--current-ino"], currentSha: a["--current-sha"] }, seams(variant!));
    process.stdout.write(`\n${JSON.stringify(out)}`);
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  SOURCE_MANIFEST, captureSourceIdentity, createSourceManifest, type SourceIdentity,
} from "./daemon-source.mts";

export interface ServiceSourcePin { root: string; identity: SourceIdentity }

export function sourceArchiveExtractor(
  platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return "tar";
  const windowsRoot = env.SystemRoot ?? env.WINDIR;
  if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) throw new Error("Windows source extractor is unavailable");
  return path.win32.join(windowsRoot, "System32", "tar.exe");
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  if (result.status !== 0) throw new Error(`${command} failed while creating the source pin`);
}

export function pinServiceSource(sourceRoot: string, serviceRoot: string): ServiceSourcePin {
  const source = captureSourceIdentity(sourceRoot);
  const pins = path.join(serviceRoot, "source-pins");
  const destination = path.join(pins, source.commit);
  fs.mkdirSync(pins, { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) {
    const identity = captureSourceIdentity(destination);
    if (identity.commit !== source.commit || identity.digest !== source.digest) {
      throw new Error("existing source pin conflicts with the requested commit");
    }
    return { root: destination, identity };
  }

  const stage = path.join(pins, `.stage-${source.commit}-${process.pid}-${Date.now()}`);
  const archive = `${stage}.tar`;
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    run("git", ["-C", source.root, "-c", "core.autocrlf=false", "archive", "--format=tar", "-o", archive, source.commit], source.root);
    run(sourceArchiveExtractor(), ["-xf", archive, "-C", stage], source.root);
    const manifest = createSourceManifest(source.root, stage, source.commit, source.digest);
    fs.writeFileSync(path.join(stage, SOURCE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const staged = captureSourceIdentity(stage);
    if (staged.commit !== source.commit || staged.digest !== source.digest) throw new Error("archived source does not match its checkout");
    try {
      fs.renameSync(stage, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const identity = captureSourceIdentity(destination);
    if (identity.commit !== source.commit || identity.digest !== source.digest) throw new Error("existing source pin conflicts with the requested commit");
    return { root: destination, identity };
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

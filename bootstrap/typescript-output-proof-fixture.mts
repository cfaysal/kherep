import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export interface CompilerPlan {
  files: Record<string, string>;
  delayMs?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdoutBytes?: number;
  stderrBytes?: number;
  requireCanonicalProject?: boolean;
}

interface FixtureOptions {
  compiler?: boolean;
  output?: boolean;
  files?: Record<string, string>;
}

const FAKE_COMPILER = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const argument = (name) => process.argv[process.argv.indexOf(name) + 1];",
  "const configFile = argument('--project');",
  "const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));",
  "const plan = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'compiler-plan.json'), 'utf8'));",
  "if (plan.requireCanonicalProject",
  "  && fs.realpathSync(configFile) !== fs.realpathSync(path.join(process.cwd(), 'tsconfig.json'))) process.exit(77);",
  "if (plan.stdoutBytes) process.stdout.write('o'.repeat(plan.stdoutBytes));",
  "if (plan.stderrBytes) process.stderr.write('e'.repeat(plan.stderrBytes));",
  "if (plan.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, plan.delayMs);",
  "if (plan.signal) process.kill(process.pid, plan.signal);",
  "if (plan.exitCode) process.exit(plan.exitCode);",
  "for (const [relative, content] of Object.entries(plan.files)) {",
  "  const file = path.join(argument('--outDir') || config.compilerOptions.outDir, relative);",
  "  fs.mkdirSync(path.dirname(file), { recursive: true });",
  "  fs.writeFileSync(file, content);",
  "}",
  "const buildInfo = argument('--tsBuildInfoFile') || config.compilerOptions.tsBuildInfoFile;",
  "fs.mkdirSync(path.dirname(buildInfo), { recursive: true });",
  "fs.writeFileSync(buildInfo, 'owned');",
].join("\n");

// A synthetic package: the proof is generic, the name carries no meaning.
export const FIXTURE_MODULE = ["modules", "compiled-example"] as const;

export interface OutputFixture {
  root: string;
  moduleRoot: string;
  dist: string;
  files: Record<string, string>;
  setPlan(plan: CompilerPlan): void;
  writeOutput(relative: string, content: string): void;
  writeInventory(paths: string[]): void;
  setVersion(location: "package" | "lock-root" | "lock-package" | "installed", version: string): void;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function outputFixture(t: TestContext, options: FixtureOptions = {}): OutputFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op1175-output-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, ...FIXTURE_MODULE);
  const dist = path.join(moduleRoot, "dist");
  const files = options.files ?? {
    "src/value.js": "export const value = 1;\n",
    "src/loader.mjs": "export default 2;\n",
    "src/legacy.cjs": "module.exports = 3;\n",
  };
  fs.mkdirSync(path.join(moduleRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "bootstrap", "manifest"), { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "src", "value.ts"), "export const value = 1;\n");
  writeJson(path.join(moduleRoot, "tsconfig.json"), {
    compilerOptions: { target: "ES2024", module: "NodeNext", rootDir: ".", outDir: "dist", declaration: true },
    include: ["src/**/*.ts"],
  });
  writeJson(path.join(moduleRoot, "package.json"), {
    name: "compiled-example", private: true, devDependencies: { typescript: "7.0.2" },
  });
  writeJson(path.join(moduleRoot, "package-lock.json"), {
    name: "compiled-example", lockfileVersion: 3, packages: {
      "": { devDependencies: { typescript: "7.0.2" } },
      "node_modules/typescript": { version: "7.0.2" },
    },
  });
  fs.writeFileSync(path.join(root, "bootstrap", "manifest", "legacy-javascript.txt"), "");

  const fixture: OutputFixture = {
    root, moduleRoot, dist, files,
    setPlan(plan) {
      writeJson(path.join(moduleRoot, "compiler-plan.json"), plan);
    },
    writeOutput(relative, content) {
      const file = path.join(dist, ...relative.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    writeInventory(paths) {
      fs.writeFileSync(path.join(root, "bootstrap", "manifest", "legacy-javascript.txt"), paths.join("\n") + "\n");
    },
    setVersion(location, version) {
      if (location === "package") {
        writeJson(path.join(moduleRoot, "package.json"), { devDependencies: { typescript: version } });
      } else if (location === "installed") {
        writeJson(path.join(moduleRoot, "node_modules", "typescript", "package.json"), {
          name: "typescript", version, bin: { tsc: "bin/tsc" },
        });
      } else {
        const lockFile = path.join(moduleRoot, "package-lock.json");
        const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        const key = location === "lock-root" ? "" : "node_modules/typescript";
        if (location === "lock-root") lock.packages[key].devDependencies.typescript = version;
        else lock.packages[key].version = version;
        writeJson(lockFile, lock);
      }
    },
  };
  fixture.setPlan({ files });
  if (options.compiler !== false) {
    const compilerRoot = path.join(moduleRoot, "node_modules", "typescript");
    fs.mkdirSync(path.join(compilerRoot, "bin"), { recursive: true });
    writeJson(path.join(compilerRoot, "package.json"), {
      name: "typescript", version: "7.0.2", bin: { tsc: "bin/tsc" },
    });
    fs.writeFileSync(path.join(compilerRoot, "bin", "tsc"), FAKE_COMPILER);
  }
  if (options.output !== false) {
    for (const [relative, content] of Object.entries(files)) fixture.writeOutput(relative, content);
  }
  return fixture;
}

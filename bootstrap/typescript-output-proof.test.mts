import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { COMPILED_MODULES } from "./typescript-convention.mts";
import { withCompilerEmission } from "./typescript-output-compiler.mts";
import { verifyCompiledOutput } from "./typescript-output-proof.mts";
import { FIXTURE_MODULE, outputFixture } from "./typescript-output-proof-fixture.mts";

const verify = (root: string, limits = {}) => verifyCompiledOutput(root, FIXTURE_MODULE, limits);

test("a Git-free archive without dist does not require a compiler", (t) => {
  const fixture = outputFixture(t, { compiler: false, output: false });
  assert.deepEqual([...verify(fixture.root)], []);
  assert.equal(fs.existsSync(path.join(fixture.root, ".git")), false);
});

test("an archive with dist but no installed compiler fails closed", (t) => {
  const fixture = outputFixture(t, { compiler: false });
  assert.throws(() => verify(fixture.root), /installed TypeScript compiler/);
});

test("all exact js, mjs and cjs compiler outputs are accepted", (t) => {
  const fixture = outputFixture(t);
  assert.deepEqual([...verify(fixture.root)].sort(), [
    "modules/compiled-example/dist/src/legacy.cjs",
    "modules/compiled-example/dist/src/loader.mjs",
    "modules/compiled-example/dist/src/value.js",
  ]);
});

test("the canonical project config drives emission while output flags stay temporary", (t) => {
  const fixture = outputFixture(t);
  fixture.setPlan({ files: fixture.files, requireCanonicalProject: true });
  assert.doesNotThrow(() => verify(fixture.root));
});

test("altered output fails even when a TypeScript source has the same basename", (t) => {
  const fixture = outputFixture(t);
  fixture.writeOutput("src/value.js", "export const value = 999;\n");
  assert.throws(() => verify(fixture.root), /altered generated output.*src\/value\.js/);
});

test("missing expected output fails", (t) => {
  const fixture = outputFixture(t);
  fs.rmSync(path.join(fixture.dist, "src", "value.js"));
  assert.throws(() => verify(fixture.root), /missing generated output.*src\/value\.js/);
});

test("extra output fails", (t) => {
  const fixture = outputFixture(t);
  fixture.writeOutput("src/extra.js", "hand authored\n");
  assert.throws(() => verify(fixture.root), /unexpected generated output.*src\/extra\.js/);
});

for (const hidden of ["_deprecated", "node_modules", ".hook-adapter-fixture"]) {
  test(`dist/${hidden} is enumerated rather than excluded`, (t) => {
    const fixture = outputFixture(t);
    fixture.writeOutput(`${hidden}/escape.js`, "hand authored\n");
    assert.throws(() => verify(fixture.root), /unexpected generated output/);
  });
}

for (const location of ["package", "lock-root", "lock-package", "installed"] as const) {
  test(`a ${location} compiler version mismatch fails before comparison`, (t) => {
    const fixture = outputFixture(t);
    fixture.setVersion(location, "7.0.3");
    assert.throws(() => verify(fixture.root), /TypeScript version mismatch/);
  });
}

test("compiler nonzero exit fails", (t) => {
  const fixture = outputFixture(t);
  fixture.setPlan({ files: fixture.files, exitCode: 2 });
  assert.throws(() => verify(fixture.root), /compiler exited unsuccessfully/);
});

test("compiler signal termination fails", (t) => {
  const fixture = outputFixture(t);
  fixture.setPlan({ files: fixture.files, signal: "SIGTERM" });
  assert.throws(() => verify(fixture.root), /compiler (?:was terminated|exited unsuccessfully)/);
});

test("compiler timeout fails", (t) => {
  const fixture = outputFixture(t);
  fixture.setPlan({ files: fixture.files, delayMs: 500 });
  assert.throws(() => verify(fixture.root, { timeoutMs: 25 }), /compiler timed out/);
});

test("compiler output overflow fails", (t) => {
  const fixture = outputFixture(t);
  fixture.setPlan({ files: fixture.files, stdoutBytes: 4096 });
  assert.throws(() => verify(fixture.root, { maxOutputBytes: 128 }), /compiler output exceeded/);
});

test("the child compiler receives an allowlisted environment", (t) => {
  const fixture = outputFixture(t);
  const compiler = path.join(fixture.moduleRoot, "node_modules", "typescript", "bin", "tsc");
  fs.appendFileSync(compiler, "\nif (process.env.OP1175_FORBIDDEN) process.exit(88);\n");
  process.env.OP1175_FORBIDDEN = "must-not-cross";
  t.after(() => delete process.env.OP1175_FORBIDDEN);
  assert.doesNotThrow(() => verify(fixture.root));
});

test("a configured outFile cannot escape the temporary output boundary", (t) => {
  // Needs the real pinned compiler, which only a compiled repository package installs.
  const installed = COMPILED_MODULES.map((modulePath) => path.resolve(import.meta.dirname, "..", ...modulePath))
    .find((moduleRoot) => fs.existsSync(path.join(moduleRoot, "node_modules", "typescript"))
      && fs.existsSync(path.join(moduleRoot, "node_modules", "@typescript", `typescript-${process.platform}-${process.arch}`)));
  if (installed === undefined) {
    t.skip("no compiled repository package has the pinned platform compiler installed");
    return;
  }
  const installedCompiler = path.join(installed, "node_modules", "typescript");

  const fixture = outputFixture(t, { compiler: false, output: false });
  const fixtureCompiler = path.join(fixture.moduleRoot, "node_modules", "typescript");
  fs.mkdirSync(path.dirname(fixtureCompiler), { recursive: true });
  fs.symlinkSync(installedCompiler, fixtureCompiler, "junction");
  const source = path.join(fixture.moduleRoot, "src", "value.ts");
  const sourceBefore = fs.readFileSync(source, "utf8");
  const escapedOutput = path.join(fixture.moduleRoot, "src", "escaped-output.js");
  fs.writeFileSync(path.join(fixture.moduleRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2024",
      module: "System",
      rootDir: ".",
      outFile: escapedOutput,
      declaration: false,
    },
    include: ["src/**/*.ts"],
  }));

  assert.throws(
    () => withCompilerEmission(fixture.moduleRoot, {}, () => undefined),
    /compiler exited unsuccessfully/,
  );
  assert.equal(fs.existsSync(escapedOutput), false);
  assert.equal(fs.readFileSync(source, "utf8"), sourceBefore);
});

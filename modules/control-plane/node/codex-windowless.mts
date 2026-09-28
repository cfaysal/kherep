import { spawn } from "node:child_process";

// Issue #124: `node codex-windowless.mts <file> <args...>` runs `<file>
// <args...>` as its attached child and forwards stdin, stdout, stderr and the
// exit code. The daemon starts this wrapper detached on Windows for operator
// Codex tasks (codex-process.mts spawnCodex), so the task still survives a
// daemon restart. A detached process has no console, and each console child
// of a console-less codex opened a visible window (issue #119). With every
// stdio stream piped and windowsHide set, Node starts the child with
// CREATE_NO_WINDOW: codex gets a console without a window, and the shells and
// MCP servers it starts share it. As an attached child, codex ends with this
// wrapper; `taskkill /T` on the wrapper's pid reaches the whole tree.

const [file, ...args] = process.argv.slice(2);
if (!file) {
  process.stderr.write("usage: codex-windowless.mts <file> [args...]\n");
  process.exit(2);
}
const child = spawn(file, args, { stdio: "pipe", windowsHide: true });
child.stdin.on("error", () => {}); // a codex that exits before reading
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
// After close, both output streams are drained into the files. A child that
// could not start keeps the 1 set above.
child.on("close", (code) => {
  process.exitCode ??= code ?? 1;
});

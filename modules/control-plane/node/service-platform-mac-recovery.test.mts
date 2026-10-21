// #582: restorePrior on the real MacServiceAdapter with a fake launchctl/plutil/ps/ls runner. A plist write changes only
// the file, never the loaded job; so a candidate that cannot be stopped must keep its own plist.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { managedArguments } from "./service-definitions.mts";
import { restorePrior } from "./service-lifecycle.mts";
import { MacServiceAdapter } from "./service-platform-mac.mts";
import { macFileSecurity, type MacCommand, type MacCommandResult } from "./service-platform-mac-native.mts";
import type { ServiceBinding } from "./service-types.mts";

const label = "org.kherep.synthetic.recovery";
const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });

function fixture(descendant: boolean, bootoutStatus: number) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-recovery-")));
  const home = path.join(root, "home");
  const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "CANDIDATE_PLIST", { mode: 0o600 });
  const stat = fs.lstatSync(file);
  const bind = (char: string, dir: string): ServiceBinding => ({ serviceName: label, platform: "darwin", workspace: root,
    configRoot: path.join(root, "config"), nodeExecutable: path.join(root, "node"),
    source: { root: path.join(root, dir), commit: char.repeat(40), digest: char.repeat(64), kind: "pin", verified: true } });
  const prior = bind("a", "old-pin"), candidate = bind("b", "new-pin");
  const argsOf = (binding: ServiceBinding) => [binding.nodeExecutable, ...managedArguments(binding)];
  let loaded = true;
  const calls: string[] = [];
  const run: MacCommand = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "launchctl" && args[0] === "print" && args[1] === `gui/${stat.uid}/${label}`) {
      if (!loaded) return result(113, "", `Could not find service "${label}" in domain for user gui: ${stat.uid}\n`);
      const loadedArgs = argsOf(candidate); // launchd keeps the candidate job, whatever the file says
      return result(0, `gui/${stat.uid}/${label} = {\n\tpath = ${file}\n\ttype = LaunchAgent\n\tstate = running\n\tprogram = ${loadedArgs[0]}\n`
        + `\targuments = {\n${loadedArgs.map(value => `\t\t${value}\n`).join("")}\t}\n`
        + "\tinherited environment = {\n\t}\n\tdefault environment = {\n\t}\n\tenvironment = {\n\t}\n\tpid = 4242\n}\n");
    }
    if (command === "launchctl" && args[0] === "print") return result(0, `gui/${stat.uid} = {\n}\n`);
    if (command === "launchctl" && args[0] === "bootout") { if (bootoutStatus === 0) loaded = false; return result(bootoutStatus); }
    if (command === "plutil") {
      const content = fs.readFileSync(args.at(-1)!, "utf8");
      return result(0, JSON.stringify({ Label: label, ProgramArguments: content === "PRIOR_PLIST" ? argsOf(prior) : argsOf(candidate) }));
    }
    if (command === "/bin/ls") return result(0, "-rw------- 1 operator staff 1 Oct 14 10:00 x.plist\n");
    if (command === "ps" && args.includes("ppid=")) return result(0, descendant ? "4242 1\n5000 4242\n" : "4242 1\n");
    return result(1, "", "unexpected synthetic command");
  };
  const adapter = new MacServiceAdapter(path.join(root, "service"), home, stat.uid, stat.gid, run);
  return { root, file, prior, candidate, adapter, calls, run };
}

const SCENARIOS = [["descendants", true, 0, "STOP_BLOCKED_NATIVE_DESCENDANTS", 0], ["bootout refused", false, 36, "STOP_NATIVE_REFUSED", 1]] as const;
for (const [name, descendant, bootout, stopCode, bootouts] of SCENARIOS) {
  test(`T6: a candidate whose stop fails (${name}) stays loaded with its own plist`, { skip: process.platform !== "darwin" }, async (t) => {
    const f = fixture(descendant, bootout);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const candidate = (await f.adapter.read(f.candidate))!;
    assert.equal(candidate.running, true);
    let error: (Error & { code?: string; stopCode?: string }) | undefined;
    try {
      await restorePrior({ binding: f.candidate, previous: { definition: Buffer.from("PRIOR_PLIST"), security: macFileSecurity(f.file, f.run), running: true },
        previousBinding: f.prior, previousPid: 41, candidate, priorStopIssued: true,
        deps: { paths: nodePaths(f.candidate.configRoot), adapter: f.adapter, timeoutMs: 10, sleep: async () => {},
          readDaemonState: () => ({ pid: 4242, startedAt: new Date().toISOString() }), pidAlive: pid => pid === 4242 } });
    } catch (caught) { error = caught as Error & { code?: string; stopCode?: string }; }
    assert.equal(error?.code, "RECOVERY_CANDIDATE_LOADED");
    assert.equal(error?.stopCode, stopCode);
    assert.equal(f.calls.filter(call => call.includes(" bootout ")).length, bootouts);
    assert.equal(fs.readFileSync(f.file, "utf8"), "CANDIDATE_PLIST", "the loaded candidate keeps its plist");
    const after = await f.adapter.read(f.candidate);
    assert.equal(after?.running, true, "launchd and the file still agree, so every later read attests");
    await f.adapter.validateManaged(after!, f.candidate);
    await assert.rejects(f.adapter.validateManaged(after!, f.prior), /does not match the managed source/);
    // Characterization of the wedge this prevents: the prior plist under the loaded candidate is refused by every read.
    fs.writeFileSync(f.file, "PRIOR_PLIST", { mode: 0o600 });
    await assert.rejects(f.adapter.read(f.candidate), /loaded definition does not match/);
  });
}

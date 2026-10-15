import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { quoteWindowsArg } from "./service-definitions.mts";
import { launchTarget, macAclAbsent, MAC_EXECUTABLE_PROBE, validateServiceName } from "./service-platform-mac.mts";
import { normalizeTaskPath, powerShellInvocation, splitWindowsService,
  WINDOWS_READ_SCRIPT, WINDOWS_WRITE_SCRIPT, WindowsServiceAdapter, windowsFreshXml, windowsPrincipalSid,
  windowsTaskProvenanceValid } from "./service-platform-windows.mts";
import {
  WINDOWS_PROCESS_HELPERS_SCRIPT, WINDOWS_PROCESS_PROVENANCE_SCRIPT, WINDOWS_STOP_SCRIPT,
} from "./service-platform-windows-process.mts";
import type { ServiceBinding } from "./service-types.mts";

const binding: ServiceBinding = {
  serviceName: "Kherep & Node", taskPath: "\\", platform: "win32", workspace: String.raw`C:\Work & Test`,
  configRoot: String.raw`C:\Config <Node>`, nodeExecutable: String.raw`C:\Program Files\nodejs\node.exe`,
  logFile: String.raw`C:\Config <Node>\service\daemon.log`,
  supervisorGeneration: "22222222-2222-4222-8222-222222222222",
  source: { root: String.raw`C:\Pins\abc def`, commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
};

test("native service names and macOS launchctl targets are exact", () => {
  assert.equal(validateServiceName("com.example.kherep-node"), "com.example.kherep-node");
  assert.throws(() => validateServiceName("../foreign/service"), /invalid service name/);
  assert.equal(launchTarget(501, "com.example.kherep-node"), "gui/501/com.example.kherep-node");
  assert.deepEqual(splitWindowsService("\\Kherep\\Node", undefined), { serviceName: "Node", taskPath: "\\Kherep\\" });
  assert.deepEqual(splitWindowsService("Node", "\\Kherep\\"), { serviceName: "Node", taskPath: "\\Kherep\\" });
  assert.equal(normalizeTaskPath("\\Kherep\\"), "\\Kherep\\");
  assert.throws(() => splitWindowsService("\\Kherep\\Node", "\\Other\\"), /task path.*twice/i);
  assert.equal(MAC_EXECUTABLE_PROBE, "/usr/bin/osascript");
});

test("PowerShell uses bounded stdin script transport and keeps values outside its command text", { skip: process.platform !== "win32" }, () => {
  const payload = { serviceName: 'Task "$(foreign)"', definition: "SYNTHETIC_NATIVE_XML" };
  const invocation = powerShellInvocation(`${"# synthetic padding\n".repeat(3_000)}Write-Output $payload.serviceName`, payload);
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(invocation.args[3], /Console\]::In\.ReadToEnd/);
  assert.ok(invocation.args.join(" ").length < 1_000);
  assert.equal(invocation.args.join(" ").includes(payload.serviceName), false);
  assert.equal(invocation.args.join(" ").includes(payload.definition), false);
  assert.match(invocation.input, /FromBase64String\(\$env:KHEREP_SERVICE_PAYLOAD\)/);
  assert.deepEqual(JSON.parse(Buffer.from(invocation.env.KHEREP_SERVICE_PAYLOAD!, "base64").toString("utf8")), payload);
  const result = spawnSync(invocation.executable, invocation.args, { input: invocation.input,
    env: invocation.env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, (result.error as NodeJS.ErrnoException | undefined)?.code);
  assert.equal(result.stdout.trim(), payload.serviceName);
});

test("Windows process helpers execute under stock PowerShell without automatic-variable collisions", { skip: process.platform !== "win32" }, () => {
  const automatic = new Set(["args", "error", "foreach", "home", "host", "input", "matches", "myinvocation",
    "null", "pid", "profile", "psboundparameters", "pscmdlet", "pscommandpath", "pshome", "psitem",
    "psscriptroot", "pwd", "shellid", "stacktrace", "switch", "this", "true", "false"]);
  const parameters = [...WINDOWS_PROCESS_HELPERS_SCRIPT.matchAll(/function\s+[^\s(]+\(([^)]*)\)/gi)]
    .flatMap(match => match[1].split(",").map(value => /\$([A-Za-z][A-Za-z0-9]*)/.exec(value)?.[1].toLowerCase()))
    .filter((value): value is string => value !== undefined);
  assert.deepEqual(parameters.filter(value => automatic.has(value)), []);
  const commandLine = [process.execPath, "arg one", "plain"].map(quoteWindowsArg).join(" ");
  const base = powerShellInvocation("", {});
  const invocation = powerShellInvocation(`${WINDOWS_PROCESS_HELPERS_SCRIPT};
    $synthetic=[pscustomobject]@{ExecutablePath=$payload.node;CommandLine=$payload.commandLine}
    $expected=@{executable=$payload.node;argv=@($payload.node,'arg one','plain')}
    $bad=@{executable=$payload.node;argv=@($payload.node,'different','plain')}
      $missing=[pscustomobject]@{Name=[IO.Path]::GetFileName($payload.node);ExecutablePath=$null;CommandLine=$null}
      $foreign=[pscustomobject]@{Name='synthetic-foreign.exe';ExecutablePath=$null;CommandLine=$null}
      $created=[datetime]'2026-10-14T12:00:00.0000000Z'
      $near=[pscustomobject]@{StartTime=$created.AddTicks(9)}
      $far=[pscustomobject]@{StartTime=$created.AddMilliseconds(2)}
      $observed=[pscustomobject]@{CreationDate=$created}
    $parents=@{3=2;2=1}
    $all=@([pscustomobject]@{ProcessId=2;ParentProcessId=1},[pscustomobject]@{ProcessId=3;ParentProcessId=2})
    @{absolute=((Resolve-KherepExecutable $payload.node)-ceq[IO.Path]::GetFullPath($payload.node));
      fallback=[IO.Path]::IsPathRooted((Resolve-KherepExecutable $payload.fallback));
      argsTrue=(Test-KherepArgs $synthetic $expected);argsFalse=(-not(Test-KherepArgs $synthetic $bad));
        missingUnknown=((Test-KherepCandidate $missing $expected 'S-1-5-21-1-2-3-1001')-ceq'unknown');
        foreignIgnored=((Test-KherepCandidate $foreign $expected 'S-1-5-21-1-2-3-1001')-ceq'foreign');
        retainedRounding=(Test-KherepRetainedStart $near $observed);
        retainedReused=(-not(Test-KherepRetainedStart $far $observed));
      ancestor=(Test-KherepAncestor 3 1 $parents);descendants=(@(Get-KherepDescendants -rootPid 1 -all $all).Count-eq2)}|
      ConvertTo-Json -Compress`, { node: process.execPath, commandLine, fallback: path.basename(base.executable) });
  const result = spawnSync(invocation.executable, invocation.args, {
    input: invocation.input, env: invocation.env, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, "the helper must execute, not only parse");
  assert.deepEqual(JSON.parse(result.stdout), {
      fallback: true, absolute: true, descendants: true, ancestor: true, foreignIgnored: true,
      missingUnknown: true, retainedReused: true, retainedRounding: true, argsFalse: true, argsTrue: true,
  });
});

test("Windows wrapper selection preserves 0/1/many CIM arrays and intended throw diagnostics", { skip: process.platform !== "win32" }, () => {
  const rawSelection = /\$wrappers=(.*?);\$wrapper=/.exec(WINDOWS_PROCESS_PROVENANCE_SCRIPT)?.[1];
  const throwStatement = /(throw[^}]*expected supervisor task provenance differs')/.exec(WINDOWS_STOP_SCRIPT)?.[1];
  assert.ok(rawSelection && throwStatement);
  const selection = `$wrappers=${rawSelection.replaceAll("$payload.wrapper", "$expected")}`;
  const commandLine = [process.execPath, "synthetic arg"].map(quoteWindowsArg).join(" ");
  const invocation = powerShellInvocation(`${WINDOWS_PROCESS_HELPERS_SCRIPT};
    $self=[pscustomobject]@{ProcessId=3;ParentProcessId=2;ExecutablePath=$payload.node;CommandLine=$payload.commandLine}
    $expected=@{executable=$payload.node;argv=@($payload.node,'synthetic arg')}
    $actionMatches=$true;$engine=2;$parents=@{3=2}
    function Measure-KherepWrappers([int]$count){$all=@(for($i=0;$i-lt$count;$i++){$self});
      ${selection};if($null-eq$wrappers.Count){return -1};return [int]$wrappers.Count}
    $diagnostic=$false;try{${throwStatement}}catch{$diagnostic=$_.Exception.Message-ceq'expected supervisor task provenance differs'}
    @{zero=(Measure-KherepWrappers 0);one=(Measure-KherepWrappers 1);
      many=(Measure-KherepWrappers 2);diagnostic=$diagnostic}|ConvertTo-Json -Compress`, {
        node: process.execPath, commandLine,
      });
  const result = spawnSync(invocation.executable, invocation.args, {
    input: invocation.input, env: invocation.env, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, "the native selection must execute under stock PowerShell");
  assert.deepEqual(JSON.parse(result.stdout), { diagnostic: true, one: 1, zero: 0, many: 2 });
});

test("Windows security restore skips an exact descriptor and uses creation flag 16 only for exact recovery", () => {
  assert.match(WINDOWS_WRITE_SCRIPT, /GetSecurityDescriptor\(7\)/);
  assert.match(WINDOWS_WRITE_SCRIPT, /if\(\$actual -cne \$requested\)/);
  assert.match(WINDOWS_WRITE_SCRIPT, /SetSecurityDescriptor\(\$requested,16\)/);
  assert.equal((WINDOWS_WRITE_SCRIPT.match(/GetSecurityDescriptor\(7\)/g) ?? []).length, 2);
  assert.doesNotMatch(WINDOWS_WRITE_SCRIPT, /SetSecurityDescriptor\([^;]*,7\)/);
});

test("macOS ACL inventory reads full rows instead of trusting the mode suffix", () => {
  assert.equal(macAclAbsent("-rw-------@ 1 operator staff 1 Oct 14 10:00 service.plist\n"), true);
  assert.equal(macAclAbsent("-rw-r-----+ 1 operator staff 1 Oct 14 10:00 service.plist\n 0: user:example allow read\n"), false);
  assert.throws(() => macAclAbsent(""), /inventory is empty/);
});

test("fresh Windows XML escapes every operator path and uses interactive least privilege", () => {
  const definition = windowsFreshXml(binding, "EXAMPLE\\operator");
  assert.equal(definition.length % 2, 0);
  const xml = definition.toString("utf16le");
  assert.equal(xml.includes(binding.workspace), false);
  assert.match(xml, /C:\\Work &amp; Test/);
  assert.equal(xml.includes(binding.configRoot), false, "binding data stays inside the bounded encoded payload");
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.equal(path.win32.isAbsolute(binding.nodeExecutable), true);
  assert.match(xml, /<Command>C:\\Windows\\System32\\conhost\.exe<\/Command>/i);
  assert.match(xml, /<Arguments>--headless /);
});

test("Windows process provenance binds the daemon to one current-user task instance", () => {
  const evidence = { ownerSid: "S-1-5-21-1-2-3-1001", currentSid: "S-1-5-21-1-2-3-1001", selectedInstances: 1,
    enginePid: 900, engineInAncestry: true, matchingEngineTasks: 1, supervisorPid: 901, supervisorOwner: true,
    daemonDirectChild: true, supervisorChildren: 1, daemonDescendants: 0 };
  assert.equal(windowsTaskProvenanceValid(evidence), true);
  assert.equal(windowsTaskProvenanceValid({ ...evidence, engineInAncestry: false }), false, "an identical unrelated process is rejected");
  assert.equal(windowsTaskProvenanceValid({ ...evidence, ownerSid: "S-1-5-21-1-2-3-1002" }), false);
  assert.equal(windowsTaskProvenanceValid({ ...evidence, matchingEngineTasks: 2 }), false, "a shared engine is ambiguous");
  assert.equal(windowsTaskProvenanceValid({ ...evidence, selectedInstances: 0 }), false, "a foreign running task path is rejected");
  assert.equal((WINDOWS_PROCESS_PROVENANCE_SCRIPT.match(/GetRunningTasks\(1\)/g) ?? []).length, 1,
    "hidden tasks come from one complete running population");
  assert.doesNotMatch(WINDOWS_PROCESS_PROVENANCE_SCRIPT, /GetInstances/);
  assert.match(WINDOWS_PROCESS_PROVENANCE_SCRIPT, /\.Path -ceq \$registered\.Path/);
  assert.match(WINDOWS_PROCESS_PROVENANCE_SCRIPT, /supervisorPid/);
  assert.match(WINDOWS_PROCESS_PROVENANCE_SCRIPT, /ParentProcessId\s*-eq\s*\$supervisorPid/,
    "the daemon must be a direct child of the fixed task supervisor");
  assert.match(WINDOWS_PROCESS_PROVENANCE_SCRIPT, /supervisorChildren/);
});

test("only a Ready Windows task is accepted as quiescent", () => {
  assert.match(WINDOWS_READ_SCRIPT, /State -eq 'Running'\)\{\$true\}/);
  assert.match(WINDOWS_READ_SCRIPT, /State -eq 'Ready'\)\{\$false\}/);
  assert.match(WINDOWS_READ_SCRIPT, /else\{'unknown'\}/,
    "queued, disabled, and unreadable task states must not be treated as stopped");
});

test("Windows stop retains both owned handles, stops the supervisor first, and rejects replacement children", () => {
  assert.equal((WINDOWS_STOP_SCRIPT.match(/GetRunningTasks\(1\)/g) ?? []).length, 1);
  assert.doesNotMatch(WINDOWS_STOP_SCRIPT, /GetInstances/);
  assert.match(WINDOWS_STOP_SCRIPT, /CommandLineToArgvW/);
  assert.equal((WINDOWS_STOP_SCRIPT.match(/GetProcessById/g) ?? []).length >= 2, true);
  assert.match(WINDOWS_STOP_SCRIPT, /\$supervisorRetained\.Handle/);
  assert.match(WINDOWS_STOP_SCRIPT, /\$daemonRetained\.Handle/);
  assert.match(WINDOWS_STOP_SCRIPT, /Test-KherepRetainedStart \$supervisorRetained \$wrapperFresh/);
  assert.match(WINDOWS_STOP_SCRIPT, /Test-KherepRetainedStart \$daemonRetained \$daemonFresh/);
  assert.doesNotMatch(WINDOWS_STOP_SCRIPT, /TotalMilliseconds\)-gt2000/);
  assert.match(WINDOWS_STOP_SCRIPT, /STOP_BLOCKED_NATIVE_DESCENDANTS/);
  assert.match(WINDOWS_STOP_SCRIPT, /WaitForExit\(10000\)/);
  assert.match(WINDOWS_STOP_SCRIPT, /replacement daemon appeared while stopping the supervisor/);
  const handle = WINDOWS_STOP_SCRIPT.indexOf("$supervisorRetained.Handle");
  const owner = WINDOWS_STOP_SCRIPT.indexOf("Test-KherepOwner $wrapper");
  const stop = WINDOWS_STOP_SCRIPT.indexOf("Stop-ScheduledTask");
  const supervisorKill = WINDOWS_STOP_SCRIPT.indexOf("$supervisorRetained.Kill()");
  const daemonKill = WINDOWS_STOP_SCRIPT.indexOf("$daemonRetained.Kill()");
  assert.ok(handle >= 0 && handle < owner && owner < stop && stop < supervisorKill && supervisorKill < daemonKill);
  assert.match(WINDOWS_STOP_SCRIPT, /elseif\(\$supervisorChildren\.Count-ne0\)/,
    "a managed supervisor can be stopped safely while its child is in the restart gap");
  assert.match(WINDOWS_STOP_SCRIPT, /\$null-eq\$payload\.expected -and \$selected\.Count-eq0/);
  assert.match(WINDOWS_STOP_SCRIPT, /\[int\]\$registered\.State-ne3/,
    "a missing running instance is a no-op only when the selected task is genuinely Ready");
  assert.match(WINDOWS_STOP_SCRIPT, /\$detachedWrappers\.Count-ne0/);
  assert.match(WINDOWS_STOP_SCRIPT, /\$detachedDaemons\.Count-ne0/,
    "Ready is not absence while an exact managed supervisor or its known child survives detached");
  assert.equal((WINDOWS_STOP_SCRIPT.match(/Test-KherepCandidate/g) ?? []).length >= 3, true,
    "Ready absence treats plausible processes with unreadable metadata as unknown");
  assert.doesNotMatch(WINDOWS_STOP_SCRIPT, /expected\.daemon/);
  assert.doesNotMatch(WINDOWS_STOP_SCRIPT, /Kill\([^)]*true/);
});

test("Windows current-user account names and SIDs resolve to one principal", { skip: process.platform !== "win32" }, async () => {
  const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const sid = windowsPrincipalSid(account);
  assert.match(sid, /^S-\d(?:-\d+)+$/);
  assert.equal(await new WindowsServiceAdapter().currentUser(), sid);
  assert.equal(windowsPrincipalSid(sid), sid);
  assert.throws(() => windowsPrincipalSid("KHEREP\\NoSuchPrincipal-404"), /principal identity is unresolved/);
});

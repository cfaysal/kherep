import { legacyDaemonArguments, managedArguments } from "./service-definitions.mts";
import {
  attestMacLaunchAgent, attestMacProcessAbsence, probeMacLaunchAgent, readMacPlist, sameMacLaunchAgent,
  type MacCommand, type MacLaunchAgentProbe,
} from "./service-platform-mac-native.mts";
import type { ServiceBinding } from "./service-types.mts";

export function attestMacNoContextStop(
  run: MacCommand, uid: number, binding: ServiceBinding, file: string,
): MacLaunchAgentProbe {
  const before = probeMacLaunchAgent(run, uid, binding.serviceName);
  if (before.kind === "loaded") {
    if (before.pid !== undefined) throw new Error("selected LaunchAgent process is unavailable");
    attestMacLaunchAgent(before, file, readMacPlist(run, file));
  }
  const commands = [
    [binding.nodeExecutable, ...managedArguments(binding)].join(" "),
    [binding.nodeExecutable, ...legacyDaemonArguments(binding, binding.source.root)].join(" "),
    ...(before.kind === "loaded" ? [before.arguments.join(" ")] : []),
  ];
  attestMacProcessAbsence(run, [...new Set(commands)]);
  const after = probeMacLaunchAgent(run, uid, binding.serviceName);
  if (!sameMacLaunchAgent(before, after)) throw new Error("LaunchAgent loaded identity changed during stop preflight");
  if (after.kind === "loaded") {
    if (after.pid !== undefined) throw new Error("selected LaunchAgent process is unavailable");
    attestMacLaunchAgent(after, file, readMacPlist(run, file));
  }
  return after;
}

import path from "node:path";

import type { ServiceBinding } from "./service-types.mts";

const MAX_PAYLOAD = 16_384;
const exactKeys = (value: Record<string, unknown>, expected: string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const absolute = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && (path.isAbsolute(value) || path.win32.isAbsolute(value));

function validBinding(value: unknown): value is ServiceBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  if (!exactKeys(binding, ["serviceName", "taskPath", "platform", "workspace", "configRoot", "nodeExecutable", "logFile", "supervisorGeneration", "source"])) return false;
  const source = binding.source;
  if (!source || typeof source !== "object" || !exactKeys(source as Record<string, unknown>,
    ["root", "commit", "digest", "kind", "verified"])) return false;
  const identity = source as Record<string, unknown>;
  return binding.platform === "win32" && typeof binding.serviceName === "string" && binding.serviceName.length > 0
    && typeof binding.taskPath === "string" && absolute(binding.workspace) && absolute(binding.configRoot)
    && absolute(binding.nodeExecutable) && absolute(binding.logFile)
    && typeof binding.supervisorGeneration === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.supervisorGeneration)
    && absolute(identity.root)
    && typeof identity.commit === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(identity.commit)
    && typeof identity.digest === "string" && /^[0-9a-f]{64}$/.test(identity.digest)
    && identity.kind === "pin" && identity.verified === true;
}

export function encodeSupervisorBinding(binding: ServiceBinding): string {
  if (!validBinding(binding)) throw new Error("Windows service supervisor requires a verified binding and absolute log file");
  const encoded = Buffer.from(JSON.stringify({ version: 1, binding }), "utf8").toString("base64");
  if (encoded.length > MAX_PAYLOAD) throw new Error("Windows service supervisor payload size is invalid");
  return encoded;
}

export function decodeSupervisorBinding(encoded: string): ServiceBinding {
  if (!encoded || encoded.length > MAX_PAYLOAD || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Windows service supervisor payload size is invalid");
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
  catch { throw new Error("Windows service supervisor payload schema is invalid"); }
  if (!value || typeof value !== "object" || !exactKeys(value as Record<string, unknown>, ["version", "binding"])) {
    throw new Error("Windows service supervisor payload schema is invalid");
  }
  const envelope = value as { version?: unknown; binding?: unknown };
  if (envelope.version !== 1 || !validBinding(envelope.binding)) {
    throw new Error("Windows service supervisor payload schema is invalid");
  }
  return envelope.binding;
}

export function supervisorArguments(binding: ServiceBinding): string[] {
  return [path.join(binding.source.root, "modules", "control-plane", "node", "service-supervisor.mts"),
    encodeSupervisorBinding(binding)];
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isNodeId } from "../protocol.mts";

// Non-secret node configuration. It names the key file but never contains
// key material, so it can be read, copied or attached to a support request.
export interface NodeConfig {
  version: 1;
  controlUrl: string;
  nodeId: string;
  name: string;
  publicKey: string;
  privateKeyFile: string;
  policyFile: string;
  enrolledAt: string;
}

// KHEREP_CONFIG_DIR wins; otherwise the per-user config location of the OS.
export function configRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.KHEREP_CONFIG_DIR) return path.resolve(env.KHEREP_CONFIG_DIR);
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "kherep");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "kherep");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "kherep");
}

// outbox, sent, directory, sessions, directoryRequest and codexSessions are the
// files the daemon exchanges with the session tools (msg CLI, delivery hook).
export interface NodePaths {
  dir: string; config: string; privateKey: string; policy: string; inbox: string;
  outbox: string; sent: string; directory: string; sessions: string; directoryRequest: string; codexSessions: string;
  // Item 5: the tasks this node started, the task reports and task requests the daemon sends.
  tasks: string; taskReports: string; taskRequests: string;
}

export function nodePaths(root: string = configRoot()): NodePaths {
  const dir = path.join(root, "control-plane");
  return {
    dir,
    config: path.join(dir, "node.json"),
    privateKey: path.join(dir, "node-ed25519.pem"),
    policy: path.join(dir, "policy.json"),
    inbox: path.join(dir, "inbox"),
    outbox: path.join(dir, "outbox"),
    sent: path.join(dir, "sent"),
    directory: path.join(dir, "directory.json"),
    sessions: path.join(dir, "sessions.json"),
    directoryRequest: path.join(dir, "directory.request"),
    codexSessions: path.join(dir, "codex-sessions"),
    tasks: path.join(dir, "tasks"),
    taskReports: path.join(dir, "task-reports"),
    taskRequests: path.join(dir, "task-requests"),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// The control plane must be reached over TLS; plain http is accepted only for
// a loopback development Worker (wrangler dev).
export function normalizeControlUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("control URL must use https");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("control URL must be an origin");
  return url.origin;
}

export function connectUrl(controlUrl: string, nodeId: string): string {
  const url = new URL("/node/connect", controlUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("nodeId", nodeId);
  return url.toString();
}

export function writeConfig(file: string, config: NodeConfig): void {
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function readConfig(file: string): NodeConfig | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text) as NodeConfig;
  if (value.version !== 1 || !isNodeId(value.nodeId)) throw new Error(`invalid node config: ${file}`);
  return value;
}

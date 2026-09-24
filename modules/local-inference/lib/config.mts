// Route configuration of the local-inference runner. The built-in fallback is
// deliberately unconfigured so a missing installation can never guess a host,
// endpoint, process command, or model.

export type Profile = "win" | "mac";
export type Transport = "local" | "ssh";
export type Env = Record<string, string | undefined>;

export interface BackendConfig {
  engine: string;
  endpoint: string;
  model?: string;
  keepAlive?: string[];
  start?: string[];
  coldLaunch?: string[];
  readyAttempts?: number;
  readyDelayMs?: number;
}

export interface RouteConfig {
  transport: Transport;
  sshHost?: string;
}

export interface LocalInferenceConfig {
  schemaVersion: number;
  backends: Record<string, BackendConfig>;
  profiles: Record<string, { backends: Record<string, RouteConfig> }>;
  [key: string]: unknown;
}

// A backend merged with the host route that reaches it.
export type BackendSpec = BackendConfig & RouteConfig;

export const DEFAULT_CONFIG: LocalInferenceConfig = {
  schemaVersion: 2,
  backends: {},
  profiles: {
    win: { backends: {} },
    mac: { backends: {} },
  },
};

// Shared narrowing for values that arrive untyped: parsed JSON, `catch (error)`
// (unknown under strict), process results and argv lists from the environment.
// One place, so every bootstrap script asks the same question the same way.

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// One property of a value that may not be an object at all: `undefined` for
// anything that is not a record, so callers can chain without a guard first.
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

// An argv prefix handed over as JSON (KHEREP_*_BIN_ARGS_JSON): only a list of
// NUL-free strings may reach execFileSync. Anything else fails closed.
export function isArgvList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && !item.includes("\0"));
}

// Node attaches `code` to its own errors (ENOENT, EEXIST, ...). Anything else
// reports "" so a caller can never mistake a missing code for a known one.
export function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

// execFileSync attaches the child's exit status the same way; only an integer
// counts, exactly as the JavaScript `Number.isInteger(error.status)` did.
export function errorStatus(error: unknown): number | undefined {
  const status = field(error, "status");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

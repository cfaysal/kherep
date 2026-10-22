// Classifies the error of an exclusive create (open with "wx") of a lock file
// (issues #600, #602). On Windows the lock file of a holder that is releasing it
// is delete-pending for a moment, and an exclusive create on it fails with
// ERROR_ACCESS_DENIED, which libuv reports as EPERM (CREATE_NEW on a file that
// simply exists gives EEXIST). EBUSY and EACCES are included defensively (#540
// precedent); neither is observed or documented for an exclusive create. A
// retry-shaped code is no diagnosis of its cause: the caller waits it out within
// a bound and never treats it as evidence that the holder is gone.
//
// Callers classify the exclusive open only, never a mkdir, stat, read, write,
// fsync, close, rename or release that happens to return one of these codes.
// This module never sleeps on its own, never touches a file and never decides
// staleness. It imports nothing, so the client binding probe, a package of its
// own, can use it too. inbox-record-lock.mts keeps its own LOCK_HELD_CODES: it
// is copied into the staged messaging client, whose file graph would otherwise
// have to list this module.

export type ExclusiveCreateOutcome = "exists" | "retry" | "other";

export const TRANSIENT_CREATE_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
// At most this many opens failing with a transient code per top-level call,
// separated by pauses of at least CONTENTION_PAUSE_MS.
export const CONTENTION_ATTEMPTS = 50;
export const CONTENTION_PAUSE_MS = 4;

export function classifyExclusiveCreate(error: unknown): ExclusiveCreateOutcome {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "EEXIST") return "exists";
  return typeof code === "string" && TRANSIENT_CREATE_CODES.has(code) ? "retry" : "other";
}

export const pauseSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

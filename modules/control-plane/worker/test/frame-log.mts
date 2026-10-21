import type { Envelope, MessageType } from "../../protocol.mts";
import type { MessageStatusBody } from "../../protocol-messages.mts";

// Issue #607: the node e2e harnesses wait on the protocol event they need, the
// frame the client handled (or dropped, or sent), instead of polling a file
// every 50 ms within a bound equal to the test's own. A wait that misses its
// event fails with the frames this log holds, not with the test bound.
export const EVENT_TIMEOUT_MS = 10_000;
// Above the event waits of the longest e2e test (seven) plus enrolment and
// connect, so the first missing event names itself before the test bound fires.
export const E2E_TIMEOUT_MS = 90_000;

type Match = Record<string, unknown>;
interface Waiter { check: () => Envelope | undefined; resolve: (envelope: Envelope) => void }

const matches = (envelope: Envelope, type: MessageType, match: Match): boolean => envelope.type === type
  && Object.entries(match).every(([key, value]) => (envelope.body as Match)[key] === value);

// The frames one side of a connection saw, in order. add() is called when the
// frame is complete for the caller: for a handled frame after client.onFrame
// returned and its answers went out, so the local records the handler wrote
// (inbox, sent, directory) are on disk when a waiter resumes.
export class FrameLog {
  private readonly frames: Envelope[] = [];
  private waiters: Waiter[] = [];

  add(envelope: Envelope): void {
    this.frames.push(envelope);
    const due = this.waiters.filter((waiter) => waiter.check() !== undefined);
    this.waiters = this.waiters.filter((waiter) => !due.includes(waiter));
    for (const waiter of due) waiter.resolve(waiter.check()!);
  }

  // The frames of `type` whose body carries every field of `match`, so far.
  list(type: MessageType, match: Match = {}): Envelope[] {
    return this.frames.filter((frame) => matches(frame, type, match));
  }

  count(type: MessageType, match: Match = {}): number {
    return this.list(type, match).length;
  }

  // Resolves with the n-th such frame, already logged or still to come.
  seen(type: MessageType, match: Match = {}, n = 1, timeoutMs = EVENT_TIMEOUT_MS): Promise<Envelope> {
    const check = (): Envelope | undefined => this.list(type, match)[n - 1];
    const past = check();
    if (past) return Promise.resolve(past);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { check, resolve: (envelope) => { clearTimeout(timer); resolve(envelope); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((other) => other !== waiter);
        const seen = JSON.stringify(this.frames.map((frame) => [frame.type, frame.body]));
        reject(new Error(`no ${n > 1 ? `${n}. ` : ""}${type} ${JSON.stringify(match)} within ${timeoutMs} ms; seen: ${seen}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

// Every answer the Worker owes this node for what it sent has been handled: a
// directory for each directory.get, a receipt for each status report. A socket
// closed before that leaves the Worker a send on a closed socket (an uncaught
// exception in its NodeSession, noise in the run). Answers to message.send are
// the sender's own waits: a forwarded status is not told apart from one.
export async function answered(outgoing: FrameLog, handled: FrameLog): Promise<void> {
  const directories = outgoing.count("directory.get");
  if (directories > 0) await handled.seen("directory", {}, directories);
  const reports = new Map<string, { messageId: string; state: string; n: number }>();
  for (const frame of outgoing.list("message.status")) {
    const { messageId, state } = frame.body as MessageStatusBody;
    const entry = reports.get(`${messageId} ${state}`) ?? { messageId, state, n: 0 };
    entry.n++;
    reports.set(`${messageId} ${state}`, entry);
  }
  for (const { messageId, state, n } of reports.values()) {
    await handled.seen("event", { name: "message.receipt", messageId, requestedState: state }, n);
  }
}

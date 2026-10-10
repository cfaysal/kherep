// Synthetic two-process storage fixture, never part of an installed Hook.
import { claimBusyHint, publishBusyHint, type BusyHintAdmission } from "./codex-busy-ticket.mts";

const [directory, owner, policy, time, action, serialized, delay] = process.argv.slice(2);
process.once("message", () => {
  let observed: { generation: string; messages: BusyHintAdmission["messages"] } | undefined;
  const result = action === "publish"
    ? publishBusyHint(directory, JSON.parse(serialized) as BusyHintAdmission, Number(time))
    : claimBusyHint(directory, owner, policy, Number(time), (ticket) => {
      observed = { generation: ticket.generation, messages: ticket.messages.map((message) => ({ ...message })) };
      // Simulate bounded synchronous record reads with different completion
      // times. An unlocked reader would act on the same stale unclaimed ticket.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay));
      return ticket.messages.length;
    });
  process.send?.({ type: "result", result, observed }, () => process.disconnect());
});
process.send?.({ type: "ready" });

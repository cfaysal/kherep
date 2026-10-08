// The labels verb and the one rule every label write shares: a page carries
// exactly one runtime label (see confluence-runtime-label.mts for why it is
// computed). Issue #318: reading a page's labels used to write the runtime
// label, so a page touched from two hosts ended up carrying two of them, and
// a page created without --labels carried none.
//
// It lives beside the brokers rather than in them for the same reason as
// confluence-neighbour-cli.mts: both brokers import it, so it exists once.
import { ConfluenceError, type ConfluenceSession } from "./confluence-contract.mts";
import { addLabels, listLabels, removeLabels } from "./confluence-content.mts";
import { withRuntimeLabel } from "./confluence-runtime-label.mts";
import { createSession, type ConfluenceContext } from "./confluence-session.mts";

export interface LabelCliContext extends ConfluenceContext {
  log: (line: string) => void;
}

export type LabelArgs = Record<string, string | undefined>;

const UNKNOWN = "UNKNOWN - not reported by the API";
const isRuntime = (name: string): boolean => name.startsWith("runtime-");

export interface EnsuredLabels {
  // False when there was nothing to write: the page already has a runtime
  // label and the caller asked for no other label.
  wrote: boolean;
  lines: string[];
}

// Reads the page's labels first. An existing runtime label is kept, never
// joined by a second one; only a page without any gets the computed label.
// Caller-supplied runtime labels are dropped either way.
export async function ensureRuntimeLabel(
  session: ConfluenceSession,
  id: string,
  requested: readonly string[],
  credEnv: string,
  env: Record<string, string | undefined>,
): Promise<EnsuredLabels> {
  const existing = (await listLabels(session, id)).filter(isRuntime);
  const wanted = withRuntimeLabel(requested, credEnv, env);
  const computed = wanted.at(-1) ?? "";
  const hasRuntime = existing.length > 0;
  const toPost = hasRuntime ? wanted.slice(0, -1) : wanted;
  const runtime = hasRuntime ? `runtime: kept ${existing.join(", ")}` : `runtime: added ${computed}`;
  if (toPost.length === 0) return { wrote: false, lines: [runtime] };
  const labels = await addLabels(session, id, toPost);
  return { wrote: true, lines: [`labels: ${labels.join(", ") || UNKNOWN}`, runtime] };
}

// The known fault: a page that carries two runtime labels. The operator names
// the one that is true; anything that does not look exactly like that fault is
// refused before a write, because a guess here erases the only host record.
async function keepRuntime(ctx: LabelCliContext, args: LabelArgs): Promise<number> {
  const keep = args["keep-runtime"] ?? "";
  if (args.labels !== undefined || args.remove !== undefined) {
    throw new ConfluenceError("--keep-runtime cannot be combined with --labels or --remove.");
  }
  if (!isRuntime(keep)) throw new ConfluenceError("--keep-runtime takes a runtime- label.");
  const session = createSession(ctx);
  const id = args.id ?? "";
  const runtime = (await listLabels(session, id)).filter(isRuntime);
  if (runtime.length < 2) {
    throw new ConfluenceError(`${runtime.length === 1 ? "one runtime label" : "no runtime label"}: nothing to repair.`);
  }
  if (runtime.length > 2) {
    throw new ConfluenceError(`${runtime.length} runtime labels (${runtime.join(", ")}) is not the known fault; nothing was changed.`);
  }
  if (!runtime.includes(keep)) {
    throw new ConfluenceError(`${keep} is not on the page; it carries ${runtime.join(", ")}.`);
  }
  const other = runtime.find((name) => name !== keep) ?? "";
  const left = await removeLabels(session, id, [other]);
  const stuck = left.includes(other);
  ctx.log(`runtime: kept ${keep}`);
  if (!stuck) ctx.log(`runtime: removed ${other}`);
  ctx.log(`labels: ${left.join(", ")}`);
  if (stuck) throw new ConfluenceError(`still present: ${other}`);
  return 0;
}

export async function cmdLabels(ctx: LabelCliContext, args: LabelArgs): Promise<number> {
  if (args["keep-runtime"] !== undefined) return keepRuntime(ctx, args);
  const session = createSession(ctx);
  const id = args.id ?? "";
  if (args.remove !== undefined) {
    // The runtime label is computed by the broker; removing it by hand would
    // make the page's author unattributable. Repairing a duplicate is
    // --keep-runtime, which refuses everything but that one fault.
    const unwanted = args.remove.split(",").map((name) => name.trim()).filter(Boolean);
    if (unwanted.some(isRuntime)) throw new ConfluenceError("--remove cannot take the runtime label.");
    const left = await removeLabels(session, id, unwanted);
    ctx.log(`labels: ${left.join(", ")}`);
    const stuck = unwanted.filter((name) => left.includes(name));
    if (stuck.length > 0) throw new ConfluenceError(`still present: ${stuck.join(", ")}`);
    // A pure removal ends here; --labels as well continues to the add below.
    if (args.labels === undefined) return 0;
  }
  if (args.labels === undefined) {
    // A read is a read: no POST, no DELETE.
    ctx.log(`labels: ${(await listLabels(session, id)).join(", ") || "none"}`);
    return 0;
  }
  const result = await ensureRuntimeLabel(session, id, args.labels.split(","), ctx.credEnv, ctx.env);
  if (!result.wrote) throw new ConfluenceError(`nothing to add: ${result.lines.join("; ")}.`);
  for (const line of result.lines) ctx.log(line);
  return 0;
}

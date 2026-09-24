#!/usr/bin/env node
// Codex Confluence broker. Credential values are read only through
// KHEREP_ATL_CRED_FILE_CODEX; the Claude broker beside it reads its own
// variable and neither can reach the other's. Paths, credentials and access
// tokens are never printed.
//
// The placement of these files in a directory named after Jira is deliberate
// and explained at the top of confluence-session.mts.
import { readFile as nodeReadFile } from "node:fs/promises";

import { ConfluenceError } from "./confluence-contract.mts";
import {
  addLabels,
  createPage,
  deletePage,
  findSpace,
  getPage,
  purgePage,
  removeLabels,
  representationFor,
  updatePage,
  type Page,
} from "./confluence-content.mts";
import {
  cmdChildren,
  cmdContext,
  cmdMove,
  cmdOrphans,
  cmdRelated,
  cmdSpace,
  cmdStitch,
  type NeighbourCliContext,
} from "./confluence-neighbour-cli.mts";
import { requireResolvableAnchors } from "./confluence-related.mts";
import { withRuntimeLabel } from "./confluence-runtime-label.mts";
import { semanticProposals } from "./confluence-semantic.mts";
import {
  authenticationReport,
  cloudId,
  createSession,
  currentUser,
} from "./confluence-session.mts";

const CRED_ENV = "KHEREP_ATL_CRED_FILE_CODEX";
// An absent value is UNKNOWN and says so. A blank line here would read like an
// answer, and an unverifiable author is the one thing this broker exists for.
const UNKNOWN = "UNKNOWN - not reported by the API";

// The neighbour verbs define the widest context, so the CLI adopts theirs
// rather than keeping a second copy that can drift away from it.
export type CliContext = NeighbourCliContext;

// credEnv is omitted on purpose: which credential variable this CLI reads is
// not injectable, or a caller could point the Codex broker at the Claude file.
export type Injected = Partial<Omit<CliContext, "credEnv">>;

export type Args = Record<string, string | undefined>;

// Abort throws instead of ending the process, so every failure path stays
// testable. The exit code is set only at the CLI boundary below.
class CliFailure extends Error {
  cliMessage: string;

  constructor(message: string) {
    super(message);
    this.cliMessage = message;
  }
}

function fail(message: string): never {
  throw new CliFailure(message);
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    args[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function bodyOf(ctx: CliContext, args: Args): Promise<string> {
  const file = args["body-file"];
  if (file) {
    try {
      return await ctx.readFile(file, "utf8");
    } catch {
      fail("--body-file is not readable.");
    }
  }
  if (args.body === undefined) fail("--body or --body-file is missing.");
  return args.body;
}

function printPage(ctx: CliContext, page: Page): void {
  ctx.log(`id: ${page.id}`);
  ctx.log(`title: ${page.title}`);
  ctx.log(`status: ${page.status}`);
  ctx.log(`version: ${page.version}`);
  ctx.log(`authorId: ${page.authorId || UNKNOWN}`);
  if (page.link) ctx.log(`link: ${page.link}`);
}

async function cmdCreate(ctx: CliContext, args: Args): Promise<number> {
  // Before anything reaches the network: an unsupported representation is a
  // caller error, not a site error.
  const representation = representationFor(args.format);
  const title = (args.title ?? "").trim();
  if (!title) fail("--title is missing.");
  const value = await bodyOf(ctx, args);
  const session = createSession(ctx);
  const space = await findSpace(session, args.space ?? "");
  if (!space) fail("No space with that key is visible to the service account.");
  // Before the write, not after.
  await requireResolvableAnchors(session, value, space.id);
  const page = await createPage(session, {
    spaceId: space.id, title, representation, value, parentId: args.parent,
  });
  if (!page.id) fail("create returned no page id, so nothing about it can be verified.");
  printPage(ctx, page);
  // Golden rule 13: the broker's own report is not evidence. The authorship
  // this broker exists to fix is proven by READING THE PAGE BACK.
  if (args.labels) {
    const wanted = withRuntimeLabel(args.labels.split(","), CRED_ENV, ctx.env);
    ctx.log(`labels: ${(await addLabels(session, page.id, wanted)).join(", ") || UNKNOWN}`);
  }
  const readback = await getPage(session, page.id);
  ctx.log(`readback authorId: ${readback.authorId || UNKNOWN}`);
  if (readback.authorId) return 0;
  ctx.logError("The page was created, but its author could not be read back. Authorship is UNVERIFIED.");
  return 1;
}

async function cmdUpdate(ctx: CliContext, args: Args): Promise<number> {
  const representation = representationFor(args.format);
  const value = await bodyOf(ctx, args);
  const session = createSession(ctx);
  // The space comes from the page, never from a flag a caller could get wrong.
  const current = await getPage(session, args.id ?? "");
  await requireResolvableAnchors(session, value, current.spaceId);
  const result = await updatePage(session, {
    id: args.id ?? "", representation, value, title: args.title, message: args.message,
  });
  ctx.log(`version read: ${result.readVersion}`);
  ctx.log(`version sent: ${result.sentVersion}`);
  printPage(ctx, result.page);
  return 0;
}

async function cmdGet(ctx: CliContext, args: Args): Promise<number> {
  printPage(ctx, await getPage(createSession(ctx), args.id ?? ""));
  return 0;
}

async function cmdDelete(ctx: CliContext, args: Args): Promise<number> {
  const session = createSession(ctx);
  await deletePage(session, args.id ?? "");
  ctx.log("deleted: the page moved to the trash. Permanent removal is the separate purge verb.");
  // Read back WITH the trashed status, otherwise a successful delete reports
  // "no longer readable", which reads like a failure and hides the state the
  // separate purge verb depends on.
  const after = await getPage(session, args.id ?? "", ["current", "trashed"]).catch(() => null);
  ctx.log(`readback status: ${after ? after.status || UNKNOWN : "the page is no longer readable"}`);
  return 0;
}

async function cmdPurge(ctx: CliContext, args: Args): Promise<number> {
  await purgePage(createSession(ctx), args.id ?? "");
  ctx.log("purged: the page is permanently removed.");
  return 0;
}

async function cmdLabels(ctx: CliContext, args: Args): Promise<number> {
  if (args.remove !== undefined) {
    // The runtime label is computed by the broker; removing it by hand would
    // make the page's author unattributable.
    const unwanted = args.remove.split(",").map((name) => name.trim()).filter(Boolean);
    if (unwanted.some((name) => name.startsWith("runtime-"))) fail("--remove cannot take the runtime label.");
    const left = await removeLabels(createSession(ctx), args.id ?? "", unwanted);
    ctx.log(`labels: ${left.join(", ")}`);
    const stuck = unwanted.filter((name) => left.includes(name));
    if (stuck.length > 0) fail(`still present: ${stuck.join(", ")}`);
    if (args.labels === undefined) return 0;
  }
  // The runtime half is never taken from the caller, here either: the correcting
  // verb is exactly where a wrong one would be introduced by hand.
  const wanted = withRuntimeLabel((args.labels ?? "").split(","), CRED_ENV, ctx.env);
  const added = await addLabels(createSession(ctx), args.id ?? "", wanted);
  ctx.log(`labels: ${added.join(", ") || UNKNOWN}`);
  return 0;
}

// Proves the credential and the site binding and touches no content: no space
// and no page are required, so a broken credential cannot surface as a failed
// page lookup.
async function cmdSelftest(ctx: CliContext): Promise<number> {
  const report = await authenticationReport(ctx);
  for (const line of report.lines) ctx.log(line);
  ctx.log(`cloudId: ${await cloudId(ctx)}`);
  const who = await currentUser(createSession(ctx));
  ctx.log(who
    ? `account: ${who.accountId}${who.displayName ? ` (${who.displayName})` : ""}`
    : "account: not reported - this binding cannot read the identity endpoint");
  return report.ok ? 0 : 1;
}

const COMMANDS: Record<string, (ctx: CliContext, args: Args) => Promise<number>> = {
  create: cmdCreate,
  update: cmdUpdate,
  get: cmdGet,
  delete: cmdDelete,
  purge: cmdPurge,
  labels: cmdLabels,
  move: cmdMove,
  space: cmdSpace,
  children: cmdChildren,
  related: cmdRelated,
  context: cmdContext,
  orphans: cmdOrphans,
  stitch: cmdStitch,
  selftest: cmdSelftest,
};

export async function runCli(argv: string[], injected: Injected = {}): Promise<number> {
  const ctx: CliContext = {
    env: injected.env ?? process.env,
    credEnv: CRED_ENV,
    readFile: injected.readFile ?? nodeReadFile,
    fetch: injected.fetch ?? globalThis.fetch,
    log: injected.log ?? ((line) => console.log(line)),
    logError: injected.logError ?? ((line) => console.error(line)),
    now: injected.now ?? (() => Date.now()),
    semantic: injected.semantic ?? semanticProposals,
    // Fresh per run. That binding is what makes the token cache safe.
    session: {},
  };
  const [command, ...rest] = argv;
  try {
    const run = COMMANDS[command];
    // One line on purpose: the contract test reads this source and requires every
    // verb of the command table to appear in a single usage string.
    if (!run) fail("Usage: create | update | get | delete | purge | labels | move | space | children | related | context | orphans | stitch | selftest");
    return await run(ctx, parseArgs(rest));
  } catch (error) {
    ctx.logError(error instanceof CliFailure || error instanceof ConfluenceError
      ? error.cliMessage
      : "Internal error.");
    return 1;
  }
}

// Only on a direct call. Without this guard every import - and therefore every
// test - would execute the command.
if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}

// The command wrappers for the four neighbour verbs. They live beside the
// behaviour rather than in the broker CLI for one reason: the broker CLI is the
// file everything else imports, and it is already at the size where a reader
// stops reading. Argument checking here, everything after it in
// confluence-neighbours.mts.
import { ConfluenceError } from "./confluence-contract.mts";
import { findSpace, listChildren, movePage, updatePage } from "./confluence-content.mts";
import {
  reportContext,
  reportOrphans,
  reportRelated,
  reportStitch,
  type NeighbourDeps,
} from "./confluence-neighbours.mts";
import type { Proposals } from "./confluence-semantic.mts";
import { createSession, type ConfluenceContext } from "./confluence-session.mts";

export interface NeighbourCliContext extends ConfluenceContext {
  log: (line: string) => void;
  logError: (line: string) => void;
  // The only dependency that reaches outside the Confluence API. Injected so a
  // test never spawns a process and a host without the tool fails loudly.
  semantic: (query: string, limit?: number) => Promise<Proposals>;
}

export type NeighbourArgs = Record<string, string | undefined>;

function positive(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ConfluenceError(`${flag} must be a positive whole number.`);
  return parsed;
}

// Every neighbour verb needs the space resolved first, so they share one setup.
async function neighbourDeps(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<NeighbourDeps> {
  const session = createSession(ctx);
  const space = await findSpace(session, args.space ?? "");
  if (!space) throw new ConfluenceError("No space with that key is visible to the service account.");
  return {
    session,
    spaceId: space.id,
    spaceKey: space.key,
    log: ctx.log,
    logError: ctx.logError,
    semantic: ctx.semantic,
    // Only the stitching verb writes, and it reaches the write path through
    // here rather than importing it, so the read-only verbs cannot reach it.
    update: async (id, storage, message) => {
      await updatePage(session, { id, representation: "storage", value: storage, message });
    },
  };
}

export async function cmdRelated(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const title = (args.title ?? "").trim();
  if (!title) throw new ConfluenceError("--title is missing.");
  return await reportRelated(await neighbourDeps(ctx, args), {
    title,
    id: args.id,
    parentId: args.parent,
    limit: positive(args.limit, "--limit") ?? 3,
  });
}

export async function cmdContext(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const id = (args.id ?? "").trim();
  if (!id) throw new ConfluenceError("--id is missing.");
  return await reportContext(await neighbourDeps(ctx, args), id);
}

export async function cmdOrphans(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  return await reportOrphans(await neighbourDeps(ctx, args));
}

export async function cmdStitch(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  return await reportStitch(await neighbourDeps(ctx, args), {
    limit: positive(args.limit, "--limit"),
    perOrphan: positive(args["per-orphan"], "--per-orphan"),
    dryRun: "dry-run" in args,
    only: args.id,
  });
}

// Where a space is and what hangs directly under a page. They sit here rather
// than in the broker CLI for the same reason as the rest of this file: every
// one of them answers where something sits.
export async function cmdSpace(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const space = await findSpace(createSession(ctx), args.space ?? "");
  if (!space) {
    ctx.logError("No space with that key is visible to the service account.");
    return 1;
  }
  ctx.log(`id: ${space.id}`);
  ctx.log(`key: ${space.key}`);
  ctx.log(`name: ${space.name}`);
  return 0;
}

export async function cmdChildren(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const children = await listChildren(createSession(ctx), args.id ?? "");
  for (const child of children) ctx.log(`${child.id}\t${child.title}`);
  ctx.log(`count: ${children.length}`);
  return 0;
}

// Re-parenting: the verb that puts a page where it belongs. It sits here for the
// same reason as the two above - it answers where something sits - and it is the
// only one of them that changes the answer.
//
// The report comes from the TARGET, not from the write. A PUT that returns 200
// says the request was accepted; the new parent's own child list is what says
// the page arrived (golden rule 13). The list is read to exhaustion by
// listChildren, so "not among them" is a measured absence rather than the first
// 25 entries.
export async function cmdMove(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  const session = createSession(ctx);
  const result = await movePage(session, args.id ?? "", args.parent ?? "");
  // An empty fromParent is a page that hung at the space root, which is exactly
  // the case this verb exists to repair. It is named, not printed as blank.
  ctx.log(`from parent: ${result.fromParent || "none - the page hung at the space root"}`);
  ctx.log(`to parent: ${result.toParent}`);
  ctx.log(`version: ${result.page.version}`);
  const pageId = result.page.id || (args.id ?? "").trim();
  const children = await listChildren(session, result.toParent);
  ctx.log(`children at target: ${children.length}`);
  if (!children.some((child) => child.id === pageId)) {
    ctx.logError(`Page ${pageId} is not among the children of ${result.toParent}. The move is UNVERIFIED.`);
    return 1;
  }
  ctx.log(`readback parent: ${result.toParent}`);
  return 0;
}

import { ConfluenceError, type ConfluenceSession } from './confluence-contract.mts';
import { findSpace } from './confluence-content.mts';
import { scanDrainage } from './confluence-drainage-scan.mts';
import { execFileAsync } from './confluence-evidence-io.mts';
import { gitIncomplete } from './confluence-revision-staleness.mts';
import { gitProbe, REF } from './confluence-revision-staleness-git.mts';
import { createSession } from './confluence-session.mts';
import type { NeighbourArgs, NeighbourCliContext } from './confluence-neighbour-cli.mts';
import type { ExecLike } from './confluence-semantic.mts';

export interface DrainageDeps {
  // Injected by tests only; the broker runs git through execFile and builds the session from its context.
  exec?: ExecLike;
  session?: ConfluenceSession;
}

export async function cmdDrainage(ctx: NeighbourCliContext, args: NeighbourArgs, deps: DrainageDeps = {}): Promise<number> {
  if (!Object.hasOwn(args,'metadata-approved')) throw new ConfluenceError('Classify and approve page-id/version metadata before scanning (--metadata-approved).');
  const parseIds = (raw: string | undefined): string[] | undefined => {
    if (raw === undefined) return undefined;
    const values = raw.split(',');
    if (values.some(id => !/^\d+$/.test(id))) throw new ConfluenceError('Page ids must be numeric.');
    return values;
  };
  const pageIds = parseIds(args.ids);
  const excludeIds = parseIds(args['exclude-ids']);
  // #693: read-only git on the operator's checkout; --ref names the commit to compare with (default HEAD, never fetched).
  const root = args['repo-root'], ref = args.ref ?? 'HEAD';
  if (root !== undefined && !root.trim()) throw new ConfluenceError('--repo-root must name a checkout.');
  if (args.ref !== undefined && root === undefined) throw new ConfluenceError('--ref needs --repo-root.');
  if (!REF.test(ref)) throw new ConfluenceError('--ref must be a branch, tag or remote-tracking name.');
  const session = deps.session ?? createSession(ctx);
  const space = await findSpace(session,args.space ?? '').catch(() => {
    throw new ConfluenceError('Space resolution failed. Coverage UNKNOWN; inspect locally without sharing server content.');
  });
  if (!space) throw new ConfluenceError('No matching space is visible to the service account. Coverage UNKNOWN.');
  const probe = root === undefined ? null : gitProbe(deps.exec ?? execFileAsync, root);
  const report = await scanDrainage(session,{spaceId:space.id,metadataApproved:true,pageIds,excludeIds,now:ctx.now,staleness:{probe,ref}});
  ctx.log(JSON.stringify(report,null,2));
  // D5: incomplete inventory, or a checkout that could not answer for a binding, is never a clean result.
  return report.inventory.status === 'complete' && !gitIncomplete(report.revisionStaleness) ? 0 : 2;
}

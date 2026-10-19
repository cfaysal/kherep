import { ConfluenceError } from './confluence-contract.mts';
import { findSpace } from './confluence-content.mts';
import { scanDrainage } from './confluence-drainage-scan.mts';
import { createSession } from './confluence-session.mts';
import type { NeighbourArgs, NeighbourCliContext } from './confluence-neighbour-cli.mts';

export async function cmdDrainage(ctx: NeighbourCliContext, args: NeighbourArgs): Promise<number> {
  if (!Object.hasOwn(args,'metadata-approved')) throw new ConfluenceError('Classify and approve page-id/version metadata before scanning (--metadata-approved).');
  const parseIds = (raw: string | undefined): string[] | undefined => {
    if (raw === undefined) return undefined;
    const values = raw.split(',');
    if (values.some(id => !/^\d+$/.test(id))) throw new ConfluenceError('Page ids must be numeric.');
    return values;
  };
  const pageIds = parseIds(args.ids);
  const excludeIds = parseIds(args['exclude-ids']);
  const session = createSession(ctx);
  const space = await findSpace(session,args.space ?? '').catch(() => {
    throw new ConfluenceError('Space resolution failed. Coverage UNKNOWN; inspect locally without sharing server content.');
  });
  if (!space) throw new ConfluenceError('No matching space is visible to the service account. Coverage UNKNOWN.');
  const report = await scanDrainage(session,{spaceId:space.id,metadataApproved:true,pageIds,excludeIds,now:ctx.now});
  ctx.log(JSON.stringify(report,null,2));
  return report.inventory.status === 'complete' ? 0 : 2;
}

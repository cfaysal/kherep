/** Fixed observation-only restore snapshot. Never retarget the Control Plane. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const OBSERVATION_SOURCES = ['codex/hooks/obs-result-check.mts', 'codex/hooks/kherep-maestro-context.mts',
    'codex/hooks/confluence-delivery-check.mts', 'codex/hooks/observation-stop.mts', 'codex/hooks/observation-turn-completion.mts',
    'modules/atl-jira-brokers/observation-candidate.mts', 'modules/atl-jira-brokers/observation-result.mts',
    'modules/atl-jira-brokers/observation-lookup.mts',
    'codex/hooks/hook-integrity-repair.mts', 'codex/hooks/hook-integrity-sources.mts'] as const;
export const observationHash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function observationSnapshot(home: string, from: string): Buffer | null {
    if (!(OBSERVATION_SOURCES as readonly string[]).includes(from))
        return null;
    const root = path.join(home, 'orchestra', 'observation-source');
    if (!fs.existsSync(root))
        return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const file = path.join(root, from);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000)
        throw new Error('observation-source-unverified');
    const bytes = fs.readFileSync(file);
    if (manifest[from] !== observationHash(bytes))
        throw new Error('observation-source-unverified');
    return bytes;
}

/** Both full and scoped installs refresh this snapshot in their existing transaction. */
export function copyObservationSnapshot(repo: string, home: string, transaction: import('./install-transaction.mts').InstallTransaction): Record<string, string> {
    const manifest: Record<string, string> = {};
    for (const from of OBSERVATION_SOURCES) {
        const bytes = fs.readFileSync(path.join(repo, from), 'utf8');
        manifest[from] = observationHash(bytes);
        transaction.writeFile(path.join(home, 'orchestra', 'observation-source', from), bytes);
    }
    transaction.writeFile(path.join(home, 'orchestra', 'observation-source', 'manifest.json'), JSON.stringify(manifest));
    return manifest;
}

import { checkObsCandidate } from './observation-candidate.mts';
export type Finding = {
    title: string;
    bodyStorage: string;
    evidence: string;
    labels: string[];
    placement: {
        project: string;
        app: string;
    };
};
export type ObservationRequest = {
    sessionId: string;
    turnId: string;
    observations: Finding[];
    namedNode?: string;
};
export const NODES = new Set(['Atlassian', 'Development/General', 'Development/DC Apps',
    'Development/Forge Apps', 'Kherep', 'Operations']);
export const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
export const pageId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value);
// Model-authored storage is prose only. Related anchors are added by the
// broker after validation, never accepted from the caller.
const PROSE_TAGS = new Set(['p','pre','code','h1','h2','h3','h4','h5','h6',
    'ul','ol','li','blockquote','strong','em','b','i','s','u','del','ins','sub','sup',
    'table','thead','tbody','tfoot','tr','td','th','br','hr']);
export function ordinaryXhtml(storage: string): boolean {
    const open: string[] = [];
    let cursor = 0;
    while (true) {
        const start = storage.indexOf('<', cursor);
        if (start === -1) break;
        const end = storage.indexOf('>', start + 1);
        if (end === -1) return false;
        const tag = storage.slice(start, end + 1);
        cursor = end + 1;
        const parsed = /^<(\/?)([a-z][a-z0-9]*)\s*(\/?)>$/.exec(tag);
        if (!parsed || !PROSE_TAGS.has(parsed[2]) || parsed[1] && parsed[3]) return false;
        const [,closing,name,selfClosing] = parsed;
        if (closing) { if (open.pop() !== name) return false; }
        else if (!selfClosing && name !== 'br' && name !== 'hr') open.push(name);
    }
    return open.length === 0;
}
export function observationRequest(value: unknown): ObservationRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const r = value as ObservationRequest;
    if (Object.keys(r).some(k => !['sessionId', 'turnId', 'observations', 'namedNode'].includes(k))
        || !safeId(r.sessionId) || !safeId(r.turnId) || !Array.isArray(r.observations) || r.observations.length > 20
        || (r.namedNode !== undefined && !NODES.has(r.namedNode)))
        return null;
    if ('problem' in checkObsCandidate(JSON.stringify({ observations: r.observations })))
        return null;
    for (const f of r.observations) {
        if (f.title.length > 200 || f.bodyStorage.length > 24000
            || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(f.title + f.bodyStorage)
            || !ordinaryXhtml(f.bodyStorage)
            || !NODES.has(r.namedNode ?? f.placement.project)
            || f.placement.app.length > 120)
            return null;
    }
    return r;
}
export function failed(code: string, ids: readonly string[] = []): string {
    return `OBS-RESULT: failed ${code}${ids.length ? ` created=${ids.join(',')}` : ''}`;
}

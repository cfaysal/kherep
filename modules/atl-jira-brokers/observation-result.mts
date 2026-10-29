/** Pure, privacy-safe final handback parser. Never echoes rejected input. */
export type ObsResult = {
    status: 'wrote' | 'empty' | 'failed';
    ids: string[];
} | {
    problem: string;
};
export const OBS_FAILURES = new Set(['invalid-request', 'authority-unavailable', 'authority-denied',
    'space-mismatch', 'space-lookup-unavailable', 'space-unresolved', 'space-lookup-bindings-missing',
    'space-lookup-network-unavailable', 'space-lookup-timeout', 'placement-unresolved', 'identity-unavailable', 'related-unavailable',
    'create-unverified', 'labels-unverified', 'readback-unverified', 'stitch-unverified',
    'receipt-unavailable', 'receipt-conflict', 'publication-incomplete', 'broker-unavailable']);
export function checkObsResult(text: string): ObsResult {
    const bad = { problem: 'the result is not one strict publication receipt' };
    if (text.length > 1200)
        return bad;
    const line = text.trim();
    if (line === 'OBS-RESULT: empty no-admissible-findings')
        return { status: 'empty', ids: [] };
    const wrote = /^OBS-RESULT: wrote ([1-9]\d?) (\d{1,30}(?:,\d{1,30})*)$/.exec(line);
    const failed = /^OBS-RESULT: failed ([a-z-]+)(?: created=(\d{1,30}(?:,\d{1,30})*))?$/.exec(line);
    if (!wrote && (!failed || !OBS_FAILURES.has(failed[1])))
        return bad;
    const ids = (wrote?.[2] ?? failed?.[2] ?? '').split(',').filter(Boolean);
    if (ids.length > 20 || new Set(ids).size !== ids.length || (wrote && Number(wrote[1]) !== ids.length))
        return bad;
    return { status: wrote ? 'wrote' : 'failed', ids };
}

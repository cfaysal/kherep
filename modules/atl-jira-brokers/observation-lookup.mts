/** Observation-only diagnoses. Never inspect provider text or invoke error getters. */
export type LookupFailure = 'space-lookup-bindings-missing' | 'space-lookup-network-unavailable' | 'space-lookup-timeout';
export class ObservationLookupError extends Error {
    readonly code: LookupFailure;
    constructor(code: LookupFailure) { super(code); this.code = code; }
}
function data(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
    catch { return undefined; }
}
export function lookupFailure(error: unknown): string {
    const ownCode = data(error, 'code');
    if (ownCode === 'space-lookup-bindings-missing' || ownCode === 'space-lookup-network-unavailable' || ownCode === 'space-lookup-timeout') return ownCode;
    // Node fetch commonly keeps the explicit socket/DNS code on its direct cause.
    for (const value of [error, data(error, 'cause')]) {
        const code = data(value, 'code');
        if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT'
            || code === 'UND_ERR_BODY_TIMEOUT' || data(value, 'name') === 'TimeoutError') return 'space-lookup-timeout';
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ECONNRESET'
            || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'space-lookup-network-unavailable';
    }
    return 'space-lookup-unavailable';
}

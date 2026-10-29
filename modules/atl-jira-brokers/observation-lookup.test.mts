import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lookupFailure } from './observation-lookup.mts';
import { observationBroker } from './observation-broker.mts';
import { publishObservations } from './observation-publisher.mts';
import { receiptStore } from './observation-receipt.mts';
import type { ConfluenceContext } from './confluence-session.mts';
const request = () => ({ sessionId: 'synthetic', turnId: 'turn', observations: [{ title: 'Synthetic lookup', bodyStorage: '<p>Synthetic lookup</p>',
    evidence: 'assumed', labels: ['type-observation', 'evidence-assumed', 'status-author-model'], placement: { project: 'Kherep', app: '-' } }] });
function fixture(t: { after(fn: () => void): void }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-lookup-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'kherep'));
    fs.writeFileSync(path.join(home, 'kherep', 'confluence.json'), JSON.stringify({
        observationPublishingAuthorized: true, spaceKey: 'SYNTHETIC', spaceId: '10', nodes: { Kherep: '20' } }));
    const calls: { method: string; route: string }[] = [];
    const context: ConfluenceContext = {
        env: { KHEREP_ATL_SITE: 'https://synthetic.invalid', KHEREP_ATL_CRED_FILE_CODEX: '/synthetic-credential', KHEREP_PROFILE: 'mac' },
        credEnv: 'KHEREP_ATL_CRED_FILE_CODEX', readFile: async () => 'client_id: synthetic\nclient_secret: CANARY', now: Date.now, session: {},
        fetch: async (url, opts) => {
            calls.push({ method: opts?.method ?? 'GET', route: url });
            let json: Record<string, unknown> = {};
            if (url.endsWith('/oauth/token')) json = { access_token: 'CANARY', expires_in: 3600 };
            else if (url.endsWith('/_edge/tenant_info')) json = { cloudId: 'synthetic-cloud' };
            return { status: 200, ok: true, json: async () => json, text: async () => JSON.stringify(json) };
        },
    };
    return { home, calls, context, broker: observationBroker(home, context), store: receiptStore(path.join(home, 'receipts')) };
}

for (const [json, code] of [
    [null, 'space-lookup-unavailable'], [{}, 'space-lookup-unavailable'], [{ results: {} }, 'space-lookup-unavailable'],
    [{ results: [null] }, 'space-lookup-unavailable'], [{ results: [[]] }, 'space-lookup-unavailable'],
    [{ results: [{ key: 'SYNTHETIC', name: 'CANARY' }] }, 'space-lookup-unavailable'],
    [{ results: [{ id: 'CANARY', key: 'SYNTHETIC', name: 'CANARY' }] }, 'space-lookup-unavailable'],
    [{ results: [{ id: '10', key: 'OTHER', name: 'CANARY' }] }, 'space-lookup-unavailable'],
    [{ results: [{ id: '10', key: 'SYNTHETIC_EXTRA', name: 'Synthetic' }] }, 'space-lookup-unavailable'],
    [{ results: [{ id: '10', key: 'SYNTHETIC' }] }, 'space-lookup-unavailable'],
    [{ results: [{ id: '10', key: 'SYNTHETIC', name: 'Synthetic' }, { id: '11', key: 'SYNTHETIC', name: 'Synthetic' }] }, 'space-lookup-unavailable'],
    [{ results: [], _links: { next: '/wiki/api/v2/spaces?cursor=CANARY' } }, 'space-lookup-unavailable'],
    [{ results: [], _links: { next: 1 } }, 'space-lookup-unavailable'],
    [{ results: [], _links: [] }, 'space-lookup-unavailable'],
    [{ results: [] }, 'space-unresolved'],
    [{ results: [{ id: '10', key: 'synthetic', name: 'Synthetic' }] }, 'identity-unavailable'],
    [{ results: [{ id: '999', key: 'SYNTHETIC', name: 'Synthetic' }] }, 'space-mismatch'],
] as const) test(`actual space collection validation ${JSON.stringify(json)}`, async t => {
    const f = fixture(t);
    const fetch = f.context.fetch;
    let lookups = 0;
    f.context.fetch = async (url, opts) => {
        if (!url.includes('/spaces?')) return fetch(url, opts);
        lookups++;
        return { status: 200, ok: true, json: async () => json, text: async () => JSON.stringify(json) };
    };
    const result = await publishObservations(request(), f.broker, f.store);
    assert.equal(result, `OBS-RESULT: failed ${code}`);
    assert.equal(await publishObservations(request(), f.broker, f.store), result);
    assert.equal(lookups, 1);
    assert.equal(f.calls.filter(c => c.method === 'POST' && !c.route.endsWith('/oauth/token')).length, 0);
    assert.doesNotMatch(fs.readdirSync(path.join(f.home, 'receipts')).map(n => fs.readFileSync(path.join(f.home, 'receipts', n), 'utf8')).join(), /CANARY/);
});
for (const binding of ['KHEREP_ATL_SITE', 'KHEREP_ATL_CRED_FILE_CODEX'])
    test(`absent required process binding returns only a fixed code: ${binding}`, async t => {
        const f = fixture(t);
        delete f.context.env[binding];
        assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed space-lookup-bindings-missing');
        assert.equal(f.calls.length, 0);
    });
for (const [error, code] of [
    [Object.assign(new Error('CANARY'), { code: 'ENOTFOUND' }), 'space-lookup-network-unavailable'],
    [new Error('CANARY', { cause: Object.assign(new Error('CANARY'), { code: 'ECONNREFUSED' }) }), 'space-lookup-network-unavailable'],
    [Object.assign(new Error('CANARY'), { code: 'ETIMEDOUT' }), 'space-lookup-timeout'],
    [Object.assign(new Error('CANARY'), { name: 'TimeoutError' }), 'space-lookup-timeout'],
    [new Error('ENOTFOUND ETIMEDOUT CANARY'), 'space-lookup-unavailable'],
    [{ code: 'CANARY', cause: { message: 'ETIMEDOUT CANARY' } }, 'space-lookup-unavailable'],
    [{ get code() { throw new Error('CANARY getter invoked'); }, get cause() { throw new Error('CANARY getter invoked'); } }, 'space-lookup-unavailable'],
] as const) test(`explicit transport properties produce ${code}`, async t => {
    const f = fixture(t);
    let calls = 0;
    f.context.fetch = async () => { calls++; throw error; };
    const result = await publishObservations(request(), f.broker, f.store);
    assert.equal(result, `OBS-RESULT: failed ${code}`);
    assert.equal(await publishObservations(request(), f.broker, f.store), result);
    assert.equal(calls, 1);
    assert.doesNotMatch(fs.readdirSync(path.join(f.home, 'receipts')).map(n => fs.readFileSync(path.join(f.home, 'receipts', n), 'utf8')).join(), /CANARY|ENOTFOUND|ETIMEDOUT/);
});

test('diagnostic inspection never invokes getters or follows a second cause', () => {
    let reads = 0;
    const error = { get code() { reads++; return 'ENOTFOUND'; }, get name() { reads++; return 'TimeoutError'; },
        get cause() { reads++; return { code: 'ETIMEDOUT' }; }, get message() { reads++; return 'CANARY'; },
        toString() { reads++; return 'CANARY'; } };
    assert.equal(lookupFailure(error), 'space-lookup-unavailable');
    assert.equal(reads, 0);
    assert.equal(lookupFailure({ cause: { cause: { code: 'ENOTFOUND' } } }), 'space-lookup-unavailable');
    assert.equal(lookupFailure(Object.create({ code: 'ENOTFOUND' })), 'space-lookup-unavailable');
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    assert.equal(lookupFailure(cycle), 'space-lookup-unavailable');
});

for (const status of [401, 503]) test(`provider HTTP ${status} keeps generic lookup failure without raw detail`, async t => {
    const f = fixture(t);
    const fetch = f.context.fetch;
    let lookups = 0;
    f.context.fetch = async (url, opts) => {
        if (!url.includes('/spaces?')) return fetch(url, opts);
        lookups++;
        const json = { message: 'CANARY_PROVIDER ETIMEDOUT', code: 'ENOTFOUND', path: '/CANARY' };
        return { status, ok: false, json: async () => json, text: async () => JSON.stringify(json) };
    };
    const result = await publishObservations(request(), f.broker, f.store);
    assert.equal(result, 'OBS-RESULT: failed space-lookup-unavailable');
    assert.equal(await publishObservations(request(), f.broker, f.store), result);
    assert.equal(lookups, 1);
    assert.equal(f.calls.filter(c => c.method === 'POST' && !c.route.endsWith('/oauth/token')).length, 0);
    assert.doesNotMatch(fs.readdirSync(path.join(f.home, 'receipts')).map(n => fs.readFileSync(path.join(f.home, 'receipts', n), 'utf8')).join(), /CANARY|ENOTFOUND|ETIMEDOUT/);
});

test('default observation transport refuses Link-only spaces continuation without exposing its contents', t => {
    const f = fixture(t);
    const credential = path.join(f.home, 'synthetic-binding');
    fs.writeFileSync(credential, 'client_id: synthetic\nclient_secret: CANARY');
    const script = `
        import { observationBroker } from ${JSON.stringify(new URL('./observation-broker.mts', import.meta.url).href)};
        import { publishObservations } from ${JSON.stringify(new URL('./observation-publisher.mts', import.meta.url).href)};
        import { receiptStore } from ${JSON.stringify(new URL('./observation-receipt.mts', import.meta.url).href)};
        let calls = 0;
        globalThis.fetch = async url => {
            calls++;
            let json;
            if (url.endsWith('/oauth/token')) json = { access_token: 'CANARY', expires_in: 3600 };
            else if (url.endsWith('/_edge/tenant_info')) json = { cloudId: 'synthetic-cloud' };
            else if (url.includes('/spaces?')) json = { results: [] };
            else throw new Error('CANARY_UNEXPECTED_REQUEST');
            return new Response(JSON.stringify(json), { headers: { Link: '<https://CANARY.invalid/path>; rel="next"' } });
        };
        const broker = observationBroker(${JSON.stringify(f.home)});
        const store = receiptStore(${JSON.stringify(path.join(f.home, 'receipts'))});
        const input = ${JSON.stringify(request())};
        const first = await publishObservations(input, broker, store);
        const second = await publishObservations(input, broker, store);
        process.stdout.write(JSON.stringify({ first, second, calls }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8', env: { KHEREP_ATL_SITE: 'https://synthetic.invalid', KHEREP_ATL_CRED_FILE_CODEX: credential, KHEREP_PROFILE: 'mac' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { first: 'OBS-RESULT: failed space-lookup-unavailable', second: 'OBS-RESULT: failed space-lookup-unavailable', calls: 3 });
    assert.doesNotMatch(result.stdout + result.stderr, /CANARY/);
    assert.doesNotMatch(fs.readdirSync(path.join(f.home, 'receipts')).map(n => fs.readFileSync(path.join(f.home, 'receipts', n), 'utf8')).join(), /CANARY|https:/);
});

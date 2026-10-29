import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { observationRpc } from './observation-stdio.mts';
import { observationBroker } from './observation-broker.mts';
import { publishObservations } from './observation-publisher.mts';
import { receiptStore, receiptKey } from './observation-receipt.mts';
import type { ConfluenceContext } from './confluence-session.mts';
const finding = { title: 'Synthetic journal transport', bodyStorage: '<p>Origin: measured test -> passed</p>', evidence: 'assumed',
    labels: ['type-observation', 'evidence-assumed', 'status-author-model'], placement: { project: 'Kherep', app: '-' } };
const request = () => ({ sessionId: 'synthetic', turnId: 'turn', observations: [structuredClone(finding)] });
function fixture(t: {
    after(fn: () => void): void;
}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-adapter-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'kherep'));
    fs.writeFileSync(path.join(home, 'kherep', 'confluence.json'), JSON.stringify({
        observationPublishingAuthorized: true, spaceKey: 'SYNTHETIC', spaceId: '10', nodes: { Kherep: '20', 'Development/Forge Apps': '20' }
    }));
    const calls: {
        method: string;
        route: string;
        body?: any;
    }[] = [];
    const labels: string[] = [];
    let page: any;
    let peer: any = { id: '30', title: 'Synthetic journal transport baseline', spaceId: '10', parentId: '20', status: 'current', version: { number: 1 }, body: { storage: { value: '<p>Synthetic peer</p>' } } };
    let mode = '';
    let peerReads = 0;
    const context: ConfluenceContext = { env: { KHEREP_ATL_SITE: 'https://synthetic.invalid', KHEREP_ATL_CRED_FILE_CODEX: '/synthetic-credential', KHEREP_PROFILE: 'mac' },
        credEnv: 'KHEREP_ATL_CRED_FILE_CODEX', readFile: async () => 'client_id: synthetic\nclient_secret: CANARY_SECRET', now: Date.now, session: {},
        fetch: async (url, opts) => {
            const route = url.replace(/^https:\/\/api.atlassian.com\/ex\/confluence\/synthetic-cloud/, '');
            const method = opts?.method ?? 'GET';
            const body = opts?.body ? JSON.parse(opts.body.toString()) : undefined;
            calls.push({ method, route, body });
            let json: any = {};
            let status = 200;
            if (url === 'https://auth.atlassian.com/oauth/token')
                json = { access_token: 'CANARY_TOKEN', expires_in: 3600 };
            else if (url.endsWith('/_edge/tenant_info'))
                json = { cloudId: 'synthetic-cloud' };
            else if (route === '/wiki/rest/api/user/current')
                json = mode === 'missing-author' ? {} : { accountId: 'synthetic-service' };
            else if (route.startsWith('/wiki/api/v2/spaces?'))
                json = { results: [{ id: '10', key: 'SYNTHETIC', name: 'Synthetic' }] };
            else if (route.startsWith('/wiki/api/v2/spaces/10/pages?'))
                json = { results: [{ id: '20', title: 'Kherep' }, ...(mode.startsWith('stitch') ? [peer] : []), ...(page ? [page] : [])] };
            else if (route.startsWith('/wiki/rest/api/search?')) {
                json = mode === 'partial-related' ? { results: [{}] } : { results: [] };
                if (mode === 'related-http') {
                    status = 503;
                    json = { message: 'CANARY_PROVIDER' };
                }
            }
            else if (route === '/wiki/api/v2/pages' && method === 'POST') {
                page = { id: '100', status: 'current', title: body.title, parentId: body.parentId, spaceId: body.spaceId,
                    authorId: mode === 'wrong-author' ? 'foreign' : 'synthetic-service', version: { number: 1 }, body: { storage: { value: body.body.value } } };
                json = page;
            }
            else if (route === '/wiki/api/v2/pages/20')
                json = { id: '20', spaceId: '10', title: 'Kherep', status: 'current' };
            else if (route === '/wiki/api/v2/pages/20/children?limit=250')
                json = { results: [{ id: '21', title: 'SyntheticApp' }] };
            else if (route === '/wiki/api/v2/pages/21')
                json = { id: '21', spaceId: '10', title: 'SyntheticApp', status: 'current', parentId: '999' };
            else if (route === '/wiki/api/v2/pages/30' && method === 'PUT') {
                peer = { ...peer, version: body.version, body: { storage: { value: mode === 'stitch-missing-link' ? '<p>missing link</p>' : body.body.value } } };
                json = peer;
            }
            else if (route.startsWith('/wiki/api/v2/pages/30')) {
                if (route.includes('body-format=storage') && ++peerReads === 2 && mode === 'stitch-race')
                    peer = { ...peer, version: { number: 2 }, body: { storage: { value: '<p>HUMAN_EDIT</p>' + peer.body.storage.value } } };
                json = peer;
            }
            else if (route.startsWith('/wiki/api/v2/pages/100/labels?'))
                json = { results: labels.map(name => ({ name })) };
            else if (route === '/wiki/rest/api/content/100/label' && method === 'POST') {
                labels.push(...body.map((v: any) => v.name));
                json = { results: labels.map(name => ({ name })) };
            }
            else if (route.startsWith('/wiki/api/v2/pages/100'))
                json = page;
            else
                throw new Error(`Unexpected synthetic route: ${method} ${route}`);
            return { status, ok: status === 200, json: async () => json, text: async () => JSON.stringify(json) };
        } };
    const broker = observationBroker(home, context, { semantic: async () => mode === 'semantic-error' ? { titles: [], error: 'CANARY_PROVIDER' } : { titles: mode.startsWith('stitch') ? [peer.title] : [] } });
    return { home, calls, broker, store: receiptStore(path.join(home, 'receipts')), mode: (value: string) => { mode = value; } };
}
test('actual broker publishes with mandatory successful-empty related section, runtime labels and author verification', async (t) => {
    const f = fixture(t);
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const create = f.calls.find(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages')!;
    assert.match(create.body.body.value, /No related page found/);
    assert.match(create.body.body.value, /Publication: .*session synthetic; turn turn; runtime-codex-mac/);
    assert.ok(f.calls.some(c => c.route === '/wiki/rest/api/content/100/label'));
    const local = fs.readdirSync(path.join(f.home, 'receipts')).map(n => fs.readFileSync(path.join(f.home, 'receipts', n), 'utf8')).join();
    assert.doesNotMatch(local, /CANARY/);
});
for (const mode of ['missing-author', 'wrong-author', 'partial-related', 'related-http', 'semantic-error'])
    test(`actual broker fails safely for ${mode}`, async (t) => {
        const f = fixture(t);
        f.mode(mode);
        const result = await publishObservations(request(), f.broker, f.store);
        assert.match(result, /^OBS-RESULT: failed /);
        assert.doesNotMatch(result, /CANARY/);
        assert.equal(f.calls.filter(c => c.method === 'POST' && c.route === '/wiki/api/v2/pages').length, mode === 'wrong-author' ? 1 : 0);
    });
test('a listed app that moved to another parent is refused', async (t) => {
    const f = fixture(t);
    const r = request();
    r.observations[0].placement = { project: 'Development/Forge Apps', app: 'SyntheticApp' };
    assert.equal(await publishObservations(r, f.broker, f.store), 'OBS-RESULT: failed placement-unresolved');
});
test('corrupted receipt and symlink receipt never echo a canary', async (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.home, 'receipts'));
    const file = path.join(f.home, 'receipts', `${receiptKey('synthetic', 'turn')}.json`);
    fs.writeFileSync(file, JSON.stringify({ digest: 'a'.repeat(64), ids: [], result: 'CANARY_SECRET' }));
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed receipt-unavailable');
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(f.home, 'kherep', 'confluence.json'), file);
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed receipt-unavailable');
    assert.equal(f.calls.length, 0);
});
test('stdio exposes exactly one tool and invalid mutating messages cause zero publication calls', async () => {
    let calls = 0;
    const publish = async () => { calls++; return 'OBS-RESULT: empty no-admissible-findings'; };
    const list = await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, publish) as any;
    assert.deepEqual(list.result.tools.map((tool: any) => tool.name), ['publish_observations']);
    for (const payload of [{ jsonrpc: '2.0', method: 'tools/call', params: { name: 'publish_observations', arguments: {} } },
        { jsonrpc: '2.0', id: { bad: 'id' }, method: 'tools/call', params: { name: 'publish_observations', arguments: {} } },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish_observations' } },
        { jsonrpc: '2.0', id: 1, method: 'notifications/cancelled', params: {} },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: {} } }])
        await observationRpc(payload, publish);
    assert.equal(calls, 0);
});
test('real stdio empty findings succeed without configuration, credentials or valid profile', t => {
    const f = fixture(t);
    const home = path.join(f.home, 'absent-home');
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'observation-stdio.mts')], { encoding: 'utf8', env: { PATH: process.env.PATH, CODEX_HOME: home, KHEREP_PROFILE: 'unconfigured' },
        input: [undefined, { progressToken: 1, threadId: 'METADATA_CANARY' }].map((_meta, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: 'publish_observations', arguments: { ...request(), observations: [] }, ...(_meta ? { _meta } : {}) } })).join('\n') + '\n' });
    assert.equal(run.status, 0, run.stderr);
    const responses = run.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert.ok(responses.every(response => response.result.content[0].text === 'OBS-RESULT: empty no-admissible-findings'));
    assert.doesNotMatch(run.stdout, /METADATA_CANARY/);
    assert.equal(fs.existsSync(home), false);
});
test('targeted stitching adds and independently verifies the new page link on its related neighbour', async (t) => {
    const f = fixture(t);
    f.mode('stitch-ok');
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const writes = f.calls.filter(call => call.method === 'PUT');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].route, '/wiki/api/v2/pages/30');
    assert.match(writes[0].body.body.value, /pages\/100/);
    assert.ok(f.calls.some(call => call.method === 'GET' && call.route === '/wiki/api/v2/pages/30?body-format=storage'));
});
test('a stitch write whose link cannot be read back fails with the created ID', async (t) => {
    const f = fixture(t);
    f.mode('stitch-missing-link');
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: failed stitch-unverified created=100');
});
test('stitch fresh-version merge preserves an intervening human body edit', async (t) => {
    const f = fixture(t);
    f.mode('stitch-race');
    assert.equal(await publishObservations(request(), f.broker, f.store), 'OBS-RESULT: wrote 1 100');
    const write = f.calls.find(call => call.method === 'PUT')!;
    assert.match(write.body.body.value, /HUMAN_EDIT/);
    assert.match(write.body.body.value, /pages\/100/);
    assert.equal(write.body.version.number, 3);
});
test('native tools/call accepts _meta progressToken:number and threadId without forwarding metadata', async () => {
    const args = { ...request(), observations: [] };
    const received: unknown[] = [];
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'publish_observations', arguments: args,
            _meta: { progressToken: 7, threadId: 'METADATA_CANARY_NATIVE_THREAD' },
        } };
    const response = await observationRpc(call, async (value) => {
        received.push(value);
        return 'OBS-RESULT: empty no-admissible-findings';
    }) as any;
    assert.deepEqual(received, [args]);
    assert.equal(response.result.content[0].text, 'OBS-RESULT: empty no-admissible-findings');
    assert.doesNotMatch(JSON.stringify(response), /METADATA_CANARY|progressToken|threadId/);
});
test('bounded metadata extensions and string progress tokens are accepted without publication identity changes', async () => {
    const args = { ...request(), observations: [] };
    let calls = 0;
    for (const metadata of [{}, { progressToken: 'synthetic-progress' }, { threadId: { extension: true }, otherExtension: ['ignored'] }]) {
        await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
                name: 'publish_observations', arguments: args, _meta: metadata,
            } }, async (value) => { calls++; assert.strictEqual(value, args); return 'OBS-RESULT: empty no-admissible-findings'; });
    }
    assert.equal(calls, 3);
});
test('malformed or oversized metadata and unknown control keys never invoke publication', async () => {
    let calls = 0;
    const publish = async () => { calls++; return 'OBS-RESULT: empty no-admissible-findings'; };
    const params = { name: 'publish_observations', arguments: { ...request(), observations: [] } };
    for (const metadata of [null, [], 'METADATA_CANARY', 7, { progressToken: null }, { progressToken: {} },
        { progressToken: true }, { progressToken: Number.POSITIVE_INFINITY }, { extension: 'x'.repeat(4096) }, { extension: 'é'.repeat(2050) }]) {
        const response = await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { ...params, _meta: metadata } }, publish) as any;
        assert.equal(response.error.code, -32602);
        assert.doesNotMatch(JSON.stringify(response), /METADATA_CANARY|progressToken|threadId/);
    }
    const response = await observationRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            ...params, _meta: { progressToken: 1 }, spaceId: '999',
        } }, publish) as any;
    assert.equal(response.error.code, -32602);
    assert.equal(calls, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from './install.mts';
import { installObservationPublisher, checkObservationPublisher } from './install-observations.mts';
import { fixtureModelOptions } from './lib/model-policy.fixture.mts';
import { renderAgent } from './lib/component-render.mts';
import { renderObservationHook, renderObservationPublisher, observationFiles } from './lib/observation-projection.mts';
import { OBSERVATION_SOURCES, observationSnapshot } from './lib/observation-source.mts';
import { observationSource } from './hooks/hook-integrity-repair.mts';
const REPO = path.resolve(import.meta.dirname, '..');
const predecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex', 'parity', 'observation-predecessor.json'), 'utf8')) as Record<string, string>;
function fixture(t: {
    after(fn: () => void): void;
}, messaging = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    const registry = path.join(root, 'synthetic-registry.json');
    fs.writeFileSync(registry, '{"mcpServers":{}}', { mode: 0o600 });
    const installOptions = { ...fixtureModelOptions(), codexHome: home, workspace, claudeRegistryFile: registry, claudeConfigDir: path.join(root, 'empty-claude'),
        nodePath: process.execPath, skipPluginRegistration: true, resolveRegistryRuntime: () => ({}), log: () => { }, controlPlaneOutbox: path.join(root, 'outbox'), messagingClient: messaging };
    install(installOptions);
    const configFile = path.join(home, 'config.toml');
    let config = fs.readFileSync(configFile, 'utf8');
    const table = renderObservationPublisher({ entry: path.join(workspace, 'tools', 'observation-stdio.mts'), home }, process.execPath);
    config = config.replace(messaging ? `${table}\n\n` : `\n\n${table}`, '');
    assert.doesNotMatch(config, /mcp_servers\.kherep_observations/);
    fs.writeFileSync(configFile, config + '\n[mcp_servers.operator_fixture]\ncommand = "preserve"\n');
    const agentFile = path.join(home, 'agents', 'codex-obs.toml');
    const agent = fs.readFileSync(agentFile, 'utf8');
    const model = JSON.parse(/^model = (.*)$/m.exec(agent)![1]);
    fs.writeFileSync(agentFile, renderAgent('codex-obs', predecessor['codex/agents/codex-obs.md'], { model, reasoning: 'low', sandbox: 'read-only' }));
    for (const [source, target] of [['obs-result-check.mts', 'codex-obs-result-check.mts'], ['obs-candidate-policy.mts', 'obs-candidate-policy.mts'],
        ['confluence-delivery-check.mts', 'codex-confluence-delivery-check.mts'], ['hook-integrity-repair.mts', 'hook-integrity-repair.mts'], ['hook-integrity-sources.mts', 'hook-integrity-sources.mts'],
        ['observation-stop.mts', 'codex-observation-stop.mts'], ['observation-turn-completion.mts', 'codex-observation-turn-completion.mts']]) {
        let sourceText = predecessor[`codex/hooks/${source}`];
        if (source.startsWith('observation-'))
            sourceText = renderObservationHook(sourceText, workspace);
        fs.writeFileSync(path.join(home, 'hooks', 'kherep-maestro', target), sourceText);
    }
    fs.writeFileSync(path.join(home, 'hooks', 'kherep-maestro-context.mts'), predecessor['codex/hooks/kherep-maestro-context.mts']);
    const routing = path.join(home, 'orchestra', 'ROUTING.md');
    const text = fs.readFileSync(routing, 'utf8');
    const section = (s: string) => s.slice(s.indexOf('## Session observations'), s.indexOf('## Linking'));
    fs.writeFileSync(routing, text.replace(section(text), section(predecessor['codex/ROUTING.md'])));
    const agents = path.join(home, 'AGENTS.md');
    const agentText = fs.readFileSync(agents, 'utf8');
    const line = (s: string) => s.split('\n').find(l => l.startsWith('- After a completed turn,'))!;
    fs.writeFileSync(agents, agentText.replace(line(agentText), line(predecessor['codex/AGENTS.maestro.md'])));
    fs.writeFileSync(path.join(home, 'hooks.state.json'), '{"synthetic":"preserve-trust"}');
    return { root, home, workspace, configFile, installOptions };
}
function snapshot(root: string) {
    const out: Record<string, string> = {};
    function walk(dir: string) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'backups')
                continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory())
                walk(p);
            else
                out[path.relative(root, p)] = fs.readFileSync(p).toString('base64');
        }
    }
    walk(root);
    return out;
}
test('scoped upgrade preserves opaque config, trust, pin and shared pointer and measures installed closure', t => {
    const f = fixture(t);
    const before = snapshot(f.root);
    const result = installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    for (const field of ['predecessorRecognized', 'installedHashesMatch', 'unrelatedConfigUnchanged', 'hookStateUnchanged', 'controlPlanePointerUnchanged', 'externalHookPositionsUnchanged', 'integritySourceMatches', 'pinUnchanged'] as const)
        assert.equal(result.receipt[field], true, field);
    assert.equal(result.receipt.sandbox, 'read-only');
    assert.equal(result.receipt.nativeToolDiscovery, 'UNKNOWN');
    const config = fs.readFileSync(f.configFile, 'utf8');
    assert.match(config, /enabled_tools = \["publish_observations"\]/);
    assert.match(config, /env_vars = \["KHEREP_ATL_CRED_FILE_CODEX"/);
    assert.match(config, /operator_fixture/);
    const after = snapshot(f.root);
    for (const name of ['home/hooks.state.json', 'home/orchestra/parity-receipt.json', 'home/orchestra/control-plane-source.json', 'home/hooks/parity/capabilities.json'])
        assert.equal(after[name], before[name], name);
    for (const from of OBSERVATION_SOURCES) {
        assert.equal(observationSnapshot(f.home, from)?.toString(), fs.readFileSync(path.join(REPO, from), 'utf8'));
        assert.equal(observationSource(f.home, from)?.toString(), observationSnapshot(f.home, from)?.toString());
    }
    assert.equal(observationSource(f.home, 'claude/hooks/commit-guard.mts'), null);
    for (const name of observationFiles(REPO))
        assert.equal(fs.readFileSync(path.join(f.workspace, 'tools', name), 'utf8'), fs.readFileSync(path.join(REPO, 'modules', 'atl-jira-brokers', name), 'utf8'));
    const rpc = spawnSync(process.execPath, [path.join(f.workspace, 'tools', 'observation-stdio.mts')], { env: { CODEX_HOME: f.home }, encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'publish_observations', arguments: { sessionId: 'synthetic', turnId: 'turn', observations: [] } } }) + '\n' });
    assert.equal(rpc.status, 0, rpc.stderr);
    assert.match(rpc.stdout, /OBS-RESULT: empty no-admissible-findings/);
    assert.doesNotMatch(rpc.stdout, /CANARY|credential|confluence\.json/);
});
test('transaction rollback restores every original home and workspace file after an injected write failure', t => {
    const f = fixture(t);
    const before = snapshot(f.root);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: n => {
            if (n === 17)
                throw new Error('synthetic failure');
        } }), /rolled-back/);
    assert.deepEqual(snapshot(f.root), before);
});
test('unknown observer drift fails closed before modifying target files', t => {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.home, 'agents', 'codex-obs.toml'), '# unknown drift\n');
    const before = snapshot(f.root);
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /agent-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
test('corrupt observation snapshot never falls back to the older shared source', t => {
    const f = fixture(t);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    fs.appendFileSync(path.join(f.home, 'orchestra', 'observation-source', 'codex', 'hooks', 'obs-result-check.mts'), '// corrupt');
    assert.throws(() => observationSource(f.home, 'codex/hooks/obs-result-check.mts'), /unverified/);
});
for (const removed of ['context', 'result'])
    test(`missing ${removed} wiring fails preflight without writes`, t => {
        const f = fixture(t);
        let config = fs.readFileSync(f.configFile, 'utf8');
        config = config.replace(removed === 'result' ? 'codex-obs-result-check.mts' : 'kherep-maestro-context.mts', 'unrelated-synthetic.mts');
        fs.writeFileSync(f.configFile, config);
        const before = snapshot(f.root);
        assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /wiring-drift/);
        assert.deepEqual(snapshot(f.root), before);
    });
test('equivalent quoted observation table declarations fail before writing', t => {
    const f = fixture(t);
    fs.appendFileSync(f.configFile, '\n[mcp_servers."kherep_observations"]\ncommand = "foreign"\n');
    const before = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /table-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
for (const messaging of [false, true])
    test(`scoped upgrade then full install recognizes canonical table position, messaging=${messaging}`, t => {
        const f = fixture(t, messaging);
        installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
        const before = fs.readFileSync(f.configFile, 'utf8');
        install(f.installOptions);
        assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
    });
test('known b9f5ef72 stdio predecessor upgrades and an idempotent rerun preserves installed bytes', t => {
    const f = fixture(t);
    const relative = 'modules/atl-jira-brokers/observation-stdio.mts';
    const entry = path.join(f.workspace, 'tools', 'observation-stdio.mts');
    fs.writeFileSync(entry, predecessor[relative]);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(fs.readFileSync(entry, 'utf8'), fs.readFileSync(path.join(REPO, relative), 'utf8'));
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
});
test('arbitrary stdio byte drift still refuses before any installation write', t => {
    const f = fixture(t);
    const entry = path.join(f.workspace, 'tools', 'observation-stdio.mts');
    fs.appendFileSync(entry, '\n// UNKNOWN_SYNTHETIC_DRIFT\n');
    const before = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /broker-drift/);
    assert.deepEqual(snapshot(f.root), before);
});
test('rollback restores known stdio predecessor after its replacement was actually written', t => {
    const f = fixture(t);
    const entry = path.join(f.workspace, 'tools', 'observation-stdio.mts');
    const previous = predecessor['modules/atl-jira-brokers/observation-stdio.mts'];
    fs.writeFileSync(entry, previous);
    const before = snapshot(f.root);
    let replaced = false;
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
        if (fs.readFileSync(entry, 'utf8') !== previous) {
            replaced = true;
            throw new Error('synthetic failure after stdio replacement');
        }
    } }), /rolled-back/);
    assert.equal(replaced, true);
    assert.deepEqual(snapshot(f.root), before);
});
test('known 6577d76 policy predecessor upgrades idempotently but arbitrary policy drift refuses', t => {
    const f = fixture(t);
    const relative = 'modules/atl-jira-brokers/observation-policy.mts';
    const entry = path.join(f.workspace, 'tools', 'observation-policy.mts');
    assert.equal(typeof predecessor[relative], 'string');
    fs.writeFileSync(entry, predecessor[relative]);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.equal(fs.readFileSync(entry, 'utf8'), fs.readFileSync(path.join(REPO, relative), 'utf8'));
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
    fs.appendFileSync(entry, '\n// UNKNOWN_SYNTHETIC_POLICY_DRIFT\n');
    const drifted = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /broker-drift/);
    assert.deepEqual(snapshot(f.root), drifted);
});
const lookupPredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-lookup-predecessor.json'), 'utf8')) as Record<string, string>;
const headerPredecessor = JSON.parse(fs.readFileSync(path.join(REPO, 'codex/parity/observation-header-predecessor.json'), 'utf8')) as Record<string, string>;
function installLookupPredecessor(f: ReturnType<typeof fixture>, previous: Record<string, string>) {
    if (previous === lookupPredecessor) fs.rmSync(path.join(f.workspace, 'tools', 'observation-lookup.mts'));
    for (const [relative, bytes] of Object.entries(previous)) {
        const file = relative.startsWith('modules/') ? path.join(f.workspace, 'tools', path.basename(relative))
            : path.join(f.home, 'hooks', 'kherep-maestro', path.basename(relative));
        fs.writeFileSync(file, bytes);
    }
    if (previous === lookupPredecessor) fs.writeFileSync(path.join(f.home, 'hooks', 'kherep-maestro', 'obs-result-policy.mts'), previous['modules/atl-jira-brokers/observation-result.mts']);
}
for (const [version, previous] of [['1532', lookupPredecessor], ['e13', headerPredecessor]] as const) {
test(`exact ${version} predecessor upgrades both receipt policy copies, closure and snapshot`, t => {
    const f = fixture(t);
    installLookupPredecessor(f, previous);
    const before = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    for (const name of ['home/hooks.state.json', 'home/orchestra/parity-receipt.json', 'home/orchestra/control-plane-source.json', 'home/hooks/parity/capabilities.json'])
        assert.equal(snapshot(f.root)[name], before[name], name);
    const helper = 'modules/atl-jira-brokers/observation-lookup.mts';
    assert.equal(observationSnapshot(f.home, helper)?.toString(), fs.readFileSync(path.join(REPO, helper), 'utf8'));
    for (const file of [path.join(f.workspace, 'tools', 'observation-result.mts'), path.join(f.home, 'hooks', 'kherep-maestro', 'obs-result-policy.mts')])
        assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(REPO, 'modules/atl-jira-brokers/observation-result.mts'), 'utf8'));
    const after = snapshot(f.root);
    installObservationPublisher({ codexHome: f.home, workspace: f.workspace });
    assert.deepEqual(snapshot(f.root), after);
    const broker = path.join(f.workspace, 'tools', 'observation-broker.mts');
    fs.appendFileSync(broker, '\n// UNKNOWN_BROKER_DRIFT\n');
    const drifted = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /broker-drift/);
    assert.deepEqual(snapshot(f.root), drifted);
});
test(`${version} predecessor rollback preserves exact files and unknown helper drift refuses preflight`, t => {
    const f = fixture(t);
    installLookupPredecessor(f, previous);
    const before = snapshot(f.root);
    let replaced = false;
    assert.throws(() => installObservationPublisher({ codexHome: f.home, workspace: f.workspace, afterWrite: () => {
        if (fs.existsSync(path.join(f.workspace, 'tools', 'observation-lookup.mts'))
            && fs.readFileSync(path.join(f.workspace, 'tools', 'observation-broker.mts'), 'utf8') !== previous['modules/atl-jira-brokers/observation-broker.mts']) {
            replaced = true;
            throw new Error('synthetic failure after broker replacement');
        }
    } }), /rolled-back/);
    assert.equal(replaced, true);
    assert.deepEqual(snapshot(f.root), before);
    const helper = path.join(f.home, 'hooks', 'kherep-maestro', 'obs-result-policy.mts');
    fs.appendFileSync(helper, '\n// UNKNOWN_CANARY_DRIFT\n');
    const drift = snapshot(f.root);
    assert.throws(() => checkObservationPublisher({ codexHome: f.home, workspace: f.workspace }), /helper-drift/);
    assert.deepEqual(snapshot(f.root), drift);
});
}

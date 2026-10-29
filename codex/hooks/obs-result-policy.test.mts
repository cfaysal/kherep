import test from 'node:test';
import assert from 'node:assert/strict';
import { checkObsResult } from './obs-result-policy.mts';
test('accepts exact bounded publication receipts and preserves partial failure', () => {
    assert.deepEqual(checkObsResult('OBS-RESULT: wrote 2 123,456'), { status: 'wrote', ids: ['123', '456'] });
    assert.deepEqual(checkObsResult('OBS-RESULT: empty no-admissible-findings'), { status: 'empty', ids: [] });
    assert.deepEqual(checkObsResult('OBS-RESULT: failed readback-unverified created=123'), { status: 'failed', ids: ['123'] });
});
test('rejects candidates, fences, duplicates, count mismatch and arbitrary error text', () => {
    for (const text of ['{"observations":[]}', '```\nOBS-RESULT: empty no-admissible-findings\n```',
        'OBS-RESULT: wrote 2 123', 'OBS-RESULT: wrote 2 123,123', 'OBS-RESULT: failed secret/path',
        'OBS-RESULT: empty broker-unavailable', 'OBS-RESULT: wrote 0', 'OBS-RESULT: wrote 1 123\nextra']) {
        assert.ok('problem' in checkObsResult(text), text);
    }
});

for (const code of ['space-lookup-unavailable', 'space-unresolved', 'space-lookup-bindings-missing',
    'space-lookup-network-unavailable', 'space-lookup-timeout']) test(`fixed lookup receipt ${code} stays strict`, () => {
    assert.deepEqual(checkObsResult(`OBS-RESULT: failed ${code}`), { status: 'failed', ids: [] });
    assert.deepEqual(checkObsResult(`OBS-RESULT: failed ${code} created=123`), { status: 'failed', ids: ['123'] });
    assert.ok('problem' in checkObsResult(`OBS-RESULT: failed ${code}-CANARY`));
});

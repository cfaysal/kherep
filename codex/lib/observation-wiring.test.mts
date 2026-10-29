import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { render, command, hookGroup } from './parity-config.mts';
import { observationWiring } from './observation-wiring.mts';

const home = path.resolve('/synthetic/codex'), workspace = path.resolve('/synthetic/workspace');
const node = process.execPath, contextHook = path.join(home, 'hooks', 'kherep-maestro-context.mts');
const options = { contextHook, hookDir: path.join(home, 'hooks', 'kherep-maestro'), node, mcpServers: [] };
const frame = (body: string) => `# >>> Kherep Codex Maestro >>>\n${body}\n# <<< Kherep Codex Maestro <<<\n`;
for (const windowsHookCommands of [true, false]) test(`only exact old or workspace-bound context pairs qualify, Windows commands=${windowsHookCommands}`, () => {
  const unbound = frame(render({ ...options, windowsHookCommands }));
  const bound = frame(render({ ...options, contextWorkspace: workspace, windowsHookCommands }));
  const wiring = observationWiring(unbound, home, node, workspace);
  assert.ok(Array.isArray(wiring.contextEdits), "validated context edits returned");
  assert.equal(wiring.contextEdits.length, windowsHookCommands ? 4 : 2);
  let edited = unbound;
  for (const edit of [...wiring.contextEdits].reverse()) {
    assert.equal(unbound.slice(edit.start, edit.end), edit.before);
    assert.ok(edit.tableSpan.start <= edit.start && edit.tableSpan.end >= edit.end);
    edited = edited.slice(0, edit.start) + edit.after + edited.slice(edit.end);
  }
  assert.equal(edited, bound);
  assert.deepEqual(observationWiring(bound, home, node, workspace).contextEdits, []);
  const foreign = frame(render({ ...options, contextWorkspace: path.resolve('/foreign'), windowsHookCommands }));
  const mixed = unbound.replace(command(node, contextHook).replaceAll('"', '\\"'), command(node, contextHook, '--workspace-b64', Buffer.from(workspace).toString('base64url')).replaceAll('"', '\\"'));
  const duplicate = unbound + hookGroup('SessionStart', '', [{ command: command(node, contextHook), status: 'Loading Kherep Maestro' }]);
  for (const drift of [foreign, mixed, duplicate, unbound.replace('Loading Kherep Maestro', 'drift')])
    assert.throws(() => observationWiring(drift, home, node, workspace), /context-wiring-drift/);
});

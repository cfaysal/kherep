/** Validate the observation-owned native hook entries without rewriting other groups. */
import path from 'node:path';
import { command, hookGroup } from './parity-config.mts';
import { managedNodePaths } from './node-path.mts';
import { scanDocument, structure, type ScannedTable } from './toml-block-structure.mts';
const START = '# >>> Kherep Codex Maestro >>>', END = '# <<< Kherep Codex Maestro <<<';
export function observationWiring(config: string, home: string, node: string): {
    messagingStart?: number;
    node: string;
} {
    const doc = scanDocument(config);
    structure(doc, new Set());
    const start = config.indexOf(START), end = config.indexOf(END);
    const inside = (table: ScannedTable) => table.span.start > start && table.span.start < end;
    const nodes = [node, ...managedNodePaths(config, START, END, node)];
    const hookDir = path.join(home, 'hooks', 'kherep-maestro');
    const context = path.join(home, 'hooks', 'kherep-maestro-context.mts');
    let selectedNode: string | undefined;
    const hooks = (event: string) => doc.tables.filter(t => t.array && t.path.join('.') === `hooks.${event}.hooks`);
    for (const event of ['UserPromptSubmit', 'SessionStart']) {
        const entries = hooks(event).filter(t => t.payload.some(line => line.includes('kherep-maestro-context.mts')));
        if (entries.length !== 1 || !inside(entries[0]))
            throw new Error('observation-context-wiring-drift');
        const matching = nodes.find(executable => [true,false].some(windows=>{
            const cmd=command(executable,context);
            const lines=scanDocument(hookGroup(event,'',[{command:cmd,...(windows?{commandWindows:`& ${cmd}`}:{ }),
                status:event==='SessionStart'?'Loading Kherep Maestro':'Applying evidence-first routing'}])).tables[1].payload;
            return JSON.stringify(lines)===JSON.stringify(entries[0].payload);
        }));
        if(!matching || selectedNode && selectedNode!==matching)throw new Error('observation-context-wiring-drift');
        selectedNode=matching;
    }
    const resultGroups = doc.tables.filter(t => t.array && t.path.join('.') === 'hooks.SubagentStop'
        && t.payload.some(line => /^matcher\s*=\s*["']codex-obs["']\s*$/.test(line)));
    if (resultGroups.length !== 1 || !inside(resultGroups[0]))
        throw new Error('observation-result-wiring-drift');
    const group = resultGroups[0];
    const next = doc.tables.find(t => t.span.start > group.span.start && !(t.path[0] === 'hooks' && t.path[1] === 'SubagentStop' && t.path.length > 2));
    const fragment = config.slice(group.span.start, Math.min(next?.span.start ?? end, end)).trim();
    const executable = selectedNode!;
    const variants = [true, false].map(windows => {
        const cmd = command(executable, path.join(hookDir, 'codex-obs-result-check.mts'));
        return hookGroup('SubagentStop', 'codex-obs', [{ command: cmd, ...(windows ? { commandWindows: `& ${cmd}` } : {}) }]);
    });
    if (!variants.includes(fragment))
        throw new Error('observation-result-wiring-drift');
    const tables = doc.tables.filter(t => t.path[0] === 'mcp_servers' && t.path[1] === 'kherep_observations');
    if (tables.some(t => t.path.length !== 2 || t.array || t.payload[0] !== '[mcp_servers.kherep_observations]') || tables.length > 1)
        throw new Error('observation-tool-table-drift');
    const messaging = doc.tables.filter(t => inside(t) && t.path.join('.') === 'mcp_servers.kherep_messaging');
    if (messaging.length > 1)
        throw new Error('observation-tool-table-drift');
    return { messagingStart: messaging[0]?.span.start, node: selectedNode! };
}

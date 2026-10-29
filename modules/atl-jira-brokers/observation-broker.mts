/** Narrow publisher adapter. The only credential binding is the Codex broker's. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSession, currentUser, type ConfluenceContext } from './confluence-session.mts';
import { createPage, findSpace, getPage, listChildren, listLabels, updatePage } from './confluence-content.mts';
import { ensureRuntimeLabel } from './confluence-label-cli.mts';
import { runtimeLabel } from './confluence-runtime-label.mts';
import { reportRelated, reportStitch, relatedSection, withRelated, existingRelated } from './confluence-neighbours.mts';
import { outgoingIds, requireResolvableAnchors } from './confluence-related.mts';
import { semanticProposals } from './confluence-semantic.mts';
import { SCOPES, v2, type ConfluenceSession } from './confluence-contract.mts';
import type { ObservationBroker, Authority } from './observation-publisher.mts';
import { ObservationLookupError } from './observation-lookup.mts';
import { pageId } from './observation-policy.mts';
const CREDENTIAL = 'KHEREP_ATL_CRED_FILE_CODEX';
// A broken collection must not become an empty successful search or child list.
export function checkedSession(session: ConfluenceSession): ConfluenceSession {
    return { async request(spec) {
            const response = await session.request(spec);
            if (spec.method === 'GET' && /\/(?:pages|labels|children)(?:\?|$)|\/search\?/.test(spec.path)) {
                const json = response.json as {
                    results?: unknown;
                    _links?: {
                        next?: unknown;
                    };
                } | null;
                if (!Array.isArray(json?.results) || json.results.some(row => !row || typeof row !== 'object'))
                    throw new Error('collection-unavailable');
                const next = json._links?.next;
                if (next !== undefined && (typeof next !== 'string' || (next && !/^\/(?:wiki\/)?api\//.test(next))))
                    throw new Error('collection-unavailable');
            }
            if (spec.method === 'GET' && /^\/wiki\/api\/v2\/spaces\?/.test(spec.path)) {
                const json = response.json as { results?: unknown; _links?: { next?: unknown } } | null;
                const wanted = new URLSearchParams(spec.path.split('?')[1]).get('keys');
                if (!Array.isArray(json?.results) || json.results.length > 1 || json.results.some(row =>
                    !row || typeof row !== 'object' || Array.isArray(row) || !pageId(row.id)
                    || typeof row.key !== 'string' || !/^[A-Za-z0-9_~]+$/.test(row.key)
                    || row.key.toUpperCase() !== wanted?.toUpperCase() || typeof row.name !== 'string' || !row.name.trim())
                    || (json._links !== undefined && (!json._links || typeof json._links !== 'object' || Array.isArray(json._links)))
                    || (json._links?.next !== undefined && json._links.next !== ''))
                    throw new Error('collection-unavailable');
            }
            return response;
        } };
}
export function observationBroker(home: string, context?: ConfluenceContext, options: {
    semantic?: typeof semanticProposals;
} = {}): ObservationBroker {
    const ctx = context ?? { env: process.env, credEnv: CREDENTIAL, readFile: fs.readFile, fetch: boundedFetch, now: Date.now, session: {} };
    if (ctx.credEnv !== CREDENTIAL)
        throw new Error('broker-unavailable');
    const session = checkedSession(createSession(ctx));
    const semantic = (title: string) => (options.semantic ?? semanticProposals)(title, 25, { env: ctx.env });
    let authorityText = '';
    const assertAuthorityUnchanged = async () => {
        if (await fs.readFile(path.join(home, 'kherep', 'confluence.json'), 'utf8') !== authorityText)
            throw new Error('authority-unavailable');
    };
    const deps = (spaceId: string, spaceKey: string, errors: string[], log: (line: string) => void, createdId?: string) => ({ session, spaceId, spaceKey, semantic,
        log, logError: (line: string) => errors.push(line), update: async (id: string, value: string, message: string) => {
            await assertAuthorityUnchanged();
            if (!createdId || !existingRelated(value).includes(createdId))
                throw new Error('stitch-unverified');
            // Bind content and version to the same fresh read. Merge only the
            // owned Related block; reportStitch's earlier ordinary body is stale.
            const { json } = await session.request({ method: 'GET', path: v2(`/pages/${id}?body-format=storage`), scope: SCOPES.get });
            const current = json as {
                id?: string;
                spaceId?: string;
                status?: string;
                version?: {
                    number?: number;
                };
                body?: {
                    storage?: {
                        value?: string;
                    };
                };
            };
            const storage = current.body?.storage?.value, version = current.version?.number;
            if (current.id !== id || current.spaceId !== spaceId || current.status !== 'current' || typeof storage !== 'string'
                || !Number.isSafeInteger(version) || !version || version < 1)
                throw new Error('stitch-unverified');
            const merged = [...new Set([...existingRelated(storage), createdId])].filter(target => target !== id);
            if (merged.length > 100)
                throw new Error('stitch-unverified');
            const pages = await Promise.all(merged.map(target => getPage(session, target)));
            if (pages.some(page => page.spaceId !== spaceId || page.status !== 'current'))
                throw new Error('stitch-unverified');
            const next = withRelated(storage, relatedSection(spaceKey, pages));
            await requireResolvableAnchors(session, next, spaceId);
            await updatePage(session, { id, value: next, representation: 'storage', message, expectedVersion: version });
        } });
    return {
        runtimeLabel: runtimeLabel(CREDENTIAL, ctx.env),
        async authority() {
            authorityText = await fs.readFile(path.join(home, 'kherep', 'confluence.json'), 'utf8');
            if (authorityText.length > 32000)
                throw new Error('authority-unavailable');
            return JSON.parse(authorityText) as Authority;
        },
        async space(key) {
            if (!ctx.env.KHEREP_ATL_SITE?.trim() || !ctx.env[CREDENTIAL]?.trim())
                throw new ObservationLookupError('space-lookup-bindings-missing');
            return findSpace(session, key);
        },
        identity: async () => (await currentUser(session))?.accountId ?? null,
        async parent(spaceId, nodeId, app) {
            const shelf = await getPage(session, nodeId);
            if (shelf.id !== nodeId || shelf.spaceId !== spaceId || shelf.status !== 'current')
                throw new Error('placement-unresolved');
            if (!app)
                return nodeId;
            const hits = (await listChildren(session, nodeId)).filter(child => child.title === app);
            if (hits.length !== 1 || !pageId(hits[0].id))
                throw new Error('placement-unresolved');
            const child = await getPage(session, hits[0].id);
            const { json } = await session.request({ method: 'GET', path: v2(`/pages/${child.id}`), scope: SCOPES.get });
            if (child.spaceId !== spaceId || child.status !== 'current' || (json as {
                parentId?: unknown;
            })?.parentId !== nodeId)
                throw new Error('placement-unresolved');
            return child.id;
        },
        async related(spaceId, key, finding, parent) {
            const rows: {
                id: string;
                title: string;
            }[] = [];
            const errors: string[] = [];
            const result = await reportRelated(deps(spaceId, key, errors, line => {
                if (line.startsWith('related\t')) {
                    const [, id, ...title] = line.split('\t');
                    if (!pageId(id))
                        throw new Error();
                    rows.push({ id, title: title.join('\t') });
                }
            }), { title: finding.title, parentId: parent });
            if (result !== 0 || errors.length)
                throw new Error('related-unavailable');
            // Confluence storage encodes literal > in prose. Preserve tags and
            // existing entities; the publisher still requires exact readback.
            const prose = finding.bodyStorage.replace(/(<[^>]*>)|>/g, (_match, tag: string | undefined) => tag ?? '&gt;');
            return withRelated(prose, rows.length ? relatedSection(key, rows) : '<h2>Related pages</h2><p>No related page found in a complete lookup.</p>');
        },
        async create(spaceId, finding, parent, body) {
            await assertAuthorityUnchanged();
            await requireResolvableAnchors(session, body, spaceId);
            return (await createPage(session, { spaceId, title: finding.title, parentId: parent, representation: 'storage', value: body })).id;
        },
        async labels(id, labels) { await assertAuthorityUnchanged(); await ensureRuntimeLabel(session, id, labels, CREDENTIAL, ctx.env); },
        async read(id) {
            const { json } = await session.request({ method: 'GET', path: v2(`/pages/${id}?body-format=storage`), scope: SCOPES.get });
            const raw = json as {
                id: string;
                title: string;
                spaceId: string;
                parentId: string;
                authorId: string;
                body?: {
                    storage?: {
                        value?: string;
                    };
                };
            };
            return { id: raw.id, title: raw.title, spaceId: raw.spaceId, parentId: raw.parentId, authorId: raw.authorId,
                body: raw.body?.storage?.value ?? '', labels: await listLabels(session, id) };
        },
        async stitch(id, spaceId, key) {
            const errors: string[] = [];
            const links: {
                from: string;
                to: string;
            }[] = [];
            const result = await reportStitch(deps(spaceId, key, errors, line => {
                if (line.startsWith('link\t')) {
                    const [, from, to] = line.split('\t');
                    if (!pageId(from) || to !== id)
                        throw new Error();
                    links.push({ from, to });
                }
            }, id), { only: id });
            if (result !== 0 || errors.length)
                throw new Error('stitch-unverified');
            for (const link of links) {
                const page = await getPage(session, link.from);
                const { json } = await session.request({ method: 'GET', path: v2(`/pages/${link.from}?body-format=storage`), scope: SCOPES.get });
                const body = (json as {
                    body?: {
                        storage?: {
                            value?: unknown;
                        };
                    };
                })?.body?.storage?.value;
                if (page.spaceId !== spaceId || typeof body !== 'string' || !outgoingIds(body).includes(id))
                    throw new Error('stitch-unverified');
            }
        },
    };
}
// Bound provider bodies and timeouts without returning raw provider failures.
const boundedFetch: ConfluenceContext['fetch'] = async (url, options) => {
    const signal = AbortSignal.timeout(30000);
    let response: Response;
    try { response = await fetch(url, { ...options, redirect: 'error', signal }); }
    catch (error) {
        if (signal.aborted) throw new ObservationLookupError('space-lookup-timeout');
        throw error;
    }
    // A spaces result with any Link header is conservatively incomplete.
    if (/^\/ex\/confluence\/[^/]+\/wiki\/api\/v2\/spaces$/.test(new URL(url).pathname) && response.headers.get('link')?.trim())
        throw new Error('collection-unavailable');
    let text: string | undefined;
    const read = async () => {
        if (text !== undefined)
            return text;
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader)
            while (true) {
                const part = await reader.read().catch(error => {
                    if (signal.aborted) throw new ObservationLookupError('space-lookup-timeout');
                    throw error;
                });
                if (part.done)
                    break;
                size += part.value.length;
                if (size > 4 * 1024 * 1024) {
                    await reader.cancel();
                    throw new Error('broker-unavailable');
                }
                chunks.push(part.value);
            }
        text = Buffer.concat(chunks).toString('utf8');
        return text;
    };
    return { status: response.status, ok: response.ok, text: read, json: async () => JSON.parse(await read()) };
};

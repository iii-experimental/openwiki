// iii-state backed store for openwiki. Wiki content (metadata, pages, status,
// outline, logs) lives in iii-state under `openwiki:*` scopes; cloned repos are
// ephemeral working dirs on the local filesystem (a git clone cannot live in a
// key/value store).
import fs from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = process.env.OPENWIKI_DATA || '/tmp/openwiki-data';
export const repoDir = (id) => path.join(REPO_ROOT, 'repos', id);

let client = null;
/** Wire the iii client used for all state calls. Call once at startup. */
export function setClient(c) { client = c; }

const S_WIKIS = 'openwiki:wikis';
const S_STATUS = 'openwiki:status';
const S_OUTLINE = 'openwiki:outline';
const S_LOG = 'openwiki:log';
const pagesScope = (id) => `openwiki:pages:${id}`;

async function sget(scope, key) {
  const res = await client.trigger({ function_id: 'state::get', payload: { scope, key } });
  return res == null ? null : res;
}
async function sset(scope, key, value) {
  await client.trigger({ function_id: 'state::set', payload: { scope, key, value } });
}
async function slist(scope) {
  const res = await client.trigger({ function_id: 'state::list', payload: { scope } });
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.values)) return res.values;
  return [];
}
async function sdel(scope, key) {
  try { await client.trigger({ function_id: 'state::delete', payload: { scope, key } }); }
  catch { /* best effort */ }
}

/** Ensure the local working area for repo clones exists (fs, ephemeral). */
export async function ensureRoot() {
  await fs.mkdir(path.join(REPO_ROOT, 'repos'), { recursive: true });
  await fs.mkdir(path.join(REPO_ROOT, 'tmp'), { recursive: true });
}

export async function saveWiki(id, meta) { await sset(S_WIKIS, id, meta); }
export async function getWiki(id) { return sget(S_WIKIS, id); }
export async function listWikis() {
  const all = await slist(S_WIKIS);
  return all.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

export async function savePage(wikiId, slug, markdown, meta) {
  await sset(pagesScope(wikiId), slug, { slug, markdown, meta });
}
export async function getPage(wikiId, slug) {
  const p = await sget(pagesScope(wikiId), slug);
  return p ? { markdown: p.markdown, meta: p.meta } : null;
}
export async function listPages(wikiId) {
  const all = await slist(pagesScope(wikiId));
  return all.map((p) => ({ slug: p.slug, meta: p.meta }));
}
export async function deletePage(wikiId, slug) { await sdel(pagesScope(wikiId), slug); }

export async function saveOutline(wikiId, outline) { await sset(S_OUTLINE, wikiId, outline); }
export async function getOutline(wikiId) { return sget(S_OUTLINE, wikiId); }

export async function updateStatus(wikiId, status) {
  await sset(S_STATUS, wikiId, { ...status, updated_at: status.updated_at || new Date().toISOString() });
}
export async function getStatus(wikiId) { return sget(S_STATUS, wikiId); }

export async function appendLog(wikiId, line) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prev = (await sget(S_LOG, wikiId)) || [];
  prev.push(`${ts}  ${line}`);
  if (prev.length > 500) prev.splice(0, prev.length - 500);
  await sset(S_LOG, wikiId, prev);
}
export async function getLog(wikiId) { return (await sget(S_LOG, wikiId)) || []; }

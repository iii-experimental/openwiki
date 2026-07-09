// OpenWiki iii worker — source-grounded wiki maintainer.
// Thin orchestrator: owns the wiki schema, page store, file->page map, and the
// UI/API surface. Git runs through the shell worker (git.mjs); persistence
// through iii-state (store.mjs); LLM through llm-router (generate.mjs). See
// ~/specs-backup/openwiki-iii-spec.md.
import { registerWorker } from 'iii-sdk';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { cloneRepo, gitDiff, gitPull } from './lib/git.mjs';
import { inventoryRepo, readSourceFile } from './lib/inventory.mjs';
import * as store from './lib/store.mjs';
import { searchPages } from './lib/search.mjs';
import { planWiki } from './lib/generate.mjs';
import { generatePageAny, planViaHarness } from './lib/harness.mjs';
import { resolveModel, listModels } from './lib/model.mjs';
import { srcRead, srcList, srcGrep, invalidateInventory, getReadStats, resetReadStats } from './lib/src.mjs';
import { lintWiki } from './lib/lint.mjs';
import { askWiki } from './lib/ask.mjs';
import { makeDiagram } from './lib/diagram.mjs';
import { exportAgentsMd } from './lib/agents_md.mjs';
import { normalizePlan } from './lib/nav.mjs';
import { fetchDocsIndex, docsHint as buildDocsHint } from './lib/docs_oracle.mjs';
import { pushProgress, onProgress } from './lib/progress.mjs';
import { INDEX_HTML } from './lib/ui.mjs';
import * as configuration from './lib/configuration.mjs';
import * as S from './lib/schemas.mjs';

const III_URL = process.env.III_URL || process.env.III_ENGINE_URL || 'ws://localhost:49134';
let cfg = configuration.defaults();

const worker = registerWorker(III_URL, {
  workerName: 'openwiki',
  workerDescription:
    'Source-grounded wiki maintainer: generates and maintains a categorized, interlinked markdown wiki for any git repository, and serves a browser UI + HTTP API to browse and search it.',
});

store.setWorker(worker);
store.ensureRoot().catch((e) => console.error('[openwiki] ensureRoot', e));

const now = () => new Date().toISOString();
const inflight = new Set();

// Persist status AND push it to any live SSE subscriber for this wiki.
async function setStatus(wikiId, status) {
  await store.updateStatus(wikiId, status);
  pushProgress(wikiId, { kind: 'status', phase: status.phase, progress: status.progress, message: status.message, error: status.error });
}

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

async function readRepoReadme(dir) {
  for (const name of ['README.md', 'README.mdx', 'readme.md', 'Readme.md']) {
    try { return await fs.readFile(dir + '/' + name, 'utf8'); } catch { /* try next */ }
  }
  return '';
}

function inferRepoName(url) {
  return String(url || '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split(/[\/:]/)
    .filter(Boolean)
    .slice(-2)
    .join('/') || url;
}

// Write a set of outline items to pages. Shared by full generation and
// incremental refresh; `fullOutline` supplies sibling links for cross-refs so a
// partial refresh still links to the whole wiki.
async function writePages(wikiId, { dir, itemsToWrite, fullOutline, categories, repoName, repoUrl, model, commit, parentSessionId, progressBase = 0.3, progressSpan = 0.65 }) {
  const allSlugs = fullOutline.map((o) => o.slug);
  const allTitles = fullOutline.map((o) => o.title);
  const total = itemsToWrite.length || 1;
  const resolved = await resolveModel(worker, model);
  const step = Math.max(1, Number(cfg.max_parallel) || 1);
  let done = 0;

  for (let i = 0; i < itemsToWrite.length; i += step) {
    const batch = itemsToWrite.slice(i, i + step);
    await Promise.all(batch.map(async (item) => {
      const reads = [];
      for (const p of item.source_paths || []) {
        try {
          reads.push(await readSourceFile(dir, p, 40_000));
        } catch (e) {
          reads.push({ path: p, content: `(unreadable: ${e.message})`, truncated: false });
        }
      }
      try {
        const { markdown, frontmatter } = await generatePageAny(worker, {
          wikiId, outlineItem: item, sourceReads: reads, allSlugs, allTitles, categories,
          repoName, repoUrl, commit, model: resolved.model || model, provider: resolved.provider,
          useHarness: resolved.resolved, parentSessionId,
          onFallback: (err) => store.appendLog(wikiId, `harness fallback for ${item.slug}: ${err?.message || err}`),
        });
        await store.savePage(wikiId, item.slug, markdown, frontmatter);
        await store.appendLog(wikiId, `Wrote ${item.slug} — ${item.title}`);
        pushProgress(wikiId, { kind: 'page', slug: item.slug, title: item.title });
      } catch (e) {
        await store.appendLog(wikiId, `FAILED ${item.slug}: ${e?.message || e}`);
        await store.savePage(
          wikiId, item.slug,
          `# ${item.title}\n\n> Generation failed: ${e?.message || e}\n\n_Source paths_: ${(item.source_paths || []).map((p) => '`' + p + '`').join(', ') || '(none)'}\n`,
          { title: item.title, slug: item.slug, category: item.category, source_paths: item.source_paths || [], last_updated: now(), confidence: 'low', status: 'needs-review' },
        );
      }
      done += 1;
      await setStatus(wikiId, {
        phase: 'generating', progress: progressBase + progressSpan * (done / total),
        message: `Generated ${done}/${total} pages`, pages_done: done, pages_total: total, updated_at: now(),
      });
    }));
  }
}

// ---------- Full generation ----------

async function runGeneration(wikiId, { repoUrl, model, ref, steer }) {
  inflight.add(wikiId);
  resetReadStats(wikiId);
  const started = now();
  try {
    await store.appendLog(wikiId, `Starting generation for ${repoUrl} (model=${model})`);
    await setStatus(wikiId, { phase: 'cloning', progress: 0.05, message: 'Cloning repository', updated_at: now() });

    const dir = store.repoDir(wikiId);
    await fs.rm(dir, { recursive: true, force: true });
    const { commit, name } = await cloneRepo(worker, repoUrl, dir, ref);
    invalidateInventory(wikiId);

    await setStatus(wikiId, { phase: 'inventorying', progress: 0.15, message: 'Reading source files', updated_at: now() });
    const inventory = await inventoryRepo(dir);
    await store.appendLog(wikiId, `Inventoried ${inventory.length} files.`);

    await setStatus(wikiId, { phase: 'planning', progress: 0.25, message: 'Exploring repo and planning structure', updated_at: now() });
    let dHint = '';
    try {
      const readme = await readRepoReadme(dir);
      const docsIndex = await fetchDocsIndex(worker, { repoUrl, readme, repoDir: dir });
      if (docsIndex) { dHint = buildDocsHint(docsIndex); await store.appendLog(wikiId, `docs oracle: ${docsIndex.linkCount} topics (${docsIndex.source})`); }
    } catch { /* oracle is optional */ }
    let planned = null;
    try {
      planned = await planViaHarness(worker, { wikiId, repoName: name, repoUrl, model, docsHint: dHint });
    } catch (e) {
      await store.appendLog(wikiId, `harness plan fallback (${e?.message || e})`);
    }
    if (!planned) planned = await planWiki(worker, { inventory, repoName: name, repoUrl, model, repoDir: dir, steer });
    const parentSessionId = planned && planned.sessionId;
    const norm = normalizePlan(planned);
    const summary = norm.summary;
    const navigation = norm.navigation;
    // Validate cited paths against the real inventory.
    const invPaths = new Set(inventory.map((e) => e.relPath));
    const outline = norm.outline.map((item) => ({
      ...item,
      source_paths: (item.source_paths || []).filter((p) => invPaths.has(p)),
    }));
    const categories = navigation.map((l1) => ({ id: l1.title, title: l1.title }));
    await store.saveOutline(wikiId, { navigation, categories, items: outline });

    const meta0 = {
      id: wikiId, repo_url: repoUrl, repo_name: name, ref: ref || '', commit,
      created_at: started, updated_at: now(),
      page_count: outline.length, category_count: categories.length,
      categories, navigation, summary, model, steer: steer || undefined, generating: true,
    };
    await store.saveWiki(wikiId, meta0);
    await store.appendLog(wikiId, `Planned ${outline.length} pages across ${categories.length} categories.`);

    await writePages(wikiId, { dir, itemsToWrite: outline, fullOutline: outline, categories, repoName: name, repoUrl, model, commit, parentSessionId });

    const content_hash = await store.computeContentHash(wikiId);
    await store.saveWiki(wikiId, { ...meta0, updated_at: now(), content_hash, generating: false });
    await setStatus(wikiId, { phase: 'ready', progress: 1, message: 'Wiki ready', updated_at: now() });
    await store.appendLog(wikiId, 'Wiki ready.');
    try {
      const { issues } = await lintWiki(wikiId);
      if (issues.length) await store.appendLog(wikiId, `lint: ${issues.length} issue(s) flagged`);
    } catch (e) { await store.appendLog(wikiId, `lint skipped: ${e?.message || e}`); }
  } catch (e) {
    console.error('[openwiki] generation error', e);
    await store.appendLog(wikiId, `ERROR: ${e?.stack || e?.message || e}`);
    await setStatus(wikiId, { phase: 'error', progress: 0, error: String(e?.message || e), updated_at: now() });
  } finally {
    inflight.delete(wikiId);
  }
}

async function startWiki(repoUrl, model, ref, steer) {
  if (!repoUrl || typeof repoUrl !== 'string') throw err('openwiki/repo_not_found', 'repo_url required');
  const wikiId = crypto.randomUUID();
  const chosen = model || cfg.model;
  await store.saveWiki(wikiId, {
    id: wikiId, repo_url: repoUrl, repo_name: inferRepoName(repoUrl), ref: ref || '', commit: '',
    created_at: now(), updated_at: now(), page_count: 0, category_count: 0,
    categories: [], summary: '', model: chosen, steer: steer || undefined, generating: true,
  });
  await setStatus(wikiId, { phase: 'queued', progress: 0, message: 'Queued', updated_at: now() });
  setImmediate(() => { runGeneration(wikiId, { repoUrl, model: chosen, ref, steer }).catch((e) => console.error(e)); });
  return { wiki_id: wikiId, status: 'queued' };
}

// ---------- Incremental refresh ----------

// Regenerate only the affected pages, then gate on a content hash so an
// identical result does not churn the wiki's updated_at (langchain-ai/openwiki
// anti-churn: git-head gate + content-hash gate).
async function runRefresh(wikiId, { dir, itemsToWrite, outline, meta, newCommit, prevHash }) {
  inflight.add(wikiId);
  try {
    await setStatus(wikiId, { phase: 'generating', progress: 0.3, message: `Refreshing ${itemsToWrite.length} pages`, updated_at: now() });
    await writePages(wikiId, {
      dir, itemsToWrite, fullOutline: outline.items || [],
      categories: outline.categories || meta.categories || [],
      repoName: meta.repo_name, repoUrl: meta.repo_url, model: meta.model || cfg.model, commit: newCommit,
    });
    const content_hash = await store.computeContentHash(wikiId);
    const churned = content_hash !== prevHash;
    await store.saveWiki(wikiId, { ...meta, commit: newCommit, content_hash, page_count: (outline.items || []).length, updated_at: now() });
    await setStatus(wikiId, { phase: 'ready', progress: 1, message: churned ? 'Refresh complete' : 'No content change', updated_at: now() });
    await store.appendLog(wikiId, `refresh: regenerated ${itemsToWrite.length} pages (content ${churned ? 'changed' : 'unchanged'})`);
  } catch (e) {
    await store.appendLog(wikiId, `refresh error: ${e?.message || e}`);
    await setStatus(wikiId, { phase: 'error', progress: 0, error: String(e?.message || e), updated_at: now() });
  } finally {
    inflight.delete(wikiId);
  }
}

async function refreshWiki(wikiId) {
  const meta = await store.getWiki(wikiId);
  if (!meta) throw err('openwiki/wiki_not_found', 'wiki not found');

  const dir = store.repoDir(wikiId);
  const prevCommit = meta.commit || '';
  let newCommit = null;

  // Ensure a clone exists and is current.
  const stat = await fs.stat(dir).catch(() => null);
  if (stat && stat.isDirectory()) {
    newCommit = await gitPull(worker, dir);
    if (!newCommit) {
      await fs.rm(dir, { recursive: true, force: true });
      ({ commit: newCommit } = await cloneRepo(worker, meta.repo_url, dir, meta.ref));
    }
  } else {
    ({ commit: newCommit } = await cloneRepo(worker, meta.repo_url, dir, meta.ref));
  }
  invalidateInventory(wikiId);

  // Anti-churn: HEAD unchanged -> nothing to do.
  if (prevCommit && newCommit && prevCommit === newCommit) {
    await store.appendLog(wikiId, 'refresh: HEAD unchanged');
    return { wiki_id: wikiId, refresh: 'up_to_date', changed: [], pages_affected: [] };
  }

  // No prior commit / no pages -> full build.
  const priorPages = await store.listPages(wikiId);
  if (!prevCommit || priorPages.length === 0) {
    setImmediate(() => { runGeneration(wikiId, { repoUrl: meta.repo_url, model: meta.model || cfg.model, ref: meta.ref, steer: meta.steer }).catch((e) => console.error(e)); });
    return { wiki_id: wikiId, refresh: 'regenerating', changed: [], pages_affected: [] };
  }

  // Diff prev..new, map changed files to affected pages, regenerate only those.
  let changed = [];
  try { changed = await gitDiff(worker, dir, prevCommit, newCommit); }
  catch (e) { await store.appendLog(wikiId, `refresh diff failed: ${e?.message || e}`); }
  const changedPaths = changed.map((c) => c.path);
  const affected = await store.pagesForPaths(wikiId, changedPaths);
  await store.appendLog(wikiId, `refresh: ${changed.length} changed paths -> ${affected.length} affected pages`);

  if (affected.length === 0) {
    await store.saveWiki(wikiId, { ...meta, commit: newCommit, updated_at: now() });
    return { wiki_id: wikiId, refresh: 'up_to_date', changed, pages_affected: [] };
  }

  const outline = (await store.getOutline(wikiId)) || { items: [], categories: meta.categories || [] };
  const itemsToWrite = (outline.items || []).filter((o) => affected.includes(o.slug));
  const prevHash = meta.content_hash || (await store.computeContentHash(wikiId));
  setImmediate(() => { runRefresh(wikiId, { dir, itemsToWrite, outline, meta, newCommit, prevHash }).catch((e) => console.error(e)); });
  return { wiki_id: wikiId, refresh: 'regenerating', changed, pages_affected: itemsToWrite.map((i) => i.slug) };
}

// ---------- iii functions ----------

worker.registerFunction(
  'openwiki::generate',
  async ({ repo_url, model, ref, steer }) => startWiki(repo_url, model, ref, steer),
  {
    description: 'Start generating a source-grounded wiki for a git repository URL. Returns immediately with { wiki_id, status }; poll openwiki::status.',
    request_format: S.GENERATE_REQ,
    response_format: S.GENERATE_RES,
  },
);

worker.registerFunction(
  'openwiki::status',
  async ({ id }) => (await store.getStatus(id)) || { phase: 'unknown', progress: 0, updated_at: now() },
  { description: 'Poll generation status for a wiki id.', request_format: S.STATUS_REQ, response_format: S.STATUS_RES },
);

worker.registerFunction(
  'openwiki::wikis',
  async () => ({ wikis: await store.listWikis() }),
  { description: 'List all wikis generated by this worker.', request_format: S.WIKIS_REQ, response_format: S.WIKIS_RES },
);

worker.registerFunction(
  'openwiki::models',
  async () => ({ models: await listModels(worker), default_model: cfg.model }),
  { description: "Models available via llm-router (for the UI's model picker), plus the configured default. Empty when no provider is configured.", request_format: S.MODELS_REQ, response_format: S.MODELS_RES },
);

worker.registerFunction(
  'openwiki::wiki',
  async ({ id }) => {
    const m = await store.getWiki(id);
    if (!m) throw err('openwiki/wiki_not_found', 'wiki not found');
    return m;
  },
  { description: "Fetch a single wiki's metadata.", request_format: S.WIKI_REQ, response_format: S.WIKI_RES },
);

worker.registerFunction(
  'openwiki::pages',
  async ({ id }) => ({ pages: (await store.listPages(id)).map((x) => ({ slug: x.slug, ...x.meta })) }),
  { description: 'List all pages of a wiki.', request_format: S.PAGES_REQ, response_format: S.PAGES_RES },
);

worker.registerFunction(
  'openwiki::page',
  async ({ id, slug }) => {
    const p = await store.getPage(id, slug);
    if (!p) throw err('openwiki/page_not_found', 'page not found');
    return { slug, ...p.meta, markdown: p.markdown };
  },
  { description: 'Get a single wiki page (markdown body + metadata).', request_format: S.PAGE_REQ, response_format: S.PAGE_RES },
);

worker.registerFunction(
  'openwiki::search',
  async ({ id, q }) => ({ results: await searchPages(id, q || '') }),
  { description: 'Search pages of a wiki by keyword.', request_format: S.SEARCH_REQ, response_format: S.SEARCH_RES },
);

worker.registerFunction(
  'openwiki::refresh',
  async ({ id }) => refreshWiki(id),
  { description: 'Pull the repo and regenerate only the pages whose source changed (incremental).', request_format: S.WIKI_REQ, response_format: S.REFRESH_RES },
);

worker.registerFunction(
  'openwiki::lint',
  async ({ id }) => lintWiki(id),
  { description: 'Validate every page citation against the clone and flag thin pages.', request_format: S.LINT_REQ, response_format: S.LINT_RES },
);

worker.registerFunction(
  'openwiki::gen-stats',
  async ({ id }) => {
    const reads = getReadStats(id) || {};
    const pages = await store.listPages(id);
    let output_bytes = 0;
    for (const p of pages) { const pg = await store.getPage(id, p.slug); if (pg) output_bytes += (pg.markdown || '').length; }
    return { reads, page_count: pages.length, output_bytes };
  },
  {
    description: 'Measurement: source bytes the agent read and page bytes produced for a generation.',
    request_format: S.WIKI_REQ,
    response_format: { type: 'object', additionalProperties: true, properties: { page_count: { type: 'integer' }, output_bytes: { type: 'integer' } } },
  },
);

// ---------- Scoped source readers (the harness's exploration tools) ----------
// Each is jailed to one wiki's clone; the page-writer harness calls these via
// agent_trigger to explore the repo and cite exact line ranges.

// Surface the harness's file exploration as live activity. During planning
// (one long opaque plan turn) there is no page progress, so without this the UI
// sits static and reads as frozen. Each read/list/grep pushes a cheap activity
// frame the panel shows as the current line ("reading src/queue.js").
worker.registerFunction(
  'openwiki::src::read',
  async ({ id, path, from, to }) => { pushProgress(id, { kind: 'activity', op: 'read', path }); return srcRead(id, path, from, to); },
  { description: "Read a file (optional 1-indexed line window) from a wiki's cloned repo.", request_format: S.SRC_READ_REQ, response_format: S.SRC_READ_RES },
);

worker.registerFunction(
  'openwiki::src::list',
  async ({ id, dir }) => { pushProgress(id, { kind: 'activity', op: 'list', path: dir || '.' }); return srcList(id, dir); },
  { description: "List files (path, language, priority) in a wiki's cloned repo.", request_format: S.SRC_LIST_REQ, response_format: S.SRC_LIST_RES },
);

worker.registerFunction(
  'openwiki::src::grep',
  async ({ id, pattern, max }) => { pushProgress(id, { kind: 'activity', op: 'grep', path: pattern }); return srcGrep(id, pattern, max); },
  { description: "Search file contents in a wiki's cloned repo.", request_format: S.SRC_GREP_REQ, response_format: S.SRC_GREP_RES },
);

// ---------- Ask / diagram / export ----------

worker.registerFunction(
  'openwiki::ask',
  async ({ id, q, mode, file_answer, model }) => askWiki(worker, { id, q, mode, file_answer, model }),
  { description: 'Ask a question about a wiki; returns a cited answer. mode=fast (router) or deep (harness).', request_format: S.ASK_REQ, response_format: S.ASK_RES },
);

worker.registerFunction(
  'openwiki::diagram',
  async ({ id, kind }) => makeDiagram(worker, { id, kind }),
  { description: 'Generate a Mermaid diagram (architecture|dataflow|deps) of a wiki.', request_format: S.DIAGRAM_REQ, response_format: S.DIAGRAM_RES },
);

worker.registerFunction(
  'openwiki::export-agents-md',
  async ({ id, targets, base_url }) => exportAgentsMd(worker, { id, targets, baseUrl: base_url }),
  { description: 'Build the AGENTS.md/CLAUDE.md pointer block for a wiki.', request_format: S.EXPORT_AGENTS_REQ, response_format: S.EXPORT_AGENTS_RES },
);

// ---------- MCP surface (DeepWiki-compatible tool names; mcp bridge exposes these) ----------

const MCP_EXPOSE = { mcp: { expose: true } };

worker.registerFunction(
  'openwiki::read-wiki-structure',
  async ({ id }) => {
    const m = await store.getWiki(id);
    if (!m) throw err('openwiki/wiki_not_found', 'wiki not found');
    const pages = (await store.listPages(id)).map((x) => ({ slug: x.slug, title: x.meta?.title, category: x.meta?.category }));
    return { repo: m.repo_name, summary: m.summary, categories: m.categories || [], pages };
  },
  { description: "MCP: list a wiki's structure (categories + pages).", request_format: S.WIKI_REQ, response_format: S.MCP_STRUCTURE_RES, metadata: MCP_EXPOSE },
);

worker.registerFunction(
  'openwiki::read-wiki-contents',
  async ({ id, slug }) => {
    const p = await store.getPage(id, slug);
    if (!p) throw err('openwiki/page_not_found', 'page not found');
    return { slug, ...p.meta, markdown: p.markdown };
  },
  { description: 'MCP: read one wiki page (markdown + metadata).', request_format: S.PAGE_REQ, response_format: S.PAGE_RES, metadata: MCP_EXPOSE },
);

worker.registerFunction(
  'openwiki::ask-question',
  async ({ id, q }) => askWiki(worker, { id, q, mode: 'fast' }),
  { description: 'MCP: ask a question about a wiki; returns a cited answer.', request_format: S.SEARCH_REQ, response_format: S.ASK_RES, metadata: MCP_EXPOSE },
);

// ---------- HTTP handlers ----------

const HTTP_REQ = {
  type: 'object',
  additionalProperties: true,
  properties: {
    body: { type: 'string' },
    path_params: { type: 'object', additionalProperties: { type: 'string' } },
    query_params: { type: 'object', additionalProperties: { type: 'string' } },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    method: { type: 'string' },
  },
};
const HTTP_RES = {
  type: 'object',
  additionalProperties: false,
  required: ['status_code', 'body'],
  properties: {
    status_code: { type: 'integer' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    body: { type: 'string' },
  },
};
const HTTP_META = (description) => ({ description, request_format: HTTP_REQ, response_format: HTTP_RES });

function jsonResponse(status_code, body, extraHeaders = {}) {
  return { status_code, headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }, body: JSON.stringify(body) };
}
function htmlResponse(status_code, html) {
  return { status_code, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: html };
}
function parseBody(body) {
  if (body == null) return {};
  if (typeof body === 'object') return body;
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  return {};
}

worker.registerFunction('openwiki::http::ui', async () => htmlResponse(200, INDEX_HTML), HTTP_META('HTTP: serve the OpenWiki browser UI.'));

worker.registerFunction('openwiki::http::wikis-list', async () => jsonResponse(200, await store.listWikis()), HTTP_META('HTTP GET /openwiki/api/wikis'));

worker.registerFunction('openwiki::http::models', async () => jsonResponse(200, { models: await listModels(worker), default_model: cfg.model }), HTTP_META('HTTP GET /openwiki/api/models'));

worker.registerFunction('openwiki::http::wikis-create', async ({ body }) => {
  const payload = parseBody(body);
  if (!payload.repo_url) return jsonResponse(400, { error: 'repo_url required' });
  const { wiki_id, status } = await startWiki(payload.repo_url, payload.model, payload.ref, payload.steer);
  return jsonResponse(202, { wiki_id, status });
}, HTTP_META('HTTP POST /openwiki/api/wikis'));

worker.registerFunction('openwiki::http::wiki-get', async ({ path_params }) => {
  const m = await store.getWiki(path_params?.id);
  return m ? jsonResponse(200, m) : jsonResponse(404, { error: 'not found' });
}, HTTP_META('HTTP GET /openwiki/api/wikis/:id'));

worker.registerFunction('openwiki::http::wiki-status', async ({ path_params }) => {
  const s = await store.getStatus(path_params?.id);
  return jsonResponse(200, s || { phase: 'unknown', progress: 0, updated_at: now() });
}, HTTP_META('HTTP GET /openwiki/api/wikis/:id/status'));

worker.registerFunction('openwiki::http::pages-list', async ({ path_params }) => {
  const items = await store.listPages(path_params?.id);
  return jsonResponse(200, items.map((x) => ({ slug: x.slug, ...x.meta })));
}, HTTP_META('HTTP GET /openwiki/api/wikis/:id/pages'));

worker.registerFunction('openwiki::http::page-get', async ({ path_params }) => {
  const p = await store.getPage(path_params?.id, path_params?.slug);
  return p ? jsonResponse(200, { slug: path_params.slug, ...p.meta, markdown: p.markdown }) : jsonResponse(404, { error: 'not found' });
}, HTTP_META('HTTP GET /openwiki/api/wikis/:id/pages/:slug'));

worker.registerFunction('openwiki::http::search', async ({ path_params, query_params }) => {
  const q = query_params?.q || '';
  return jsonResponse(200, await searchPages(path_params?.id, q));
}, HTTP_META('HTTP GET /openwiki/api/wikis/:id/search?q='));

worker.registerFunction('openwiki::http::refresh', async ({ path_params }) => {
  const r = await refreshWiki(path_params?.id);
  return jsonResponse(200, r);
}, HTTP_META('HTTP POST /openwiki/api/wikis/:id/refresh'));

// SSE live progress: stream generation events over the HTTP response channel.
worker.registerFunction('openwiki::http::events', async (req) => {
  const wikiId = req?.path_params?.id;
  const w = req?.response;
  if (!w || !w.stream) return jsonResponse(200, { error: 'streaming unsupported' });
  const ctl = (o) => { try { w.sendMessage(JSON.stringify(o)); } catch { /* ignore */ } };
  ctl({ type: 'set_status', status_code: 200 });
  ctl({ type: 'set_headers', headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' } });

  let closed = false;
  let off = null;
  let hb = null;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    if (off) off();
    try { w.close(); } catch { /* ignore */ }
  };
  // The channel socket can close under us when the worker navigates away. A
  // write then emits an ASYNC 'error' event on the Writable — a try/catch around
  // write() cannot catch it, and unhandled it crashes the whole worker. Listen
  // for it, and never write once closed.
  try { w.stream.on('error', stop); } catch { /* ignore */ }
  const write = (s) => { if (closed) return; try { w.stream.write(s); } catch { stop(); } };
  const send = (evt) => write(`data: ${JSON.stringify(evt)}\n\n`);

  const snap = await store.getStatus(wikiId);
  if (snap) send({ kind: 'status', ...snap });
  off = onProgress(wikiId, send);
  hb = setInterval(() => write(': ping\n\n'), 15_000);
  if (snap && (snap.phase === 'ready' || snap.phase === 'error')) { send({ kind: 'status', ...snap, final: true }); stop(); }
  try { req.request_body?.stream?.on?.('close', stop); } catch { /* ignore */ }
  return null;
}, HTTP_META('HTTP GET /openwiki/api/wikis/:id/events (SSE live progress)'));

worker.registerFunction('openwiki::http::ask', async ({ path_params, body }) => {
  const p = parseBody(body);
  if (!p.q) return jsonResponse(400, { error: 'q required' });
  return jsonResponse(200, await askWiki(worker, { id: path_params?.id, q: p.q, mode: p.mode, file_answer: p.file_answer }));
}, HTTP_META('HTTP POST /openwiki/api/wikis/:id/ask'));

worker.registerFunction('openwiki::http::diagram', async ({ path_params, query_params }) => {
  return jsonResponse(200, await makeDiagram(worker, { id: path_params?.id, kind: query_params?.kind }));
}, HTTP_META('HTTP GET /openwiki/api/wikis/:id/diagram'));

// ---------- HTTP triggers ----------
// api_path has NO leading slash: the engine prepends '/', and a leading slash
// double-slashes and 404s.

function bind(function_id, api_path, http_method = 'GET') {
  return worker.registerTrigger({ type: 'http', function_id, config: { api_path, http_method } });
}
bind('openwiki::http::ui', 'openwiki', 'GET');
bind('openwiki::http::ui', 'openwiki/', 'GET');
bind('openwiki::http::wikis-list', 'openwiki/api/wikis', 'GET');
bind('openwiki::http::models', 'openwiki/api/models', 'GET');
bind('openwiki::http::wikis-create', 'openwiki/api/wikis', 'POST');
bind('openwiki::http::wiki-get', 'openwiki/api/wikis/:id', 'GET');
bind('openwiki::http::wiki-status', 'openwiki/api/wikis/:id/status', 'GET');
bind('openwiki::http::pages-list', 'openwiki/api/wikis/:id/pages', 'GET');
bind('openwiki::http::page-get', 'openwiki/api/wikis/:id/pages/:slug', 'GET');
bind('openwiki::http::search', 'openwiki/api/wikis/:id/search', 'GET');
bind('openwiki::http::refresh', 'openwiki/api/wikis/:id/refresh', 'POST');
bind('openwiki::http::events', 'openwiki/api/wikis/:id/events', 'GET');
bind('openwiki::http::ask', 'openwiki/api/wikis/:id/ask', 'POST');
bind('openwiki::http::diagram', 'openwiki/api/wikis/:id/diagram', 'GET');

// ---------- Cron: nightly refresh scan ----------

worker.registerFunction('openwiki::cron::nightly', async () => {
  const wikis = await store.listWikis();
  for (const w of wikis) {
    try { await refreshWiki(w.id); } catch (e) { console.error('[openwiki] cron refresh failed', w.id, e?.message); }
  }
  return { scanned: wikis.length };
}, {
  description: 'Cron: check every wiki for source changes and refresh impacted pages.',
  request_format: { type: 'object', additionalProperties: false, properties: {} },
  response_format: { type: 'object', additionalProperties: false, required: ['scanned'], properties: { scanned: { type: 'integer' } } },
});

try {
  worker.registerTrigger({ type: 'cron', function_id: 'openwiki::cron::nightly', config: { expression: '0 15 3 * * * *' } });
} catch (e) {
  console.warn('[openwiki] failed to bind cron', e?.message || e);
}

// Configuration: register the schema, load the stored value, and hot-reload on
// change. Runs off the boot path so it never delays function registration.
configuration.registerConfig(worker)
  .then(() => configuration.fetchConfig(worker))
  .then((c) => { cfg = c; })
  .catch((e) => console.warn('[openwiki] config register failed; using defaults', e?.message || e));
configuration.bindConfigTrigger(worker, async () => { cfg = await configuration.fetchConfig(worker); });

// Reap generations orphaned by a restart. On a fresh boot nothing is in-flight,
// so any wiki still flagged generating was interrupted mid-run. Clear the flag,
// reconcile page_count to what actually landed on disk, and mark the status so
// the UI stops showing a forever-running progress panel. The partial pages that
// were written stay browsable. Runs off the boot path.
(async () => {
  try {
    const wikis = await store.listWikis();
    for (const w of wikis) {
      if (!w.generating || inflight.has(w.id)) continue;
      const pages = await store.listPages(w.id).catch(() => []);
      await store.saveWiki(w.id, { ...w, generating: false, page_count: pages.length, updated_at: now() });
      await store.updateStatus(w.id, {
        phase: pages.length ? 'ready' : 'error', progress: pages.length ? 1 : 0,
        message: `Interrupted by a restart with ${pages.length} page(s). Refresh to complete.`, updated_at: now(),
      });
      await store.appendLog(w.id, `Reaped orphaned generation (${pages.length} pages on disk).`);
    }
  } catch (e) { console.warn('[openwiki] reaper failed', e?.message || e); }
})();

console.log('[openwiki] worker ready — model default =', cfg.model, 'iii url =', III_URL);

process.on('SIGTERM', async () => { try { await worker.shutdown(); } catch {} process.exit(0); });
process.on('SIGINT', async () => { try { await worker.shutdown(); } catch {} process.exit(0); });

// OpenWiki iii worker — Karpathy-style source-grounded wiki maintainer.
// Entrypoint. Wires plumbing modules to iii functions + HTTP triggers.
import { registerWorker } from 'iii-sdk';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { cloneRepo, gitDiff } from './lib/git.mjs';
import { inventoryRepo, readSourceFile } from './lib/inventory.mjs';
import * as store from './lib/store.mjs';
import { searchPages } from './lib/search.mjs';
import { planWiki, generatePage } from './lib/generate.mjs';
import { INDEX_HTML } from './lib/ui.mjs';
import * as configuration from './lib/configuration.mjs';

const III_URL = process.env.III_URL || process.env.III_ENGINE_URL || 'ws://localhost:49134';
let cfg = configuration.defaults();

const client = registerWorker(III_URL, {
  workerName: 'openwiki',
  workerDescription:
    "Source-grounded wiki maintainer: generates and maintains a categorized, interlinked markdown wiki for any git repository, and serves a browser UI + HTTP API to browse and search it.",
});

store.setClient(client);
store.ensureRoot().catch((e) => console.error('[openwiki] ensureRoot', e));

const now = () => new Date().toISOString();
const inflight = new Set();

function inferRepoName(url) {
  return String(url || '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split(/[\/:]/)
    .filter(Boolean)
    .slice(-2)
    .join('/') || url;
}

// ---------- Background generation pipeline ----------

async function runGeneration(wikiId, repoUrl, model) {
  inflight.add(wikiId);
  const started = now();
  try {
    await store.appendLog(wikiId, `Starting generation for ${repoUrl} (model=${model})`);
    await store.updateStatus(wikiId, { phase: 'cloning', progress: 0.05, message: 'Cloning repository', updated_at: now() });

    const dir = store.repoDir(wikiId);
    await fs.rm(dir, { recursive: true, force: true });
    const { commit, name } = await cloneRepo(repoUrl, dir);

    await store.updateStatus(wikiId, { phase: 'inventorying', progress: 0.15, message: 'Reading source files', updated_at: now() });
    const inventory = await inventoryRepo(dir);
    await store.appendLog(wikiId, `Inventoried ${inventory.length} files.`);

    await store.updateStatus(wikiId, { phase: 'planning', progress: 0.25, message: 'Planning wiki structure with LLM', updated_at: now() });
    const { summary, categories, outline } = await planWiki(client, { inventory, repoName: name, repoUrl, model, repoDir: dir });
    await store.saveOutline(wikiId, { categories, items: outline });

    const meta0 = {
      id: wikiId,
      repo_url: repoUrl,
      repo_name: name,
      commit,
      created_at: started,
      updated_at: now(),
      page_count: outline.length,
      category_count: categories.length,
      categories,
      summary,
      model,
      generating: true,
    };
    await store.saveWiki(wikiId, meta0);
    await store.appendLog(wikiId, `Planned ${outline.length} pages across ${categories.length} categories.`);

    const allSlugs = outline.map((o) => o.slug);
    const allTitles = outline.map((o) => o.title);

    let done = 0;
    for (let i = 0; i < outline.length; i += cfg.max_parallel) {
      const batch = outline.slice(i, i + cfg.max_parallel);
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
          const { markdown, frontmatter } = await generatePage(client, {
            outlineItem: item,
            sourceReads: reads,
            allSlugs,
            allTitles,
            categories,
            repoName: name,
            repoUrl,
            model,
          });
          await store.savePage(wikiId, item.slug, markdown, frontmatter);
          await store.appendLog(wikiId, `Wrote ${item.slug} — ${item.title}`);
        } catch (e) {
          await store.appendLog(wikiId, `FAILED ${item.slug}: ${e?.message || e}`);
          await store.savePage(
            wikiId,
            item.slug,
            `# ${item.title}\n\n> Generation failed: ${e?.message || e}\n\n_Source paths_: ${(item.source_paths||[]).map((p) => '`' + p + '`').join(', ') || '(none)'}\n`,
            {
              title: item.title,
              slug: item.slug,
              category: item.category,
              source_paths: item.source_paths || [],
              last_updated: now(),
              confidence: 'low',
              status: 'needs-review',
            },
          );
        }
        done += 1;
        const progress = 0.3 + 0.65 * (done / outline.length);
        await store.updateStatus(wikiId, {
          phase: 'generating',
          progress,
          message: `Generated ${done}/${outline.length} pages`,
          updated_at: now(),
        });
      }));
    }

    // Finalize wiki meta
    const finalMeta = { ...meta0, updated_at: now(), generating: false };
    await store.saveWiki(wikiId, finalMeta);
    await store.updateStatus(wikiId, { phase: 'ready', progress: 1, message: 'Wiki ready', updated_at: now() });
    await store.appendLog(wikiId, 'Wiki ready.');
  } catch (err) {
    console.error('[openwiki] generation error', err);
    await store.appendLog(wikiId, `ERROR: ${err?.stack || err?.message || err}`);
    await store.updateStatus(wikiId, {
      phase: 'error',
      progress: 0,
      error: String(err?.message || err),
      updated_at: now(),
    });
  } finally {
    inflight.delete(wikiId);
  }
}

async function startWiki(repoUrl, model) {
  if (!repoUrl || typeof repoUrl !== 'string') throw new Error('repo_url required');
  const wikiId = crypto.randomUUID();
  const chosen = model || cfg.model;
  await store.saveWiki(wikiId, {
    id: wikiId,
    repo_url: repoUrl,
    repo_name: inferRepoName(repoUrl),
    commit: '',
    created_at: now(),
    updated_at: now(),
    page_count: 0,
    category_count: 0,
    categories: [],
    summary: '',
    model: chosen,
    generating: true,
  });
  await store.updateStatus(wikiId, { phase: 'cloning', progress: 0, message: 'Queued', updated_at: now() });
  setImmediate(() => { runGeneration(wikiId, repoUrl, chosen).catch((e) => console.error(e)); });
  return { wiki_id: wikiId, status: 'cloning' };
}

async function refreshWiki(wikiId) {
  const meta = await store.getWiki(wikiId);
  if (!meta) throw new Error('not found');
  const dir = store.repoDir(wikiId);
  let changed = [];
  try {
    // If repo dir exists, pull; else re-clone
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && stat.isDirectory()) {
      // best-effort git pull
      const { spawn } = await import('node:child_process');
      await new Promise((resolve) => {
        const c = spawn('git', ['pull', '--rebase'], { cwd: dir });
        c.on('close', () => resolve());
        c.on('error', () => resolve());
      });
      try {
        changed = await gitDiff(dir, meta.commit || 'HEAD~1', 'HEAD');
      } catch { /* ignore */ }
    } else {
      await cloneRepo(meta.repo_url, dir);
    }
  } catch (e) {
    await store.appendLog(wikiId, `refresh failed: ${e?.message || e}`);
  }
  await store.appendLog(wikiId, `refresh: ${changed.length} changed paths`);
  // For MVP: re-run full generation if any changes
  if (changed.length > 0 || !meta.commit) {
    runGeneration(wikiId, meta.repo_url, meta.model || cfg.model).catch((e) => console.error(e));
    return { wiki_id: wikiId, refresh: 'regenerating', changed };
  }
  return { wiki_id: wikiId, refresh: 'up_to_date', changed };
}

// ---------- iii functions ----------

client.registerFunction(
  'openwiki::generate',
  async ({ repo_url, model }) => startWiki(repo_url, model),
  {
    description: 'Start generating a source-grounded wiki for a git repository URL. Returns immediately with { wiki_id, status }; poll openwiki::status.',
    request_format: {
      type: 'object',
      required: ['repo_url'],
      properties: {
        repo_url: { type: 'string', description: 'HTTPS git URL of a public repository.' },
        model: { type: 'string', description: 'Optional LLM model id (default claude-sonnet-4-6).' },
      },
    },
    response_format: {
      type: 'object',
      properties: { wiki_id: { type: 'string' }, status: { type: 'string' } },
      required: ['wiki_id', 'status'],
    },
  },
);

client.registerFunction(
  'openwiki::status',
  async ({ id }) => (await store.getStatus(id)) || { phase: 'unknown', progress: 0, updated_at: now() },
  {
    description: 'Poll generation status for a wiki id.',
    request_format: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
);

client.registerFunction(
  'openwiki::wikis',
  async () => ({ wikis: await store.listWikis() }),
  { description: 'List all wikis generated by this worker.' },
);

client.registerFunction(
  'openwiki::wiki',
  async ({ id }) => {
    const m = await store.getWiki(id);
    if (!m) throw new Error('not_found');
    return m;
  },
  { description: 'Fetch a single wiki\'s metadata.',
    request_format: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
);

client.registerFunction(
  'openwiki::pages',
  async ({ id }) => ({ pages: (await store.listPages(id)).map((x) => ({ slug: x.slug, ...x.meta })) }),
  { description: 'List all pages of a wiki.',
    request_format: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
);

client.registerFunction(
  'openwiki::page',
  async ({ id, slug }) => {
    const p = await store.getPage(id, slug);
    if (!p) throw new Error('not_found');
    return { slug, ...p.meta, markdown: p.markdown };
  },
  { description: 'Get a single wiki page (markdown body + metadata).',
    request_format: { type: 'object', required: ['id', 'slug'], properties: { id: { type: 'string' }, slug: { type: 'string' } } } },
);

client.registerFunction(
  'openwiki::search',
  async ({ id, q }) => ({ results: await searchPages(id, q || '') }),
  { description: 'Search pages of a wiki by keyword.',
    request_format: { type: 'object', required: ['id', 'q'], properties: { id: { type: 'string' }, q: { type: 'string' } } } },
);

client.registerFunction(
  'openwiki::refresh',
  async ({ id }) => refreshWiki(id),
  { description: 'Git-pull the repo and regenerate impacted pages if source changed.',
    request_format: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
);

// ---------- HTTP handlers ----------

function jsonResponse(status_code, body, extraHeaders = {}) {
  return {
    status_code,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(body),
  };
}
function htmlResponse(status_code, html) {
  return {
    status_code,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: html,
  };
}
function parseBody(body) {
  if (body == null) return {};
  if (typeof body === 'object') return body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return {};
}

client.registerFunction('openwiki::http::ui', async () => htmlResponse(200, INDEX_HTML), { description: 'HTTP: serve the OpenWiki browser UI.' });

client.registerFunction('openwiki::http::wikis-list', async () => jsonResponse(200, await store.listWikis()), { description: 'HTTP GET /openwiki/api/wikis' });

client.registerFunction('openwiki::http::wikis-create', async ({ body }) => {
  const payload = parseBody(body);
  if (!payload.repo_url) return jsonResponse(400, { error: 'repo_url required' });
  const { wiki_id, status } = await startWiki(payload.repo_url, payload.model);
  return jsonResponse(202, { wiki_id, status });
}, { description: 'HTTP POST /openwiki/api/wikis' });

client.registerFunction('openwiki::http::wiki-get', async ({ path_params }) => {
  const m = await store.getWiki(path_params?.id);
  return m ? jsonResponse(200, m) : jsonResponse(404, { error: 'not found' });
}, { description: 'HTTP GET /openwiki/api/wikis/:id' });

client.registerFunction('openwiki::http::wiki-status', async ({ path_params }) => {
  const s = await store.getStatus(path_params?.id);
  return jsonResponse(200, s || { phase: 'unknown', progress: 0, updated_at: now() });
}, { description: 'HTTP GET /openwiki/api/wikis/:id/status' });

client.registerFunction('openwiki::http::pages-list', async ({ path_params }) => {
  const items = await store.listPages(path_params?.id);
  return jsonResponse(200, items.map((x) => ({ slug: x.slug, ...x.meta })));
}, { description: 'HTTP GET /openwiki/api/wikis/:id/pages' });

client.registerFunction('openwiki::http::page-get', async ({ path_params }) => {
  const p = await store.getPage(path_params?.id, path_params?.slug);
  return p ? jsonResponse(200, { slug: path_params.slug, ...p.meta, markdown: p.markdown }) : jsonResponse(404, { error: 'not found' });
}, { description: 'HTTP GET /openwiki/api/wikis/:id/pages/:slug' });

client.registerFunction('openwiki::http::search', async ({ path_params, query_params }) => {
  const q = query_params?.q || '';
  return jsonResponse(200, await searchPages(path_params?.id, q));
}, { description: 'HTTP GET /openwiki/api/wikis/:id/search?q=' });

client.registerFunction('openwiki::http::refresh', async ({ path_params }) => {
  const r = await refreshWiki(path_params?.id);
  return jsonResponse(200, r);
}, { description: 'HTTP POST /openwiki/api/wikis/:id/refresh' });

// ---------- HTTP triggers ----------

function bind(function_id, api_path, http_method = 'GET') {
  return client.registerTrigger({ type: 'http', function_id, config: { api_path, http_method } });
}
bind('openwiki::http::ui', '/openwiki', 'GET');
bind('openwiki::http::ui', '/openwiki/', 'GET');
bind('openwiki::http::wikis-list', '/openwiki/api/wikis', 'GET');
bind('openwiki::http::wikis-create', '/openwiki/api/wikis', 'POST');
bind('openwiki::http::wiki-get', '/openwiki/api/wikis/:id', 'GET');
bind('openwiki::http::wiki-status', '/openwiki/api/wikis/:id/status', 'GET');
bind('openwiki::http::pages-list', '/openwiki/api/wikis/:id/pages', 'GET');
bind('openwiki::http::page-get', '/openwiki/api/wikis/:id/pages/:slug', 'GET');
bind('openwiki::http::search', '/openwiki/api/wikis/:id/search', 'GET');
bind('openwiki::http::refresh', '/openwiki/api/wikis/:id/refresh', 'POST');

// ---------- Cron: nightly stale scan ----------

client.registerFunction('openwiki::cron::nightly', async () => {
  const wikis = await store.listWikis();
  const scanned = wikis.length;
  for (const w of wikis) {
    try { await refreshWiki(w.id); } catch (e) { console.error('[openwiki] cron refresh failed', w.id, e?.message); }
  }
  return { scanned };
}, { description: 'Cron job: check every wiki for source changes and enqueue regeneration.' });

try {
  // 03:15 every day (sec min hour day month weekday)
  client.registerTrigger({
    type: 'cron',
    function_id: 'openwiki::cron::nightly',
    config: { expression: '0 15 3 * * * *' },
  });
} catch (e) {
  console.warn('[openwiki] failed to bind cron', e?.message || e);
}

// Configuration: register the schema, load the stored value, and hot-reload on
// change. Runs off the boot path so it never delays function registration.
configuration.registerConfig(client)
  .then(() => configuration.fetchConfig(client))
  .then((c) => { cfg = c; })
  .catch((e) => console.warn('[openwiki] config register failed; using defaults', e?.message || e));
configuration.bindConfigTrigger(client, async () => { cfg = await configuration.fetchConfig(client); });

console.log('[openwiki] worker ready — model default =', cfg.model, 'iii url =', III_URL);

process.on('SIGTERM', async () => { try { await client.shutdown(); } catch {} process.exit(0); });
process.on('SIGINT', async () => { try { await client.shutdown(); } catch {} process.exit(0); });

// Harness-backed page generation. Instead of feeding pre-selected source files
// to one completion (generate.mjs), this drives the `harness` worker: the agent
// explores the checked-out repo through openwiki's scoped read functions
// (openwiki::src::*) and returns a validated page via a JSON output contract.
// Falls back to the router/heuristic path (generate.mjs) when the harness is
// absent or a turn fails.
import { generatePage } from './generate.mjs';
import { resolveModel } from './model.mjs';
import { PAGE_HARNESS_OUT, PLAN_HARNESS_OUT } from './schemas.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a GitHub blob deep-link at the pinned commit. Returns null for non-
// GitHub hosts or when the commit is unknown.
export function citationUrl(repoUrl, commit, path, from, to) {
  if (!commit || !path) return null;
  const m = String(repoUrl || '').replace(/\.git$/, '').match(/github\.com[:/]+([^/]+)\/([^/]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\/+$/, '');
  let frag = '';
  if (from) frag = '#L' + from + (to && to !== from ? '-L' + to : '');
  return `https://github.com/${owner}/${repo}/blob/${commit}/${path}${frag}`;
}

// Slice a 1-indexed inclusive line window out of a file's content.
export function lineWindow(content, from, to) {
  const lines = String(content ?? '').split(/\r?\n/);
  const total = lines.length;
  if (!from && !to) return { text: String(content ?? ''), from: 1, to: total, total_lines: total, truncated: false };
  const a = Math.max(1, from || 1);
  const b = Math.min(total, to || total);
  return { text: lines.slice(a - 1, b).join('\n'), from: a, to: b, total_lines: total, truncated: a > 1 || b < total };
}

const PAGE_SYSTEM =
  'You are OpenWiki, a source-grounded wiki maintainer writing ONE page of a repository wiki.\n' +
  'You can explore the repository with these functions (always pass the given wiki id):\n' +
  '- openwiki::src::list { id, dir? } — list files (path, language, priority).\n' +
  '- openwiki::src::read { id, path, from?, to? } — read a file, optionally a line window.\n' +
  '- openwiki::src::grep { id, pattern } — search file contents.\n' +
  'Read the relevant source BEFORE writing. Ground every substantive claim in real code.\n' +
  'Return JSON matching the schema: { title, markdown, citations, links, confidence, status }.\n' +
  '- markdown: the page body only (no YAML frontmatter). Start with a level-1 heading.\n' +
  '- citations: exact { path, start_line, end_line, note } for the code each claim rests on.\n' +
  '- links: slugs of sibling pages you reference; link them inline as [Title](./slug.md).\n' +
  '- If a claim cannot be verified from source, set status to "needs-review" rather than guessing.\n' +
  'Keep the page under 400 lines; prefer clarity over completeness.';

function buildUserPrompt({ wikiId, outlineItem, repoName, repoUrl, categories, allSlugs, allTitles }) {
  const cat = (categories || []).find((c) => c.id === outlineItem.category);
  const categoryTitle = cat ? cat.title : outlineItem.category;
  const siblings = (allSlugs || []).map((s, i) => `- ${s} — ${(allTitles || [])[i] || ''}`).join('\n');
  return (
    `Repository: ${repoName} (${repoUrl})\n` +
    `Wiki id (pass as "id" to every openwiki::src::* call): ${wikiId}\n` +
    `Category: ${categoryTitle}\n` +
    `Page title: ${outlineItem.title}\n` +
    `Page slug: ${outlineItem.slug}\n` +
    `Brief: ${outlineItem.brief || ''}\n` +
    `Suggested starting files: ${(outlineItem.source_paths || []).join(', ') || '(discover via openwiki::src::list)'}\n\n` +
    `Sibling pages you may link to (slug — title):\n${siblings}\n\n` +
    'Explore the source, then return the page JSON.'
  );
}

// Poll harness::status until the turn is terminal; return its output-contract
// result. Throws on failure/timeout (best-effort stop on timeout).
export async function awaitTurn(client, session_id, { timeoutMs = 240_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let s;
    try {
      s = await client.trigger({ function_id: 'harness::status', payload: { session_id } });
    } catch (e) {
      throw new Error('harness::status failed: ' + (e?.message || e));
    }
    const status = s?.status;
    if (status === 'completed') return s.result;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error('harness turn ' + status + (s?.result_error ? ': ' + s.result_error : ''));
    }
    if (Date.now() > deadline) {
      try { await client.trigger({ function_id: 'harness::stop', payload: { session_id } }); } catch { /* best effort */ }
      throw new Error('harness turn timed out');
    }
    await sleep(intervalMs);
  }
}

export function mapResult(result, { outlineItem, repoUrl, commit }) {
  if (!result || typeof result !== 'object') throw new Error('harness returned no result');
  const markdown = String(result.markdown || '').trim();
  if (!markdown) throw new Error('harness returned empty markdown');
  const citations = (result.citations || [])
    .filter((c) => c && c.path)
    .map((c) => {
      const url = citationUrl(repoUrl, commit, c.path, c.start_line, c.end_line);
      return { path: c.path, start_line: c.start_line, end_line: c.end_line, note: c.note, ...(url ? { url } : {}) };
    });
  const sourcePaths = [...new Set(citations.map((c) => c.path).concat(outlineItem.source_paths || []))];
  return {
    markdown,
    frontmatter: {
      title: result.title || outlineItem.title,
      slug: outlineItem.slug,
      category: outlineItem.category,
      source_paths: sourcePaths,
      citations,
      last_updated: new Date().toISOString(),
      confidence: result.confidence || 'medium',
      status: result.status || 'current',
      generator: 'harness',
    },
  };
}

export async function generatePageViaHarness(client, opts) {
  const { wikiId, outlineItem, repoName, repoUrl, commit, categories, allSlugs, allTitles, model, provider, parentSessionId, maxTurns = 12, timeoutMs = 240_000 } = opts;
  const message = buildUserPrompt({ wikiId, outlineItem, repoName, repoUrl, categories, allSlugs, allTitles });
  const options = {
    system_prompt: PAGE_SYSTEM,
    output: { type: 'json', schema: PAGE_HARNESS_OUT },
    functions: { allow: ['openwiki::src::read', 'openwiki::src::list', 'openwiki::src::grep'] },
    max_turns: maxTurns,
  };
  let sessionId = null;
  // Spawn each page as a sub-agent of the plan session so a generation is one
  // tree (parent + page children) instead of N flat top-level sessions.
  if (parentSessionId) {
    try {
      const r = await client.trigger({
        function_id: 'harness::spawn',
        payload: { task: message, model, ...(provider ? { provider } : {}), parent_session_id: parentSessionId, options: { ...options, max_children: 8 } },
        timeoutMs: 30_000,
      });
      sessionId = r?.child_session_id || null;
    } catch { sessionId = null; }
  }
  if (!sessionId) {
    const r = await client.trigger({
      function_id: 'harness::send',
      payload: { message, model, ...(provider ? { provider } : {}), options },
      timeoutMs: 30_000,
    });
    sessionId = r?.session_id;
  }
  if (!sessionId) throw new Error('harness::send returned no session_id');
  const result = await awaitTurn(client, sessionId, { timeoutMs });
  return mapResult(result, { outlineItem, repoUrl, commit });
}

const PLAN_SYSTEM =
  'You are OpenWiki planning a documentation wiki for a code repository.\n' +
  'Explore the repository first with these functions (always pass the given id):\n' +
  '- openwiki::src::list { id, dir? } — the file tree (path, language, priority).\n' +
  '- openwiki::src::read { id, path, from?, to? } — read a file.\n' +
  '- openwiki::src::grep { id, pattern } — search contents.\n' +
  'Read the entry points, key modules, config, and docs before deciding structure.\n' +
  'Design a reader-facing wiki of 5–12 pages organized by category, based on the ACTUAL\n' +
  'modules, subsystems, and concepts in the source — never a generic template.\n' +
  'Rules:\n' +
  '- Every page cites at least one real source path from the repo.\n' +
  '- Prefer conceptual pages that stitch multiple files over one-page-per-file.\n' +
  '- Do NOT create a category unless at least one page belongs to it.\n' +
  '- Always include an overview; add architecture/data-model/api/workflows/operations\n' +
  '  pages only when the code actually warrants them.\n' +
  'Return JSON: { summary, categories:[{id,title,description}], outline:[{slug,title,category,brief,source_paths}] }.';

// Plan a wiki by having the harness explore the clone (openwiki::src::*), so the
// structure reflects the real repo rather than a heuristic template. Throws when
// the harness is unavailable; the caller falls back to the router/heuristic plan.
export async function planViaHarness(client, { wikiId, repoName, repoUrl, model, maxTurns = 24, timeoutMs = 300_000 }) {
  const resolved = await resolveModel(client, model);
  if (!resolved.resolved) throw new Error('no model available for harness plan');
  const message =
    `Repository: ${repoName} (${repoUrl})\n` +
    `Wiki id (pass as "id" to every openwiki::src::* call): ${wikiId}\n` +
    'Explore the repository, then return the wiki plan JSON.';
  const { session_id } = await client.trigger({
    function_id: 'harness::send',
    payload: {
      message,
      model: resolved.model,
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      options: {
        system_prompt: PLAN_SYSTEM,
        output: { type: 'json', schema: PLAN_HARNESS_OUT },
        functions: { allow: ['openwiki::src::read', 'openwiki::src::list', 'openwiki::src::grep'] },
        max_turns: maxTurns,
        max_children: 64, // page sub-agents spawn under this session
      },
    },
    timeoutMs: 30_000,
  });
  const result = await awaitTurn(client, session_id, { timeoutMs });
  if (!result || !Array.isArray(result.outline) || result.outline.length < 1) throw new Error('harness returned an empty plan');
  return { summary: result.summary || '', categories: Array.isArray(result.categories) ? result.categories : [], outline: result.outline, sessionId: session_id };
}

// Tiered page writer: harness (agentic, cited) -> router/heuristic (generate.mjs).
export async function generatePageAny(client, opts) {
  if (opts.wikiId && opts.model && opts.useHarness !== false) {
    try {
      const out = await generatePageViaHarness(client, opts);
      if (String(out?.markdown || '').trim()) return out;
    } catch (e) {
      if (typeof opts.onFallback === 'function') opts.onFallback(e);
    }
  }
  return generatePage(client, opts);
}

// Harness-backed page generation. Instead of feeding pre-selected source files
// to one completion (generate.mjs), this drives the `harness` worker: the agent
// explores the checked-out repo through openwiki's scoped read functions
// (openwiki::src::*) and returns a validated page via a JSON output contract.
// Falls back to the router/heuristic path (generate.mjs) when the harness is
// absent or a turn fails.
import { generatePage } from './generate.mjs';
import { resolveModel } from './model.mjs';
import { getPageQualityIssues, pageRepairFeedback } from './quality.mjs';
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
  'You are OpenWiki, a source-grounded technical writer producing ONE page of a repository wiki.\n' +
  'Explore the repository with these functions (always pass the given wiki id):\n' +
  '- openwiki::src::list { id, dir? } — the file tree (path, language, priority).\n' +
  '- openwiki::src::read { id, path, from?, to? } — read a file or a line window.\n' +
  '- openwiki::src::grep { id, pattern } — search file contents.\n' +
  'Read the relevant source BEFORE writing. Ground every claim in real code; never invent files, APIs, or behavior.\n\n' +
  'Write a substantial, well-structured page:\n' +
  '- Start with a single "# Title" heading.\n' +
  '- Include AT LEAST 3 "##" sections, chosen as the evidence supports: Purpose and Scope, Relevant Source Files,\n' +
  '  System-to-Code Mapping, Core Concepts, Execution Flow, Key Types and Interfaces, Configuration,\n' +
  '  Extension Points, Things to Watch When Editing, Testing Signals.\n' +
  '- ALWAYS include a "## Relevant Source Files" section: bullets naming each key file and one line on why it matters.\n' +
  '- Explain WHY the code is shaped this way, not only what it does.\n' +
  '- Ground concrete claims with visible "Sources: path/a.ts, path/b.ts" lines in the prose (copy paths exactly).\n' +
  '- Where a picture aids understanding (architecture, data flow, execution flow, a state machine, a class or module\n' +
  '  relationship), embed a Mermaid diagram INLINE as a ```mermaid fenced code block, placed in the relevant section.\n' +
  '  Keep each diagram small and valid (flowchart/sequenceDiagram/classDiagram). Do not add a diagram just to have one.\n' +
  '- Aim for 400-900 words of real explanation (code blocks and bare paths do not count).\n' +
  '- Link sibling pages inline as [Title](./slug.md).\n\n' +
  'Return JSON matching the schema: { title, markdown, citations, links, confidence, status }.\n' +
  '- markdown: the page body only (no YAML frontmatter).\n' +
  '- citations: exact { path, start_line, end_line, note } for the code each claim rests on; paths must be files you read.\n' +
  '- If a claim cannot be verified from source, set status to "needs-review".';

function buildUserPrompt({ wikiId, outlineItem, repoName, repoUrl, categories, allSlugs, allTitles, feedback, previousMarkdown }) {
  const cat = (categories || []).find((c) => c.id === outlineItem.category);
  const categoryTitle = cat ? cat.title : outlineItem.category;
  const siblings = (allSlugs || []).map((s, i) => `- ${s} — ${(allTitles || [])[i] || ''}`).join('\n');
  let prompt =
    `Repository: ${repoName} (${repoUrl})\n` +
    `Wiki id (pass as "id" to every openwiki::src::* call): ${wikiId}\n` +
    `Category: ${categoryTitle}\n` +
    `Page title: ${outlineItem.title}\n` +
    `Page slug: ${outlineItem.slug}\n` +
    `Brief: ${outlineItem.brief || ''}\n` +
    `Suggested starting files: ${(outlineItem.source_paths || []).join(', ') || '(discover via openwiki::src::list)'}\n\n` +
    `Sibling pages you may link to (slug — title):\n${siblings}\n\n` +
    'Explore the source, then return the page JSON.';
  if (feedback) {
    prompt += '\n\n' + feedback;
    if (previousMarkdown) prompt += '\n\nYour previous draft (improve it, keep the accurate parts):\n' + previousMarkdown.slice(0, 3500);
  }
  return prompt;
}

// One harness turn for a page. Runs in a named child session titled with the
// page, linked to the plan session via metadata.parent_session_id — the same
// linkage shape harness uses for real sub-agents, so the console renders each
// page as a titled child under the wiki's plan session (not an opaque s_… id).
// harness::spawn is not used here: a direct spawn call has no parent (it links
// only when dispatched from inside a running turn), so it can neither name nor
// nest. send + SessionInit does both.
async function runPageTurn(worker, { message, model, provider, parentSessionId, childSessionId, title, options, timeoutMs, outlineItem, repoUrl, commit }) {
  const payload = { message, model, ...(provider ? { provider } : {}), options };
  if (childSessionId) {
    payload.session_id = childSessionId;
    payload.session = {
      title: title || outlineItem.title,
      ...(parentSessionId ? { metadata: { parent_session_id: parentSessionId, depth: 1 } } : {}),
    };
  }
  const r = await worker.trigger({ function_id: 'harness::send', payload, timeoutMs: 30_000 });
  const sessionId = r?.session_id;
  if (!sessionId) throw new Error('harness::send returned no session_id');
  const result = await awaitTurn(worker, sessionId, { timeoutMs });
  return mapResult(result, { outlineItem, repoUrl, commit });
}

// A session id is any stable string; the console shows the title, not the id.
// Keep ids readable and greppable so a whole wiki's turns share a prefix.
export function sessionSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
export function wikiParentSession(repoName, wikiId) {
  return 'openwiki:' + (sessionSlug(repoName) || 'repo') + ':' + String(wikiId || '').slice(0, 6);
}

// Poll harness::status until the turn is terminal; return its output-contract
// result. Throws on failure/timeout (best-effort stop on timeout).
export async function awaitTurn(worker, session_id, { timeoutMs = 240_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let s;
    try {
      s = await worker.trigger({ function_id: 'harness::status', payload: { session_id } });
    } catch (e) {
      throw new Error('harness::status failed: ' + (e?.message || e));
    }
    const status = s?.status;
    if (status === 'completed') return s.result;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error('harness turn ' + status + (s?.result_error ? ': ' + s.result_error : ''));
    }
    if (Date.now() > deadline) {
      try { await worker.trigger({ function_id: 'harness::stop', payload: { session_id } }); } catch { /* best effort */ }
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

// Generate one page, then run a deterministic quality gate and, if it fails,
// repair by re-prompting with the exact failing reasons (up to maxAttempts).
export async function generatePageViaHarness(worker, opts) {
  const {
    wikiId, outlineItem, repoName, repoUrl, commit, categories, allSlugs, allTitles,
    model, provider, parentSessionId, maxTurns = 12, timeoutMs = 240_000,
    maxAttempts = 3, minWords = 300,
  } = opts;
  const options = {
    system_prompt: PAGE_SYSTEM,
    output: { type: 'json', schema: PAGE_HARNESS_OUT },
    functions: { allow: ['openwiki::src::read', 'openwiki::src::list', 'openwiki::src::grep'] },
    max_turns: maxTurns,
  };

  // Name the page's session under the plan session so the console shows a
  // titled child per page instead of a fresh opaque id. Repair attempts reuse
  // the same session, so retries read as follow-up turns on that page.
  const childSessionId = parentSessionId ? parentSessionId + '/' + outlineItem.slug : null;
  let feedback = '';
  let previousMarkdown = '';
  let best = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const message = buildUserPrompt({ wikiId, outlineItem, repoName, repoUrl, categories, allSlugs, allTitles, feedback, previousMarkdown });
    const out = await runPageTurn(worker, { message, model, provider, parentSessionId, childSessionId, title: outlineItem.title, options, timeoutMs, outlineItem, repoUrl, commit });
    const issues = getPageQualityIssues(out.markdown, { minWords });
    best = out;
    if (!issues.length || attempt === maxAttempts) {
      out.frontmatter.quality_issues = issues.length;
      if (issues.length) out.frontmatter.status = 'needs-review';
      return out;
    }
    feedback = pageRepairFeedback(issues);
    previousMarkdown = out.markdown;
  }
  return best;
}

// Spawn one page-writer as a native harness sub-agent (fire-and-forget). The
// page arrives later on harness::turn-completed (routed via turnbus), never here.
// harness::spawn (not send) is REQUIRED: only spawn stamps
// display_parent_session_id, which the turn-completed event carries so openwiki
// can collect every page via a single {parent_session_id: root} subscription
// (a plain send emits parent_session_id: null — harness send.rs). The child
// reads source itself via openwiki::src::*; openwiki pre-reads nothing.
export async function spawnPageChild(worker, opts) {
  const {
    wikiId, outlineItem, repoName, repoUrl, categories, allSlugs, allTitles,
    model, provider, rootSessionId, feedback = '', previousMarkdown = '', maxTurns = 12,
  } = opts;
  const childSessionId = rootSessionId + '/' + outlineItem.slug;
  const message = buildUserPrompt({ wikiId, outlineItem, repoName, repoUrl, categories, allSlugs, allTitles, feedback, previousMarkdown });
  const r = await worker.trigger({
    function_id: 'harness::spawn',
    payload: {
      task: message,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      session_id: childSessionId,
      parent_session_id: rootSessionId,
      options: {
        system_prompt: PAGE_SYSTEM,
        output: { type: 'json', schema: PAGE_HARNESS_OUT },
        functions: { allow: ['openwiki::src::read', 'openwiki::src::list', 'openwiki::src::grep'] },
        max_turns: maxTurns,
      },
    },
    timeoutMs: 30_000,
  });
  return r?.child_session_id || childSessionId;
}

// Native orchestrator: ONE agent session does the whole job the harness way.
// The system prompt makes spawning part of the task, so the agent calls
// harness::spawn itself (in-turn) — that is how the harness loop delegates, not
// an injected "now spawn" directive. The harness parks the parent, runs the
// page-writer children in parallel, delivers each result back to the parent, and
// the parent assembles + submits the wiki. openwiki just reads the final result.
const ORCHESTRATOR_SYSTEM =
  'You are OpenWiki. Turn a code repository into a source-grounded wiki by DELEGATING each page to a sub-agent.\n\n' +
  'You have these functions:\n' +
  '- openwiki::src::list { id, dir? } — the file tree.\n' +
  '- openwiki::src::read { id, path, from?, to? } — read a file.\n' +
  '- openwiki::src::grep { id, pattern } — search contents.\n' +
  '- harness::spawn — start a sub-agent to do a focused piece of work and return its result to you.\n\n' +
  'Steps:\n' +
  '1. Explore the repository with openwiki::src::* (always pass the given id) until you understand its modules and concepts.\n' +
  '2. Decide a reader-facing wiki: one page per real subsystem or concept. Scale the page count to the repo (tiny <25 files: 3-6 pages; small: 8-14; medium: 16-28; large or doc-heavy: 30-48).\n' +
  '3. WRITE the wiki by spawning ONE page-writer sub-agent per page with harness::spawn. Put ALL the spawns in a SINGLE message so they run in parallel. For each spawn: give it session_id "<id-prefix>/<slug>"; allow it only the openwiki::src::* functions; set its output contract to json {markdown}. Do NOT set a model or provider on the spawns — the sub-agents automatically use yours; never name a model. Do NOT write any page yourself.\n' +
  '   Each sub-agent task MUST demand a substantial, source-grounded page: read the relevant source first (openwiki::src::*, same id); at least 3 "##" sections; a "## Relevant Source Files" section naming the key files; explain WHY the code is shaped this way, not only what it does; ground claims with "Sources: path/a.ts, path/b.ts" lines and inline path:line references; 400-900 words of real prose. CRITICAL: wherever a picture aids understanding (architecture, data flow, execution flow, a state machine, a class or module relationship), the sub-agent MUST embed a small valid Mermaid diagram INLINE as a ```mermaid fenced code block placed in the relevant section (flowchart / sequenceDiagram / classDiagram). Tell each sub-agent this explicitly.\n' +
  '4. When every sub-agent has returned, submit your final result.\n\n' +
  'Final result JSON: { summary, navigation:[navNode], pages:[{ slug, title, category, markdown }] }, where pages holds the markdown each sub-agent returned and navigation is a nested tree (folders have title+children and no slug; leaves have title+slug).';

const WIKI_ORCHESTRATOR_OUT = {
  type: 'object',
  additionalProperties: true,
  required: ['pages'],
  properties: {
    summary: { type: 'string' },
    navigation: { type: 'array', items: { type: 'object', additionalProperties: true } },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['slug', 'markdown'],
        properties: {
          slug: { type: 'string' }, title: { type: 'string' },
          category: { type: 'string' }, markdown: { type: 'string' },
          citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  },
};

// Drive the whole generation as one native agentic session. Returns the wiki the
// orchestrator assembled from its sub-agents, plus the root session id (page
// children nest under it in the console).
export async function runOrchestrator(worker, { wikiId, repoName, repoUrl, model, docsHint = '', maxTurns = 60, timeoutMs = 600_000 }) {
  const resolved = await resolveModel(worker, model);
  if (!resolved.resolved) throw new Error('no model available for the orchestrator');
  const root = wikiParentSession(repoName, wikiId);
  const message =
    `Repository: ${repoName} (${repoUrl})\n` +
    `Wiki id (pass as "id" to every openwiki::src::* call, and use "${root}/<slug>" as each sub-agent's session_id): ${wikiId}` +
    (docsHint || '') +
    '\nExplore, decide the pages, spawn a page-writer sub-agent per page, then submit the wiki.';
  const { session_id } = await worker.trigger({
    function_id: 'harness::send',
    payload: {
      session_id: root,
      session: { title: 'openwiki: ' + repoName },
      message,
      model: resolved.model,
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      options: {
        system_prompt: ORCHESTRATOR_SYSTEM,
        output: { type: 'json', schema: WIKI_ORCHESTRATOR_OUT },
        functions: { allow: ['harness::spawn', 'openwiki::src::read', 'openwiki::src::list', 'openwiki::src::grep'] },
        max_turns: maxTurns,
      },
    },
    timeoutMs: 30_000,
  });
  if (!session_id) throw new Error('orchestrator send returned no session_id');
  const result = await awaitTurn(worker, session_id, { timeoutMs });
  if (!result || !Array.isArray(result.pages) || result.pages.length < 1) throw new Error('orchestrator returned no pages');
  return { summary: result.summary || '', navigation: Array.isArray(result.navigation) ? result.navigation : [], pages: result.pages, sessionId: session_id };
}

// Child page schema the parent embeds in each spawn's output contract. Kept
// small so the model can reproduce it reliably in N spawn calls.
const CHILD_PAGE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    markdown: { type: 'string' },
    citations: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } } } },
  },
  required: ['title', 'markdown'],
};

// Agent-driven fan-out: send a directive INTO the plan session so the PARENT
// agent emits the harness::spawn calls itself (they show up in the parent's
// transcript and drive a real park/join), instead of openwiki spawning behind
// its back. The children still emit turn-completed{parent_session_id: root},
// so openwiki collects them exactly as before (turnbus). The parent's policy
// must allow BOTH harness::spawn (to spawn) AND openwiki::src::* (children
// subset the parent's policy — Agent gotcha), else page-writers can read nothing.
export async function sendSpawnDirective(worker, { rootSessionId, wikiId, outline, model, provider, childMaxTurns = 12 }) {
  // Lightweight: name the pages, let the model spawn naturally. The harness's
  // own system prompt already teaches harness::spawn; we do not embed schemas or
  // rigid templates (that bloats the turn and the agent chokes reproducing it).
  const rows = outline.map((p) => `- ${p.slug} — ${p.title}`).join('\n');
  const message =
    'Now write the wiki you just planned. For EACH page below, spawn one page-writer sub-agent with harness::spawn — put all the spawns in THIS message so they run in parallel. Do not write any page yourself.\n\n' +
    `Each sub-agent: tell it to write that one page, reading source with openwiki::src::read / openwiki::src::list / openwiki::src::grep (id="${wikiId}"), with a "Relevant Source Files" section and path:line citations. Give each spawn session_id="${rootSessionId}/<slug>", allow it only the openwiki::src::* functions, and set its output contract to {"type":"json","schema":{"type":"object","properties":{"markdown":{"type":"string"}},"required":["markdown"]}} so it returns the page as {markdown}.\n\n` +
    'Pages:\n' + rows + '\n\nWhen every sub-agent has finished, reply: done.';
  await worker.trigger({
    function_id: 'harness::send',
    payload: {
      session_id: rootSessionId,
      message,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      options: {
        functions: { allow: ['harness::spawn', 'openwiki::src::read', 'openwiki::src::list', 'openwiki::src::grep'] },
        max_turns: 8,
      },
    },
    timeoutMs: 30_000,
  });
}

const PLAN_SYSTEM =
  'You are OpenWiki planning a documentation wiki for a code repository.\n' +
  'Explore the repository first (always pass the given id):\n' +
  '- openwiki::src::list { id, dir? } — the file tree (path, language, priority).\n' +
  '- openwiki::src::read { id, path, from?, to? } — read a file.\n' +
  '- openwiki::src::grep { id, pattern } — search contents.\n' +
  'Read entry points, key modules, config, and docs before deciding structure.\n\n' +
  'Design a reader-facing wiki from the ACTUAL modules, subsystems, and concepts in the source.\n' +
  'Page budget scales to the repo: tiny (<25 files) 3-6 pages; small 8-14; medium 16-28; large or doc-heavy 30-48.\n' +
  'Build a real information architecture, not a flat file list:\n' +
  '- navigation is a NESTED tree, up to 3 levels: top-level folders -> optional sub-folders -> leaf pages.\n' +
  '- A folder node has a title and children and NO slug. A leaf node has a title and a slug (a real page).\n' +
  '- Start with a "Start Here" area (overview, install/getting-started), then group the rest by real subsystem or concept.\n' +
  '- Every leaf slug must appear exactly once in pages[]. Every page must reference at least one real source path.\n' +
  '- Do not create a folder that holds only one leaf; make it a page instead.\n\n' +
  'Return JSON: { summary, pages:[{slug,title,brief,source_paths}], navigation:[navNode] }.';

// Plan a wiki by having the harness explore the clone (openwiki::src::*), so the
// structure reflects the real repo rather than a heuristic template. Throws when
// the harness is unavailable; the caller falls back to the router/heuristic plan.
export async function planViaHarness(worker, { wikiId, repoName, repoUrl, model, docsHint = '', parentSessionId, maxTurns = 24, timeoutMs = 300_000, maxAttempts = 3, onRetry }) {
  const resolved = await resolveModel(worker, model);
  if (!resolved.resolved) throw new Error('no model available for harness plan');
  const base = parentSessionId || wikiParentSession(repoName, wikiId);
  const message =
    `Repository: ${repoName} (${repoUrl})\n` +
    `Wiki id (pass as "id" to every openwiki::src::* call): ${wikiId}` +
    (docsHint || '') +
    '\nExplore the repository, then return the wiki plan JSON.';
  // The plan is a long agentic turn (explore + structured output). Provider
  // streaming is the flakiest part of it ("stream ended without a terminal
  // frame"), and one failure would otherwise sink the whole generation. Retry
  // on a FRESH session each attempt so a failed turn's partial transcript never
  // bloats the retry (which would only make the next stream more likely to drop).
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const parent = attempt === 1 ? base : base + ':r' + attempt;
    try {
      const { session_id } = await worker.trigger({
        function_id: 'harness::send',
        payload: {
          session_id: parent,
          session: { title: 'openwiki: ' + repoName },
          message,
          model: resolved.model,
          ...(resolved.provider ? { provider: resolved.provider } : {}),
          options: {
            system_prompt: PLAN_SYSTEM,
            output: { type: 'json', schema: PLAN_HARNESS_OUT },
            functions: { allow: ['openwiki::src::read', 'openwiki::src::list', 'openwiki::src::grep'] },
            max_turns: maxTurns,
          },
        },
        timeoutMs: 30_000,
      });
      if (!session_id) throw new Error('harness::send returned no session_id for plan');
      const result = await awaitTurn(worker, session_id, { timeoutMs });
      if (!result || !Array.isArray(result.pages) || result.pages.length < 1) throw new Error('harness returned an empty plan');
      return {
        summary: result.summary || '',
        pages: result.pages,
        navigation: Array.isArray(result.navigation) ? result.navigation : [],
        sessionId: session_id,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) { try { onRetry?.(attempt, e); } catch { /* ignore */ } await sleep(1500 * attempt); }
    }
  }
  throw lastErr || new Error('harness plan failed');
}

// Tiered page writer: harness (agentic, cited) -> router/heuristic (generate.mjs).
export async function generatePageAny(worker, opts) {
  if (opts.wikiId && opts.model && opts.useHarness !== false) {
    try {
      const out = await generatePageViaHarness(worker, opts);
      if (String(out?.markdown || '').trim()) return out;
    } catch (e) {
      if (typeof opts.onFallback === 'function') opts.onFallback(e);
    }
  }
  return generatePage(worker, opts);
}

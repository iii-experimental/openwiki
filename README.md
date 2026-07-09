# openwiki

An iii worker that builds and maintains a source-grounded, interlinked markdown
wiki for a code repository, and serves a browser UI to read and search it.

Point it at a git repo. A language model reads the source, plans a categorized
outline, writes one page per topic with file citations, and keeps the wiki
current from git diffs. Routing, scheduling, and the HTTP surface run on iii
primitives; the model is a wiki maintainer, not a chatbot.

Not published to the iii registry yet. Run it locally against a running engine.

## How it composes

openwiki is a thin orchestrator: it calls other iii workers over the bus instead
of embedding their logic, and degrades gracefully when a worker is absent.

**Page generation is tiered.** For each page it tries, in order:

1. `harness` — an agent explores the clone through openwiki's scoped readers
   (`openwiki::src::read` / `src::list` / `src::grep`) and returns a page with
   line-level citations. Best quality.
2. `llm-router` — one `router::complete` over the pre-selected source files.
3. heuristic — no LLM; builds a serviceable page from file headers. Always works.

Git runs through `shell` (`shell::exec`) when present, otherwise a local `git`
fallback. Persistence is iii-state (engine builtin). The engine serves the UI +
JSON API over its built-in `http` triggers; the nightly refresh uses `iii-cron`
(pulled in with `harness`).

### Workers

One command installs everything openwiki composes:

```
iii worker add harness console
```

`harness` pulls its whole stack transitively — `llm-router`, `session-manager`,
`context-manager`, `shell`, the model providers, `iii-state`, `iii-cron`, and
`web` — so you never list them yourself. `console` adds the trace + chat UI for
watching generation live. The engine serves openwiki's browser UI and JSON API
directly (the `http` trigger type is built in — no separate http worker).

openwiki degrades gracefully when a worker is absent:

| Present | Pages are |
|---|---|
| `harness` + a configured provider | agent-explored, line-cited (best) |
| `llm-router` only | model-written from pre-selected files |
| neither | heuristic — built from file headers, always works |

The provider credential lives in the `llm-router` / provider config, never in
openwiki. The default model is `claude-haiku-4-5-20251001`; the browser UI's
generate form has a model picker populated from the router's live catalog
(grouped by provider), or override per call (`{"model":"..."}`) or with
`OPENWIKI_MODEL`. openwiki resolves the model against `router::models::list` and
prefers a structured-output-capable model for the harness path.

Git (clone / diff) runs through `shell` (jailed to `fs.host_roots`); if the shell
worker is absent, openwiki falls back to a local `git` on PATH.

## Local setup

```
git clone https://github.com/iii-experimental/openwiki
cd openwiki
npm install
```

Start the engine in one terminal:

```
iii                              # runs the engine; serves HTTP on :3111
```

In another, install the workers openwiki composes and run it:

```
iii worker add harness console   # pulls the whole stack + the trace UI
III_URL=ws://127.0.0.1:49134 node src/index.mjs
```

Git (clone / diff) runs through the `shell` worker (installed with `harness`), so
the clone directory (`OPENWIKI_DATA`) must resolve inside shell's `fs.host_roots`.
Without the shell worker, openwiki falls back to a local `git` on PATH.

Environment:

- `III_URL` engine WebSocket (default `ws://localhost:49134`).
- `OPENWIKI_MODEL` default generation model (default `claude-haiku-4-5-20251001`).
- `OPENWIKI_DATA` wiki store directory (default `/tmp/openwiki-data`).
- `OPENWIKI_MAX_PARALLEL` concurrent page writers (default `3`).

## Use

Open the browser UI (served on the engine's HTTP port):

```
open http://localhost:3111/openwiki
```

Or generate from the command line and browse the functions:

```
iii trigger openwiki::generate --json '{"repo_url":"https://github.com/owner/repo"}'
iii trigger openwiki::status   --json '{"id":"<wiki_id>"}'
iii trigger openwiki::pages    --json '{"id":"<wiki_id>"}'
iii trigger openwiki::page     --json '{"id":"<wiki_id>","slug":"overview"}'
iii trigger openwiki::search   --json '{"id":"<wiki_id>","q":"config"}'
```

## Verify locally

Unit tests (no engine needed):

```
npm test
```

Smoke test against a running engine. The heuristic tier needs no provider, so
this works on a bare engine:

```
iii trigger openwiki::generate --json '{"repo_url":"https://github.com/octocat/Hello-World"}'
iii trigger openwiki::status   --json '{"id":"<wiki_id>"}'   # poll until phase = ready
iii trigger openwiki::pages    --json '{"id":"<wiki_id>"}'
iii trigger openwiki::lint     --json '{"id":"<wiki_id>"}'
iii trigger openwiki::refresh  --json '{"id":"<wiki_id>"}'   # unchanged HEAD -> {"refresh":"up_to_date"}
```

With `llm-router` + a provider the pages are model-written; with the `harness`
stack they are agent-explored and line-cited. Without either, the heuristic tier
still produces a browsable wiki.

## Functions

- `openwiki::generate { repo_url, model? }` start a wiki build; returns `{ wiki_id, status }`.
- `openwiki::status { id }` generation progress.
- `openwiki::wikis` list generated wikis.
- `openwiki::models` models available via llm-router (for the UI's picker) plus the configured default.
- `openwiki::wiki { id }` wiki metadata.
- `openwiki::pages { id }` page index.
- `openwiki::page { id, slug }` a page's markdown and metadata.
- `openwiki::search { id, q }` keyword search over a wiki.
- `openwiki::refresh { id }` pull and regenerate only the pages whose source changed (incremental).
- `openwiki::lint { id }` validate every page citation against the clone; flag thin pages.

Scoped readers the harness calls to explore a clone (jailed to one wiki's clone):

- `openwiki::src::read { id, path, from?, to? }` read a file, optionally a line window.
- `openwiki::src::list { id, dir? }` list files (path, language, priority).
- `openwiki::src::grep { id, pattern, max? }` search file contents.

Answer, visualize, export:

- `openwiki::ask { id, q, mode? }` cited Q&A over the wiki (`mode` = `fast` router, `deep` harness; heuristic fallback).
- `openwiki::diagram { id, kind? }` a Mermaid architecture diagram (LLM, with a deterministic structural fallback).
- `openwiki::export-agents-md { id, base_url? }` the `AGENTS.md` / `CLAUDE.md` pointer block for a repo.

MCP: openwiki registers `openwiki::read-wiki-structure`, `read-wiki-contents`, and
`ask-question`, which the `mcp` bridge advertises (as `openwiki__read-wiki-structure`
etc.) so any MCP client can browse and query a wiki.

HTTP triggers mirror the read/generate functions under `/openwiki/api/*`, and
`/openwiki` serves the UI — page citations deep-link to source at the pinned
commit, diagrams render inline in the page, generation progress streams live
(SSE), and an **Ask** panel answers cited questions.

## How generation works

1. Clone the repo (via the `shell` worker) and inventory its files.
2. The harness explores the clone and plans a categorized, nested outline. The
   page budget scales with repo size (roughly 3-6 pages for a tiny repo up to
   ~48 for a large or doc-heavy one) and follows the repo's own docs index
   (`llms.txt` / a `docs/` tree) when present.
3. Page writers run as named child sessions in parallel; each reads the relevant
   source files and writes markdown with `[[wiki-links]]` and `path:line`
   citations. Progress streams to the UI as each page lands.
4. Pages are stored in iii-state behind a lightweight page index (so large wikis
   never enumerate page bodies), and the last commit + a page-set content hash
   are recorded.

## How refresh works

`openwiki::refresh` is incremental, not a full rebuild:

1. Pull the clone and read the new `HEAD`. If it matches the recorded commit, stop.
2. `git diff` the recorded commit against the new one for changed paths.
3. Map changed paths to affected pages through the file→page index; regenerate
   only those pages.
4. Gate on a content hash so an identical result does not churn the wiki — no
   empty updates on a nightly cron.

## Configuration

- Model: pick one in the browser UI's generate form (populated from the router's
  live catalog, grouped by provider), pass `model` to `openwiki::generate`, or set
  `OPENWIKI_MODEL`. Any model the router advertises works. Default
  `claude-haiku-4-5-20251001`.
- Providers / credentials: live in the `llm-router` config, never in this worker.
  Add a provider (anthropic, openai, xai, codex, ...) through the console's harness
  onboarding; openwiki's picker then shows its models automatically.

## Notes for authors

Two details that a worker of this shape must get right:

- Register all functions synchronously right after `registerWorker`. A top-level
  `await` between them lets the worker finish its handshake and register with
  zero functions.
- If you serve an inline browser UI from a template literal, use `String.raw`.
  A plain template literal strips regex backslashes and breaks the served
  script.

## License

Apache-2.0

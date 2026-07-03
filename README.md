# openwiki

An iii worker that builds and maintains a source-grounded, interlinked markdown
wiki for a code repository, and serves a browser UI to read and search it.

Point it at a git repo. A language model reads the source, plans a categorized
outline, writes one page per topic with file citations, and keeps the wiki
current from git diffs. Routing, scheduling, and the HTTP surface run on iii
primitives; the model is a wiki maintainer, not a chatbot.

Not published to the iii registry yet. Run it locally against a running engine.

## Dependencies

openwiki calls other workers rather than embedding their logic. A running engine
must have `llm-router` installed and at least one model provider configured:

```
iii worker add llm-router
```

- `llm-router` plus a configured provider (anthropic, openai, or xai). openwiki
  calls `router::complete` with a model id; the router owns the provider choice
  and the credential. Set the key in the llm-router config
  (`providers.<name>.api_key`), not here.
- `iii-http` (engine builtin) serves the browser UI and JSON API under
  `/openwiki`.
- `iii-cron` (engine builtin) runs the nightly refresh.
- `git` on PATH, used to clone and diff repositories.

## Local setup

```
git clone https://github.com/iii-experimental/openwiki
cd openwiki
npm install
```

Start the engine in one terminal (from a directory that has a `config.yaml`),
then run the worker in another:

```
III_URL=ws://127.0.0.1:49134 node src/index.mjs
```

Environment:

- `III_URL` engine WebSocket (default `ws://localhost:49134`).
- `OPENWIKI_MODEL` default generation model (default `claude-sonnet-4-6`).
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

## Functions

- `openwiki::generate { repo_url, model? }` start a wiki build; returns `{ wiki_id, status }`.
- `openwiki::status { id }` generation progress.
- `openwiki::wikis` list generated wikis.
- `openwiki::wiki { id }` wiki metadata.
- `openwiki::pages { id }` page index.
- `openwiki::page { id, slug }` a page's markdown and metadata.
- `openwiki::search { id, q }` keyword search over a wiki.
- `openwiki::refresh { id }` git-pull and regenerate changed pages.

HTTP triggers mirror these under `/openwiki/api/*`, and `/openwiki` serves the UI.

## How generation works

1. Clone the repo and inventory its files.
2. One model call plans a categorized outline of 5 to 15 pages.
3. Page writers run in parallel; each reads the relevant source files and writes
   markdown with `[[wiki-links]]` and `path:line` citations.
4. Pages and the index are stored under `OPENWIKI_DATA`; the last commit is
   recorded so `openwiki::refresh` can regenerate only changed pages.

## Configuration

- Model: pass `model` to `openwiki::generate`, or set `OPENWIKI_MODEL`. Any model
  the router knows works, for example `xai/...` or `codex/...`.
- Credential: lives in the `llm-router` config, not in this worker.

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

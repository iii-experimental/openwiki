---
name: openwiki
description: Generate and browse a source-grounded markdown wiki for a git repository.
---

# openwiki

Builds and maintains a categorized, interlinked markdown wiki for a code
repository. A model reads the source, plans an outline, writes one page per
topic with file citations, and refreshes pages from git diffs. Wiki content is
stored in iii-state; a browser UI and JSON API are served under `/openwiki`.

## When to Use

- You want a navigable wiki that explains a repository, grounded in its actual
  source with `path:line` citations.
- An agent needs durable repo context beyond a single instructions file.
- You want the wiki to stay current as the repository changes.

## Boundaries

- Reads and clones public git repositories; it does not modify them.
- Generation quality depends on the routed model. It calls `router::complete`;
  the provider and credential live in the `llm-router` config, not here.
- Not a chatbot. It maintains structured pages rather than answering free-form
  questions.
- Cloned repositories are ephemeral working copies on local disk; the wiki
  itself lives in iii-state.

## Functions

- `openwiki::generate { repo_url, model? }` — start a wiki build; returns
  `{ wiki_id, status }`. Poll `openwiki::status`.
- `openwiki::status { id }` — generation progress.
- `openwiki::wikis` — list generated wikis.
- `openwiki::wiki { id }` — wiki metadata.
- `openwiki::pages { id }` — page index.
- `openwiki::page { id, slug }` — a page's markdown and metadata.
- `openwiki::search { id, q }` — keyword search over a wiki.
- `openwiki::refresh { id }` — git-pull and regenerate changed pages.

The same operations are exposed over HTTP under `/openwiki/api/*`, and
`/openwiki` serves the browser UI.

## Reactive triggers

- `openwiki::cron::nightly` runs daily and refreshes every wiki from its
  repository's latest commits.
- `openwiki::on-config-change` reloads the default model and page-writer
  concurrency when the `openwiki` configuration entry changes.

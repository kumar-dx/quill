# AGENTS.md

## Project overview

Quill is a static, browser-only proof of concept for exploring the MetaX Django
schema and drafting PostgreSQL `SELECT` queries. It is designed to run locally
or from GitHub Pages. It never connects to or executes against a database.

The source schema repository is normally located at:

```text
/Users/rohit.kumar/Documents/drivex/metax-database
```

The generated snapshot is committed at `data/metax-context.json`. It contains
model, field, relationship, index, constraint, migration, glossary, and source
metadata extracted from MetaX.

## Architecture

- `index.html`: application shell, sidebar, chat UI, and API settings modal.
- `styles.css`: minimalist responsive theme, including light and dark modes.
- `app.js`: catalog loading, lexical retrieval, AI requests, SQL presentation,
  theme state, modal behavior, and mobile navigation.
- `data/metax-context.json`: generated MetaX schema snapshot used at runtime.
- `scripts/export_metax_context.py`: read-only AST exporter for MetaX models and
  migrations. It must not import Django or access database credentials.
- `scripts/build_pages.py`: builds the public `_site` artifact from an explicit
  allowlist of runtime files.
- `.github/workflows/deploy-pages.yml`: deploys `_site` to GitHub Pages from the
  `main` branch.

There is no package manager, bundler, backend, or framework. Keep runtime asset
URLs relative so the project continues to work under a GitHub Pages repository
subpath such as `/Quill/`.

## Answer modes

### Local retrieval

Local retrieval is deterministic browser-side JavaScript, not an offline LLM.
It tokenizes the question, removes stop words, scores model metadata, applies
the business glossary, and adds foreign-key neighbors. Migration search is
enabled for history-related questions. The current POC has curated SQL/answer
templates for quality-rating and procurement-inspection examples; other local
questions return ranked schema evidence rather than arbitrary generated SQL.

The Explore Schema sidebar is a separate catalog browser. With no filter it
must list every model alphabetically; with a filter it must show all matching
models ranked by relevance.

### AI answer

AI mode reuses the local retrieval stage, sends only the selected schema
context and question to the OpenAI Responses API, and requests structured JSON.
The API key is bring-your-own-key and must remain in JavaScript memory only.
Never store it in cookies, `localStorage`, `sessionStorage`, source files,
workflow variables, or the generated site.

The API settings action is enabled only when both the key and model inputs are
non-empty. Credentials are not validated until the first API request; invalid
keys or model names should surface the API error without falling back silently.

## Security and data boundaries

- Never add database connectivity or SQL execution to this static POC.
- Generate PostgreSQL `SELECT` drafts only. Do not generate or enable mutation,
  DDL, or multi-statement execution paths.
- Do not read `.env` files, secrets, or database credentials during export.
- Treat generated SQL as a draft requiring human review.
- `data/metax-context.json` is part of the public Pages artifact. Anyone who can
  access the site can download it. `noindex` metadata is not access control.
- A shared production API key requires an authenticated server-side proxy;
  GitHub Pages cannot protect server secrets.

## Design requirements

- Preserve the restrained minimalist visual direction.
- Maintain both light and dark themes and test contrast in each.
- Keep default text readable; avoid reducing body/interface copy below the
  established typography scale.
- Keep desktop and mobile layouts functional. On mobile, the sidebar must have
  an explicit close control and respect dynamic viewport height/safe areas.
- The schema list is the scrollable sidebar region. The API settings button
  must remain fully visible and outside that scrolling region.
- Preserve keyboard behavior: Enter submits, Shift+Enter adds a line, Cmd/Ctrl+K
  focuses the composer, and Escape closes overlays/navigation.

## Common commands

Run locally:

```bash
python3 -m http.server 8080
```

Regenerate the MetaX context:

```bash
python3 scripts/export_metax_context.py \
  --repo /Users/rohit.kumar/Documents/drivex/metax-database \
  --output data/metax-context.json
```

Build the exact GitHub Pages artifact:

```bash
python3 scripts/build_pages.py --output _site
python3 -m http.server 8080 --directory _site
```

Basic validation:

```bash
node --check app.js
python3 -m py_compile scripts/build_pages.py scripts/export_metax_context.py
python3 -m json.tool data/metax-context.json >/dev/null
git diff --check
```

## Change guidelines

- Make focused edits in the existing HTML/CSS/JavaScript unless the requested
  feature genuinely requires a different architecture.
- Do not introduce a dependency or build framework for a change that can be
  implemented directly.
- Escape all question, schema, source, and API-derived values before inserting
  them into HTML.
- Keep the public artifact allowlist in `scripts/build_pages.py` synchronized
  when adding a required runtime asset.
- Regenerate the schema snapshot only when MetaX source context changed or the
  user explicitly requests a refresh; the file is large and generated.
- Do not commit, push, publish, or change GitHub Pages settings unless the user
  explicitly requests that external action.

## Verification expectations

For JavaScript or UI changes, run `node --check app.js`, build `_site`, and
perform a local browser check when preview tooling is available. Verify desktop
and mobile layout, light and dark themes, modal state, sidebar scrolling, and
the affected interaction. For exporter changes, compile the script, regenerate
to a temporary file first, validate the JSON, and inspect model/field/migration
counts before replacing the committed snapshot.

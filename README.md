# Quill

Quill is a static proof-of-concept for asking questions about the MetaX Django
schema and drafting PostgreSQL queries. It indexes model and migration source
into a JSON snapshot, retrieves relevant schema fragments in the browser, and
optionally sends those fragments to the OpenAI Responses API.

Quill never connects to or executes against a database.

## Generate the MetaX context

From the Quill directory:

```bash
python3 scripts/export_metax_context.py \
  --repo /Users/rohit.kumar/Documents/drivex/metax-database \
  --output data/metax-context.json
```

The exporter uses Python AST parsing. It does not import Django, access `.env`,
or require database credentials.

Regenerate the JSON whenever MetaX models or migrations change. The snapshot
records the source Git commit so answers can identify their schema version.

## Run locally

Browsers block `fetch()` when opening the page directly with `file://`, so use a
small static server:

```bash
python3 -m http.server 8080
```

Open <http://localhost:8080>.

## Answer modes

### Local retrieval

Works without an API key. Quill searches table names, field names, help text,
relationships, migration summaries, and a small business glossary. Two example
questions also have deterministic POC answers.

### AI answer

Open **API settings**, enter an OpenAI development API key, and select a model.
The key is held only in JavaScript memory; Quill does not write it to disk,
cookies, `localStorage`, or `sessionStorage`. Closing or refreshing the tab
clears it.

Because this is a static browser-only POC, requests are made directly to the
API. Do not distribute this build with a permanent or privileged key. A shared
or production deployment should use a small server-side proxy that owns the
secret and applies authentication, rate limits, and audit logging.

## Safety boundary

- Generated SQL is limited by instruction to PostgreSQL `SELECT` drafts.
- Table names returned by the model are checked against the JSON catalog.
- SQL is not executed.
- The POC is not a substitute for query review or business validation.

## Files

```text
index.html                         Application shell
styles.css                        Responsive visual design
app.js                            Search, retrieval, API, and rendering logic
data/metax-context.json           Generated schema snapshot
scripts/export_metax_context.py   Read-only MetaX source exporter
```

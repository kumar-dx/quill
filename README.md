# Quill

Quill is a static proof-of-concept for asking questions about the MetaX Django
and ERPX Frappe schemas and drafting read-only SQL. It indexes source metadata
into separate JSON snapshots, retrieves relevant schema fragments in the
browser, and optionally sends those fragments to the OpenAI Responses API.

The context picker also provides a **Shared** view. It combines both committed
snapshots in the browser and tags every model and change with its source system;
it does not duplicate the data into a third generated file.

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

## Generate the ERPX context

```bash
python3 scripts/export_erpx_context.py \
  --repo /Users/rohit.kumar/Documents/drivex/erpx \
  --output data/erpx-context.json
```

This exporter reads Frappe DocType JSON, Custom Field fixtures, and patch
manifests. It does not import Frappe, read site configuration or `.env` files,
or connect to MariaDB. By default it includes every app under
`frappe-bench/apps`; pass `--apps drivex erpnext frappe` to limit the snapshot.

## Run locally

Browsers block `fetch()` when opening the page directly with `file://`, so use a
small static server:

```bash
python3 -m http.server 8080
```

Open <http://localhost:8080>.

## Deploy to GitHub Pages

Quill is packaged and deployed by the workflow in
`.github/workflows/deploy-pages.yml`. The build contains only the browser app
and generated schema context; development scripts and repository metadata are
not published.

1. Create a GitHub repository and push this project to its `main` branch.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`, or run **Deploy Quill to GitHub Pages** from the Actions tab.
4. Open `https://<owner>.github.io/<repository>/` after the deployment succeeds.

All runtime URLs are relative, so the app works at a GitHub Pages project
subpath without a repository-name setting. To check the exact deployment
artifact locally:

```bash
python3 scripts/build_pages.py --output _site
python3 -m http.server 8080 --directory _site
```

### Publishing warning

`data/metax-context.json` and `data/erpx-context.json` contain the schema
snapshots. Anyone who can open the Pages site can download those files. Only
publish them to an audience that is allowed to see the schema; `noindex`
metadata discourages search indexing but is not access control.

GitHub Pages has no server runtime in which to hide an OpenAI API key. Quill's
optional AI mode therefore remains bring-your-own-key and keeps the key only in
the current tab's memory. Do not embed a shared key in JavaScript, the workflow,
or the generated site. A shared AI deployment needs an authenticated server-side
proxy.

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

- Generated SQL is limited by instruction to PostgreSQL or MariaDB `SELECT`
  drafts, according to the selected context.
- Shared-context answers may compare the two schemas, but do not generate
  cross-database joins between MetaX and ERPX.
- Table names returned by the model are checked against the JSON catalog.
- SQL is not executed.
- The POC is not a substitute for query review or business validation.

## Files

```text
index.html                         Application shell
styles.css                        Responsive visual design
app.js                            Search, retrieval, API, and rendering logic
data/metax-context.json           Generated schema snapshot
data/erpx-context.json            Generated Frappe/ERPNext schema snapshot
scripts/export_metax_context.py   Read-only MetaX source exporter
scripts/export_erpx_context.py    Read-only ERPX DocType exporter
scripts/build_pages.py            GitHub Pages artifact builder
.github/workflows/deploy-pages.yml  GitHub Pages deployment workflow
```

const state = {
  catalog: null,
  catalogKey: "metax",
  apiKey: "",
  model: "gpt-6-astra",
  localOnly: true,
  busy: false,
};

const el = (id) => document.getElementById(id);
const elements = {
  welcome: el("welcome"),
  messages: el("messages"),
  chatScroll: el("chatScroll"),
  form: el("questionForm"),
  input: el("questionInput"),
  send: el("sendButton"),
  settingsModal: el("settingsModal"),
  apiKey: el("apiKey"),
  modelName: el("modelName"),
  saveSettings: el("saveSettings"),
  apiStatusDot: el("apiStatusDot"),
  modeLabel: el("modeLabel"),
  schemaSearch: el("schemaSearch"),
  schemaResults: el("schemaResults"),
  sidebar: el("sidebar"),
  mobileMenu: el("mobileMenu"),
  themeToggle: el("themeToggle"),
  catalogSelect: el("catalogSelect"),
};

const CATALOGS = {
  metax: {
    label: "MetaX",
    path: "data/metax-context.json",
    dialect: "PostgreSQL",
    migrationsLabel: "migrations",
  },
  erpx: {
    label: "ERPX",
    path: "data/erpx-context.json",
    dialect: "MariaDB",
    migrationsLabel: "patches",
  },
  shared: {
    label: "Shared",
    paths: ["data/metax-context.json", "data/erpx-context.json"],
    dialect: "PostgreSQL + MariaDB",
    migrationsLabel: "changes",
  },
};

function activeCatalogConfig() {
  return CATALOGS[state.catalogKey];
}

const SUGGESTIONS = {
  metax: [
    ["In which table can I get the quality rating of a vehicle?", "Where is vehicle quality rating stored?"],
    ["Give me SQL for vehicles procured in October 2026 whose inspection was done by rohit.kumar@drivex.in", "Procured vehicles by inspector and month"],
    ["How are procurement leads, inspections, procured vehicles, and users related?", "Explain the procurement join path"],
    ["Which migration introduced the quality_score field on inspections?", "Find when a field was introduced"],
  ],
  erpx: [
    ["Which DocType stores the item master and its purchasing details?", "Locate ERPNext item metadata"],
    ["Draft a MariaDB SELECT for active stock items and their item groups", "Query active inventory items"],
    ["How are Purchase Order, Purchase Order Item, and Supplier related?", "Trace a Frappe child-table join"],
    ["Which patches mention purchase orders?", "Search ERPX patch history"],
  ],
  shared: [
    ["Where is vehicle and item information represented across MetaX and ERPX?", "Compare models across both systems"],
    ["Map MetaX procurement concepts to ERPX purchasing DocTypes", "Find conceptual integration points"],
    ["Compare users and ownership fields in MetaX and ERPX", "Review identity relationships"],
    ["Which schema should answer a vehicle procurement question?", "Choose the correct source system"],
  ],
};

function updateCatalogCopy() {
  const catalogConfig = activeCatalogConfig();
  el("appSubtitle").textContent = `${catalogConfig.label} intelligence`;
  el("pageTitle").textContent = `Ask the ${catalogConfig.label} schema`;
  el("welcomeOverline").textContent = `${catalogConfig.label} SCHEMA COPILOT`;
  el("welcomeCopy").textContent = `Quill searches the ${catalogConfig.label} model and change catalog, traces relationships, and drafts ${catalogConfig.dialect} SELECT queries without touching a database.`;
  document.querySelectorAll(".suggestion").forEach((button, index) => {
    const suggestion = SUGGESTIONS[state.catalogKey][index];
    button.dataset.question = suggestion[0];
    button.querySelector("small").textContent = suggestion[1];
  });
}

function setSidebarOpen(open) {
  elements.sidebar.classList.toggle("open", open);
  elements.mobileMenu.setAttribute("aria-expanded", String(open));
}

function currentTheme() {
  return document.documentElement.dataset.theme || "light";
}

function renderThemeToggle() {
  const dark = currentTheme() === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  elements.themeToggle.setAttribute("aria-label", label);
  elements.themeToggle.setAttribute("title", label);
  elements.themeToggle.innerHTML = dark
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.2A8 8 0 0 1 8.8 3.8 8.5 8.5 0 1 0 20.2 15.2Z"/></svg>';
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("quill_theme", next);
  renderThemeToggle();
}

const STOP_WORDS = new Set([
  "a", "across", "an", "and", "are", "as", "at", "be", "both", "by", "can", "compare", "comparison", "do", "for",
  "from", "get", "give", "how", "i", "in", "is", "it", "me", "of", "on",
  "or", "schema", "schemas", "that", "the", "this", "to", "was", "what", "when", "where", "which",
  "who", "whose", "with", "would", "you"
]);

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function tokenVariants(token) {
  return token.length > 3 && token.endsWith("s") ? [token, token.slice(0, -1)] : [token];
}

function searchableModel(model) {
  return [
    model.context,
    model.app,
    model.name,
    model.table,
    model.description,
    ...(model.fields || []).flatMap((field) => [
      field.name,
      field.column,
      field.type,
      field.help_text,
      field.related_name,
      field.references?.model,
      field.references?.table,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
}

function modelKey(model) {
  return `${model.context || state.catalogKey}:${model.table}`;
}

function scoreModels(question, limit = 8) {
  if (!state.catalog) return [];
  const normalized = question.toLowerCase();
  const tokens = tokenize(question);
  const glossaryTerms = Object.entries(state.catalog.glossary || {})
    .filter(([term]) => normalized.includes(term.toLowerCase()))
    .flatMap(([, values]) => values);

  const scored = state.catalog.models.map((model) => {
    const haystack = searchableModel(model);
    let score = 0;
    for (const token of tokens) {
      const variants = tokenVariants(token);
      if (variants.some((variant) => model.table.toLowerCase() === variant || model.name.toLowerCase() === variant)) score += 30;
      else if (variants.some((variant) => model.table.toLowerCase().includes(variant) || model.name.toLowerCase().includes(variant))) score += 9;
      if ((model.fields || []).some((field) => variants.some((variant) => field.name.toLowerCase() === variant || field.column?.toLowerCase() === variant))) score += 12;
      else if (variants.some((variant) => haystack.includes(variant))) score += 2;
    }
    for (const target of glossaryTerms) {
      const [table, field] = String(target).split(".");
      if (model.table === table) score += 22;
      if (field && (model.fields || []).some((candidate) => candidate.column === field || candidate.name === field)) score += 10;
    }
    return { model, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);

  const selectedEntries = scored.slice(0, limit);
  const wantsSharedCoverage = state.catalogKey === "shared"
    && /\b(both|across|compare|comparison|map|mapping|metax|erpx)\b/i.test(question);
  if (wantsSharedCoverage) {
    for (const contextKey of ["metax", "erpx"]) {
      if (selectedEntries.some((entry) => entry.model.context === contextKey)) continue;
      const candidate = scored.find((entry) => entry.model.context === contextKey);
      if (candidate) selectedEntries.splice(Math.max(0, selectedEntries.length - 1), 1, candidate);
    }
  }
  const selected = selectedEntries.map((entry) => entry.model);
  const selectedTables = new Set(selected.map(modelKey));
  const neighbors = [];

  for (const model of state.catalog.models) {
    const connected = (model.fields || []).some((field) =>
      selectedTables.has(`${model.context || state.catalogKey}:${field.references?.table}`)
    );
    const selectedReferencesIt = selected.some((candidate) =>
      (candidate.context || state.catalogKey) === (model.context || state.catalogKey)
      && (candidate.fields || []).some((field) => field.references?.table === model.table)
    );
    if ((connected || selectedReferencesIt) && !selectedTables.has(modelKey(model))) neighbors.push(model);
  }

  return [...selected, ...neighbors.slice(0, Math.max(0, 10 - selected.length))].slice(0, 10);
}

function filterSchemaModels(query = "") {
  if (!state.catalog) return [];
  const normalized = query.trim().toLowerCase();
  const models = [...state.catalog.models];

  if (!normalized) {
    return models.sort((a, b) => a.table.localeCompare(b.table));
  }

  const tokens = tokenize(normalized);
  return models
    .map((model) => {
      const table = model.table.toLowerCase();
      const name = model.name.toLowerCase();
      const haystack = searchableModel(model);
      let score = haystack.includes(normalized) ? 20 : 0;
      if (table === normalized || name === normalized) score += 100;
      else if (table.startsWith(normalized) || name.startsWith(normalized)) score += 50;
      score += tokens.reduce((total, token) => total + (tokenVariants(token).some((variant) => haystack.includes(variant)) ? 4 : 0), 0);
      return { model, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.model.table.localeCompare(b.model.table) || (a.model.context || "").localeCompare(b.model.context || ""))
    .map((entry) => entry.model);
}

function scoreMigrations(question, limit = 6) {
  if (!state.catalog) return [];
  const tokens = tokenize(question);
  return (state.catalog.migrations || [])
    .map((migration) => {
      const haystack = JSON.stringify(migration).toLowerCase();
      return { migration, score: tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.migration);
}

function compactModel(model) {
  return {
    context_system: model.context || state.catalogKey,
    dialect: CATALOGS[model.context || state.catalogKey]?.dialect,
    app: model.app,
    model: model.name,
    table: model.table,
    description: model.description || "",
    fields: (model.fields || []).map((field) => ({
      name: field.name,
      column: field.column,
      type: field.type,
      primary_key: Boolean(field.primary_key),
      stored: field.stored,
      null: field.null,
      required: field.required,
      choices: field.choices,
      help_text: field.help_text,
      references: field.references,
      dynamic_reference_field: field.dynamic_reference_field,
    })),
    indexes: model.indexes || [],
    constraints: model.constraints || [],
    storage: model.storage,
    source: model.source,
  };
}

function buildContext(question) {
  const models = scoreModels(question);
  const wantsHistory = /migration|introduced|changed|rename|history|added|removed/i.test(question);
  const migrations = wantsHistory ? scoreMigrations(question) : [];
  return { models, migrations };
}

function localAnswer(question, context) {
  const lower = question.toLowerCase();
  const tables = context.models.map((model) => model.table);
  const sourceModels = state.catalogKey === "shared"
    ? [
        context.models.find((model) => model.context === "metax"),
        context.models.find((model) => model.context === "erpx"),
        ...context.models,
      ].filter((model, index, models) => model && models.indexOf(model) === index).slice(0, 5)
    : context.models.slice(0, 5);
  const sources = sourceModels.map((model) => `${model.context ? `${CATALOGS[model.context].label}: ` : ""}${model.source}`);

  if (state.catalogKey === "metax" && (/quality.*rating|rating.*quality/.test(lower))) {
    return {
      answer: "For procurement inspections, use inspections.quality_rating_id and join quality_rating_configs.id to obtain the configured label and order. inspections.quality_score stores the raw NQS score, while inspections.rating is a separate legacy/free-text field. For DTC quality control, dtc_quality_checks.qc_rating is the relevant rating. The intended table depends on which stage of the vehicle lifecycle you mean.",
      sql: "SELECT\n    i.inspection_id,\n    i.vehicle_id,\n    qrc.label AS quality_rating,\n    qrc.\"order\" AS rating_order,\n    i.quality_score\nFROM inspections AS i\nLEFT JOIN quality_rating_configs AS qrc\n    ON qrc.id = i.quality_rating_id\nWHERE i.vehicle_id = :vehicle_id;",
      tables: ["inspections", "quality_rating_configs", "dtc_quality_checks"],
      columns: ["inspections.quality_rating_id", "inspections.quality_score", "inspections.rating", "dtc_quality_checks.qc_rating"],
      assumptions: ["The primary interpretation is procurement inspection quality."],
      ambiguities: ["Quality rating may refer to procurement inspection rating or DTC QC rating."],
      sources,
    };
  }

  if (state.catalogKey === "metax" && /procured|procurement/.test(lower) && /inspection|inspected/.test(lower) && /sql|query|fetch|vehicles/.test(lower)) {
    const year = question.match(/\b(20\d{2})\b/)?.[1] || "<year>";
    return {
      answer: "The normalized path is procured_vehicles → procurement_leads → inspections → users, with vehicles joined from procured_vehicles. The query below uses a half-open date interval so it remains index-friendly and avoids timestamp boundary errors.",
      sql: `SELECT\n    v.vehicle_id,\n    v.registration_number,\n    pv.procurement_id,\n    pv.procured_date,\n    i.inspection_id,\n    u.email AS inspected_by\nFROM procured_vehicles AS pv\nJOIN vehicles AS v\n    ON v.vehicle_id = pv.vehicle_id\nJOIN procurement_leads AS pl\n    ON pl.procurement_lead_id = pv.procurement_lead_id\nJOIN inspections AS i\n    ON i.inspection_id = pl.inspection_id\nJOIN users AS u\n    ON u.user_id = i.inspected_by_id\nWHERE pv.procured_date >= DATE '${year}-10-01'\n  AND pv.procured_date < DATE '${year}-11-01'\n  AND LOWER(u.email) = LOWER('rohit.kumar@drivex.in');`,
      tables: ["procured_vehicles", "vehicles", "procurement_leads", "inspections", "users"],
      columns: ["procured_vehicles.procured_date", "inspections.inspected_by_id", "users.email"],
      assumptions: [year === "<year>" ? "The year was not provided and must be supplied." : `October means October ${year}.`],
      ambiguities: [],
      sources,
    };
  }

  if (state.catalogKey === "shared") {
    const matches = ["metax", "erpx"]
      .map((contextKey) => context.models.find((model) => model.context === contextKey))
      .filter(Boolean);
    if (matches.length) {
      const descriptions = matches.map((model) => `${CATALOGS[model.context].label}: ${model.table} (${model.app}.${model.name})`);
      const sharedTables = [...new Set([...matches.map((model) => model.table), ...tables])].slice(0, 6);
      const columns = matches.flatMap((model) =>
        (model.fields || []).slice(0, 4).map((field) => `${model.table}.${field.column || field.name}`)
      );
      return {
        answer: `The closest matches by source system are ${descriptions.join("; ")}. This shared local result compares ranked evidence; connect an API key for a synthesized cross-system mapping.`,
        sql: "",
        tables: sharedTables,
        columns,
        assumptions: ["MetaX and ERPX are separate databases and are compared conceptually."],
        ambiguities: matches.length < 2 ? ["Only one source system had a strong lexical match."] : [],
        sources,
      };
    }
  }

  const lead = context.models[0];
  if (!lead) {
    return {
      answer: "I could not find a strong schema match. Try naming the business process, lifecycle stage, or a likely table or field.",
      sql: "",
      tables: [], columns: [], assumptions: [], ambiguities: ["No matching model was found in the current snapshot."], sources: [],
    };
  }

  const relevantFields = (lead.fields || []).slice(0, 8).map((field) => `${lead.table}.${field.column || field.name}`);
  return {
    answer: `The closest match is ${lead.table}${lead.context ? ` in ${CATALOGS[lead.context].label}` : ""}, represented by ${lead.app}.${lead.name}. Relevant fields include ${relevantFields.slice(0, 5).join(", ")}. Connect an API key for a synthesized answer and relationship-aware SQL.`,
    sql: "",
    tables: tables.slice(0, 5),
    columns: relevantFields,
    assumptions: ["This is a local lexical schema match, not an AI-generated interpretation."],
    ambiguities: context.models.length > 1 ? ["Several models matched; review the evidence before selecting a table."] : [],
    sources,
  };
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    sql: { type: "string" },
    tables: { type: "array", items: { type: "string" } },
    columns: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    ambiguities: { type: "array", items: { type: "string" } },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "sql", "tables", "columns", "assumptions", "ambiguities", "sources"],
  additionalProperties: false,
};

async function askOpenAI(question, context) {
  const catalogConfig = activeCatalogConfig();
  const schemaContext = {
    snapshot: state.catalog.version,
    models: context.models.map(compactModel),
    migrations: context.migrations,
  };

  const instructions = [
    `You are Quill, a ${catalogConfig.label} ${catalogConfig.dialect} schema assistant.`,
    "Use only the supplied schema context. Never invent a table, column, relationship, or business definition.",
    "When a question is ambiguous, explain the alternatives instead of silently choosing one.",
    ...(state.catalogKey === "shared"
      ? ["Each model identifies its context_system and SQL dialect. For a question within one system, generate at most one SELECT statement in that system's dialect. For cross-system questions, compare or map the schemas conceptually and return an empty sql value; never invent a direct cross-database join."]
      : [`Generate ${catalogConfig.dialect} SELECT queries only.`]),
    "Never generate mutations, DDL, multiple statements, or database execution instructions.",
    "Do not query models whose storage.physical_table is false.",
    ...(["erpx", "shared"].includes(state.catalogKey) ? ["In ERPX, Frappe Link fields reference the target DocType name column; child tables join through parent, parenttype, and parentfield."] : []),
    "Prefer parameterized values where useful. Use half-open date ranges. State missing filters such as year as assumptions or ambiguities.",
    "The SQL is a draft and will not be executed. Include source paths from the supplied context.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${state.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: state.model,
      input: [
        { role: "system", content: [{ type: "input_text", text: instructions }] },
        { role: "user", content: [{ type: "input_text", text: `Schema context:\n${JSON.stringify(schemaContext)}\n\nQuestion:\n${question}` }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "schema_answer",
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error?.message || `OpenAI request failed with ${response.status}`);
  }

  const payload = await response.json();
  const outputText = payload.output
    ?.flatMap((item) => item.content || [])
    .find((content) => content.type === "output_text")?.text;

  if (!outputText) throw new Error("The API response did not contain an answer.");
  return JSON.parse(outputText);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addUserMessage(question) {
  const node = document.createElement("div");
  node.className = "message user-message";
  node.innerHTML = `<div class="message-body">${escapeHtml(question)}</div>`;
  elements.messages.appendChild(node);
}

function validateAnswer(answer) {
  const knownTables = new Set((state.catalog?.models || []).map((model) => model.table));
  const unknown = (answer.tables || []).filter((table) => !knownTables.has(table) && !table.startsWith("analytics."));
  return { valid: unknown.length === 0, unknown };
}

function addAnswer(answer, mode) {
  const validation = validateAnswer(answer);
  const node = document.createElement("div");
  node.className = "message assistant-message";
  const chips = [...new Set([...(answer.tables || []), ...(answer.columns || []).slice(0, 5)])];
  const sql = answer.sql?.trim();
  const assumptions = (answer.assumptions || []).join(" ") || "None stated.";
  const ambiguities = (answer.ambiguities || []).join(" ") || "None detected.";
  node.innerHTML = `
    <div class="avatar">Q</div>
    <div class="message-body">
      <article class="answer-card">
        <div class="answer-main">
          <h3>${mode === "local" ? "Schema match" : "Answer"}</h3>
          <p>${escapeHtml(answer.answer)}</p>
          <div class="evidence-row">${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join("")}</div>
        </div>
        ${sql ? `<div class="sql-panel">
          <div class="sql-header"><span><i class="validation-dot" style="background:${validation.valid ? "var(--green)" : "var(--danger)"}"></i>${validation.valid ? "Schema-checked · not executed" : "Review identifiers · not executed"}</span><button class="copy-button" type="button">Copy SQL</button></div>
          <pre class="sql-code"><code>${escapeHtml(sql)}</code></pre>
        </div>` : ""}
        <div class="answer-footer">
          <div class="answer-meta"><strong>Assumptions</strong><span>${escapeHtml(assumptions)}</span></div>
          <div class="answer-meta"><strong>Ambiguities</strong><span>${escapeHtml(ambiguities)}</span></div>
        </div>
        ${(answer.sources || []).length ? `<div class="answer-meta" style="border-top:1px solid var(--border-soft)"><strong>Model evidence</strong><span>${answer.sources.map(escapeHtml).join(" · ")}</span></div>` : ""}
      </article>
    </div>`;
  node.querySelector(".copy-button")?.addEventListener("click", async (event) => {
    await navigator.clipboard.writeText(sql);
    event.currentTarget.textContent = "Copied";
    setTimeout(() => { event.currentTarget.textContent = "Copy SQL"; }, 1400);
  });
  elements.messages.appendChild(node);
}

function addError(error) {
  const node = document.createElement("div");
  node.className = "message assistant-message";
  node.innerHTML = `<div class="avatar">Q</div><div class="message-body"><article class="answer-card error-card"><div class="answer-main"><h3>Couldn’t complete the AI request</h3><p>${escapeHtml(error.message)}\n\nYou can switch to local retrieval in API settings and continue exploring the schema without an API call.</p></div></article></div>`;
  elements.messages.appendChild(node);
}

function scrollToBottom() {
  requestAnimationFrame(() => { elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight; });
}

async function submitQuestion(question) {
  if (!question.trim() || state.busy || !state.catalog) return;
  state.busy = true;
  elements.send.disabled = true;
  elements.catalogSelect.disabled = true;
  elements.welcome.hidden = true;
  addUserMessage(question.trim());
  const loading = el("loadingTemplate").content.cloneNode(true);
  elements.messages.appendChild(loading);
  const loadingNode = elements.messages.lastElementChild;
  scrollToBottom();

  const context = buildContext(question);
  el("contextIndicator").innerHTML = `<span>◈</span> ${context.models.length} relevant models selected`;
  try {
    const answer = state.localOnly || !state.apiKey
      ? localAnswer(question, context)
      : await askOpenAI(question, context);
    loadingNode.remove();
    addAnswer(answer, state.localOnly || !state.apiKey ? "local" : "ai");
  } catch (error) {
    loadingNode.remove();
    addError(error);
  } finally {
    state.busy = false;
    elements.send.disabled = false;
    elements.catalogSelect.disabled = false;
    elements.input.value = "";
    resizeTextarea();
    scrollToBottom();
  }
}

function resizeTextarea() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 140)}px`;
}

function updateModeUi() {
  const connected = Boolean(state.apiKey) && !state.localOnly;
  elements.apiStatusDot.classList.toggle("connected", connected);
  elements.modeLabel.textContent = connected ? `AI · ${state.model}` : "Local retrieval";
}

function openSettings() {
  elements.apiKey.value = state.apiKey;
  elements.modelName.value = state.model;
  updateSaveSettingsState();
  elements.settingsModal.hidden = false;
  setTimeout(() => elements.apiKey.focus(), 0);
}

function closeSettings() {
  elements.settingsModal.hidden = true;
}

function updateSaveSettingsState() {
  const complete = Boolean(elements.apiKey.value.trim() && elements.modelName.value.trim());
  elements.saveSettings.disabled = !complete;
}

function renderSchemaResults(query = "") {
  if (!state.catalog) return;
  const models = filterSchemaModels(query);
  elements.schemaResults.innerHTML = models.length
    ? models.map((model) => `<button class="schema-item" data-table="${escapeHtml(model.table)}" data-context="${escapeHtml(model.context || state.catalogKey)}"><strong>${escapeHtml(model.table)}</strong><span>${model.context ? `${escapeHtml(CATALOGS[model.context].label)} · ` : ""}${escapeHtml(model.app)} · ${(model.fields || []).length} fields</span></button>`).join("")
    : `<div class="schema-empty">No matching table or field in this snapshot.</div>`;
  elements.schemaResults.querySelectorAll(".schema-item").forEach((button) => {
    button.addEventListener("click", () => {
      const table = button.dataset.table;
      const contextKey = button.dataset.context;
      const model = state.catalog.models.find((item) => item.table === table && (item.context || state.catalogKey) === contextKey);
      if (!model) return;
      const fieldNames = model.fields.slice(0, 12).map((field) => field.column || field.name).join(", ");
      submitQuestion(`Explain the ${table} table, its purpose, relationships, and these fields: ${fieldNames}`);
      setSidebarOpen(false);
    });
  });
}

async function fetchCatalog(path) {
  const response = await fetch(new URL(path, document.baseURI), { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function combineCatalogs(metax, erpx) {
  const taggedModels = [
    ...metax.models.map((model) => ({ ...model, context: "metax" })),
    ...erpx.models.map((model) => ({ ...model, context: "erpx" })),
  ];
  const taggedMigrations = [
    ...(metax.migrations || []).map((migration) => ({ ...migration, context: "metax" })),
    ...(erpx.migrations || []).map((migration) => ({ ...migration, context: "erpx" })),
  ];
  const glossary = { ...(metax.glossary || {}) };
  for (const [term, values] of Object.entries(erpx.glossary || {})) {
    glossary[term] = [...new Set([...(glossary[term] || []), ...values])];
  }
  return {
    version: {
      commit_sha: "shared",
      generated_at: [metax.version?.generated_at, erpx.version?.generated_at].filter(Boolean).sort().at(-1),
      source_repository: "metax-database + erpx",
      dialect: "mixed",
      sources: { metax: metax.version, erpx: erpx.version },
      format: 1,
    },
    models: taggedModels,
    migrations: taggedMigrations,
    glossary,
  };
}

async function loadCatalog() {
  const requestedKey = state.catalogKey;
  const catalogConfig = activeCatalogConfig();
  state.catalog = null;
  elements.send.disabled = true;
  el("snapshotStatus").textContent = `Loading ${catalogConfig.label}…`;
  el("contextIndicator").textContent = `Loading ${catalogConfig.label} context…`;
  try {
    const catalog = catalogConfig.paths
      ? combineCatalogs(...await Promise.all(catalogConfig.paths.map(fetchCatalog)))
      : await fetchCatalog(catalogConfig.path);
    if (requestedKey !== state.catalogKey) return;
    state.catalog = catalog;
    const fieldCount = state.catalog.models.reduce((sum, model) => sum + (model.fields || []).length, 0);
    el("modelCount").textContent = state.catalog.models.length.toLocaleString();
    el("fieldCount").textContent = fieldCount.toLocaleString();
    el("migrationCount").textContent = (state.catalog.migrations || []).length.toLocaleString();
    el("commitSha").textContent = state.catalog.version?.commit_sha?.slice(0, 8) || "unknown";
    el("migrationLabel").textContent = catalogConfig.migrationsLabel;
    el("snapshotStatus").textContent = `${catalogConfig.label} context ready`;
    el("contextIndicator").innerHTML = `<span>◈</span> ${catalogConfig.label} · ${catalogConfig.dialect}`;
    updateCatalogCopy();
    elements.schemaSearch.value = "";
    renderSchemaResults();
  } catch (error) {
    if (requestedKey !== state.catalogKey) return;
    el("snapshotStatus").textContent = "Context unavailable";
    el("contextIndicator").textContent = "Run the schema exporter first";
    addError(new Error(`Could not load the ${catalogConfig.label} context. ${error.message}`));
  } finally {
    if (requestedKey === state.catalogKey) elements.send.disabled = !state.catalog;
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitQuestion(elements.input.value);
});
elements.input.addEventListener("input", resizeTextarea);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});
document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => submitQuestion(button.dataset.question));
});

[el("settingsButton"), el("modeButton")].forEach((button) => button.addEventListener("click", openSettings));
elements.themeToggle.addEventListener("click", toggleTheme);
el("closeSettings").addEventListener("click", closeSettings);
elements.settingsModal.addEventListener("click", (event) => { if (event.target === elements.settingsModal) closeSettings(); });
el("toggleKey").addEventListener("click", (event) => {
  const visible = elements.apiKey.type === "text";
  elements.apiKey.type = visible ? "password" : "text";
  event.currentTarget.textContent = visible ? "Show" : "Hide";
});
elements.apiKey.addEventListener("input", updateSaveSettingsState);
elements.modelName.addEventListener("input", updateSaveSettingsState);
elements.saveSettings.addEventListener("click", () => {
  if (elements.saveSettings.disabled) return;
  state.apiKey = elements.apiKey.value.trim();
  state.model = elements.modelName.value.trim();
  state.localOnly = false;
  updateModeUi();
  closeSettings();
});
el("useLocalMode").addEventListener("click", () => {
  state.localOnly = true;
  state.apiKey = "";
  elements.apiKey.value = "";
  updateSaveSettingsState();
  updateModeUi();
  closeSettings();
});
el("newThreadButton").addEventListener("click", () => {
  elements.messages.innerHTML = "";
  elements.welcome.hidden = false;
  elements.input.focus();
  setSidebarOpen(false);
});
elements.schemaSearch.addEventListener("input", (event) => renderSchemaResults(event.target.value));
elements.catalogSelect.addEventListener("change", (event) => {
  state.catalogKey = event.target.value;
  elements.messages.innerHTML = "";
  elements.welcome.hidden = false;
  loadCatalog();
});
el("clearSchemaSearch").addEventListener("click", () => {
  elements.schemaSearch.value = "";
  renderSchemaResults();
});
elements.mobileMenu.addEventListener("click", () => setSidebarOpen(!elements.sidebar.classList.contains("open")));
el("sidebarClose").addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.input.focus();
  }
  if (event.key === "Escape") {
    closeSettings();
    setSidebarOpen(false);
  }
});

updateModeUi();
renderThemeToggle();
loadCatalog();

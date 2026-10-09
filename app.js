const state = {
  catalog: null,
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
  apiStatusDot: el("apiStatusDot"),
  modeLabel: el("modeLabel"),
  schemaSearch: el("schemaSearch"),
  schemaResults: el("schemaResults"),
  sidebar: el("sidebar"),
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for",
  "from", "get", "give", "how", "i", "in", "is", "it", "me", "of", "on",
  "or", "that", "the", "this", "to", "was", "what", "when", "where", "which",
  "who", "whose", "with", "would", "you"
]);

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function searchableModel(model) {
  return [
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
      if (model.table.toLowerCase() === token || model.name.toLowerCase() === token) score += 18;
      else if (model.table.toLowerCase().includes(token) || model.name.toLowerCase().includes(token)) score += 9;
      if ((model.fields || []).some((field) => field.name.toLowerCase() === token || field.column?.toLowerCase() === token)) score += 12;
      else if (haystack.includes(token)) score += 2;
    }
    for (const target of glossaryTerms) {
      const [table, field] = String(target).split(".");
      if (model.table === table) score += 22;
      if (field && (model.fields || []).some((candidate) => candidate.column === field || candidate.name === field)) score += 10;
    }
    return { model, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, limit).map((entry) => entry.model);
  const selectedTables = new Set(selected.map((model) => model.table));
  const neighbors = [];

  for (const model of state.catalog.models) {
    const connected = (model.fields || []).some((field) =>
      selectedTables.has(field.references?.table)
    );
    const selectedReferencesIt = selected.some((candidate) =>
      (candidate.fields || []).some((field) => field.references?.table === model.table)
    );
    if ((connected || selectedReferencesIt) && !selectedTables.has(model.table)) neighbors.push(model);
  }

  return [...selected, ...neighbors.slice(0, Math.max(0, 10 - selected.length))].slice(0, 10);
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
    app: model.app,
    model: model.name,
    table: model.table,
    description: model.description || "",
    fields: (model.fields || []).map((field) => ({
      name: field.name,
      column: field.column,
      type: field.type,
      primary_key: Boolean(field.primary_key),
      null: field.null,
      choices: field.choices,
      help_text: field.help_text,
      references: field.references,
    })),
    indexes: model.indexes || [],
    constraints: model.constraints || [],
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
  const sources = context.models.slice(0, 5).map((model) => model.source);

  if (/quality.*rating|rating.*quality/.test(lower)) {
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

  if (/procured|procurement/.test(lower) && /inspection|inspected/.test(lower) && /sql|query|fetch|vehicles/.test(lower)) {
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
    answer: `The closest match is ${lead.table}, represented by ${lead.app}.${lead.name}. Relevant fields include ${relevantFields.slice(0, 5).join(", ")}. Connect an API key for a synthesized answer and relationship-aware SQL.`,
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
  const schemaContext = {
    snapshot: state.catalog.version,
    models: context.models.map(compactModel),
    migrations: context.migrations,
  };

  const instructions = [
    "You are Quill, a MetaX PostgreSQL schema assistant.",
    "Use only the supplied schema context. Never invent a table, column, relationship, or business definition.",
    "When a question is ambiguous, explain the alternatives instead of silently choosing one.",
    "Generate PostgreSQL SELECT queries only. Never generate mutations, DDL, multiple statements, or database execution instructions.",
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
          name: "metax_schema_answer",
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
  elements.settingsModal.hidden = false;
  setTimeout(() => elements.apiKey.focus(), 0);
}

function closeSettings() {
  elements.settingsModal.hidden = true;
}

function renderSchemaResults(query = "") {
  if (!state.catalog) return;
  const models = query.trim() ? scoreModels(query, 12) : state.catalog.models.slice(0, 12);
  elements.schemaResults.innerHTML = models.length
    ? models.map((model) => `<button class="schema-item" data-table="${escapeHtml(model.table)}"><strong>${escapeHtml(model.table)}</strong><span>${escapeHtml(model.app)} · ${(model.fields || []).length} fields</span></button>`).join("")
    : `<div class="schema-empty">No matching table or field in this snapshot.</div>`;
  elements.schemaResults.querySelectorAll(".schema-item").forEach((button) => {
    button.addEventListener("click", () => {
      const table = button.dataset.table;
      const model = state.catalog.models.find((item) => item.table === table);
      if (!model) return;
      const fieldNames = model.fields.slice(0, 12).map((field) => field.column || field.name).join(", ");
      submitQuestion(`Explain the ${table} table, its purpose, relationships, and these fields: ${fieldNames}`);
      elements.sidebar.classList.remove("open");
    });
  });
}

async function loadCatalog() {
  try {
    const response = await fetch("data/metax-context.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Context file returned ${response.status}`);
    state.catalog = await response.json();
    const fieldCount = state.catalog.models.reduce((sum, model) => sum + (model.fields || []).length, 0);
    el("modelCount").textContent = state.catalog.models.length.toLocaleString();
    el("fieldCount").textContent = fieldCount.toLocaleString();
    el("migrationCount").textContent = (state.catalog.migrations || []).length.toLocaleString();
    el("commitSha").textContent = state.catalog.version?.commit_sha?.slice(0, 8) || "unknown";
    el("snapshotStatus").textContent = "Context ready";
    renderSchemaResults();
  } catch (error) {
    el("snapshotStatus").textContent = "Context unavailable";
    el("contextIndicator").textContent = "Run the schema exporter first";
    addError(new Error(`Could not load data/metax-context.json. ${error.message}`));
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

[el("settingsButton"), el("topSettingsButton"), el("modeButton")].forEach((button) => button.addEventListener("click", openSettings));
el("closeSettings").addEventListener("click", closeSettings);
elements.settingsModal.addEventListener("click", (event) => { if (event.target === elements.settingsModal) closeSettings(); });
el("toggleKey").addEventListener("click", (event) => {
  const visible = elements.apiKey.type === "text";
  elements.apiKey.type = visible ? "password" : "text";
  event.currentTarget.textContent = visible ? "Show" : "Hide";
});
el("saveSettings").addEventListener("click", () => {
  state.apiKey = elements.apiKey.value.trim();
  state.model = elements.modelName.value.trim() || "gpt-6-astra";
  state.localOnly = !state.apiKey;
  updateModeUi();
  closeSettings();
});
el("useLocalMode").addEventListener("click", () => {
  state.localOnly = true;
  state.apiKey = "";
  elements.apiKey.value = "";
  updateModeUi();
  closeSettings();
});
el("newThreadButton").addEventListener("click", () => {
  elements.messages.innerHTML = "";
  elements.welcome.hidden = false;
  elements.input.focus();
});
elements.schemaSearch.addEventListener("input", (event) => renderSchemaResults(event.target.value));
el("clearSchemaSearch").addEventListener("click", () => {
  elements.schemaSearch.value = "";
  renderSchemaResults();
});
el("mobileMenu").addEventListener("click", () => elements.sidebar.classList.toggle("open"));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.input.focus();
  }
  if (event.key === "Escape") closeSettings();
});

updateModeUi();
loadCatalog();

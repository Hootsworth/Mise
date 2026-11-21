import {
  PROVIDERS,
  PROVIDER_ORDER,
  getProviderConfig,
  isProviderReady
} from "./ai-client.js";

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));

const DIET_OPTIONS = [
  "Vegetarian",
  "Vegan",
  "Gluten-Free",
  "Dairy-Free",
  "Nut-Free",
  "High-Protein",
  "Low-Carb",
  "Pescatarian"
];

const EQUIPMENT_OPTIONS = [
  "Cast Iron",
  "Dutch Oven",
  "Sheet Pan",
  "Air Fryer",
  "Blender",
  "Food Processor",
  "Wok",
  "Instant Pot"
];

const DEFAULT_PROFILE = {
  diet: [],
  allergies: "",
  skillLevel: "Home Cook",
  units: "metric",
  defaultServings: 2,
  equipment: [],
  pantry: "",
  customNote: ""
};

function sliderPercent(value, min = 0, max = 1.2) {
  const num = Number(value);
  if (!Number.isFinite(num) || max <= min) return "58%";
  const pct = Math.min(100, Math.max(0, ((num - min) / (max - min)) * 100));
  return `${pct.toFixed(1)}%`;
}

function providerStatusTag(settings, providerId) {
  if (providerId === "ollama") return "Local";
  if (providerId === "custom") {
    return isProviderReady(settings, "custom") ? "Ready" : "Configure";
  }
  return isProviderReady(settings, providerId) ? "Ready" : "Add key";
}

/**
 * Renders the full-screen Bring Your Own AI & Workspace Settings page.
 */
export function renderSettingsView(rootEl, ctx) {
  if (!rootEl) return;

  const aiDraft = structuredClone(ctx.aiSettings);
  const kpDraft = structuredClone(ctx.profile || DEFAULT_PROFILE);
  let activeTab = ctx.activeTab || "ai";
  let showKey = false;
  let fetchedModels = {}; // providerId -> string[]
  let statusMsg = { text: "", isError: false };
  let confirmDanger = ""; // "" | "keys" | "history" | "all"
  let keyTestController = null;

  const setStatus = (text, isError = false) => {
    statusMsg = { text, isError };
    const el = rootEl.querySelector("#st-status");
    if (el) {
      el.textContent = text;
      el.classList.toggle("is-error", Boolean(isError && text));
    }
  };

  const renderAiTab = () => {
    const id = aiDraft.activeProvider;
    const cfg = getProviderConfig(aiDraft, id);
    const liveList = fetchedModels[id] || [];
    const modelOptions = Array.from(new Set([...liveList, ...(cfg.presets || [])])).filter(Boolean);

    return `
      <form id="st-ai-form" aria-labelledby="settings-heading" novalidate>
        <fieldset class="st-group">
          <legend>AI Provider</legend>
          <div class="prov-grid">
            ${PROVIDER_ORDER.map((pid) => {
              const meta = PROVIDERS[pid];
              const checked = pid === id;
              const status = providerStatusTag(aiDraft, pid);
              return `
                <div class="prov-card-wrap">
                  <input
                    class="visually-hidden"
                    type="radio"
                    id="st-prov-${esc(pid)}"
                    name="provider"
                    value="${esc(pid)}"
                    ${checked ? "checked" : ""}
                  >
                  <label class="prov-card ${checked ? "is-selected" : ""}" for="st-prov-${esc(pid)}">
                    <span class="prov-card-name">${esc(meta.label)}</span>
                    <span class="prov-card-tag">${esc(status)}</span>
                  </label>
                </div>
              `;
            }).join("")}
          </div>
        </fieldset>

        <fieldset class="st-group">
          <legend>${esc(cfg.label)} Credentials &amp; Model</legend>

          ${
            cfg.editableBaseUrl
              ? `
            <div class="st-field">
              <label for="st-baseurl">Endpoint Base URL</label>
              <input
                type="url"
                id="st-baseurl"
                name="baseUrl"
                value="${esc(aiDraft.providers[id].baseUrl)}"
                placeholder="${esc(cfg.defaultBaseUrl || "https://...")}"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
                required
              >
            </div>
          `
              : ""
          }

          ${
            id !== "ollama"
              ? `
            <div class="st-field">
              <label for="st-apikey">API Key ${cfg.keyRequired ? `<span aria-hidden="true">*</span>` : "(optional)"}</label>
              <div class="st-input-row">
                <input
                  type="${showKey ? "text" : "password"}"
                  id="st-apikey"
                  name="apiKey"
                  value="${esc(aiDraft.providers[id].apiKey)}"
                  placeholder="${esc(cfg.keyPlaceholder || "Paste API key")}"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  aria-describedby="st-provider-help"
                  ${cfg.keyRequired ? "required" : ""}
                >
                <button
                  type="button"
                  class="tbtn"
                  id="st-key-toggle"
                  aria-pressed="${showKey}"
                  aria-label="${showKey ? "Hide API key" : "Show API key"}"
                >${showKey ? "Hide" : "Show"}</button>
                <button type="button" class="tbtn" id="st-key-clear">Clear</button>
              </div>
            </div>
          `
              : ""
          }

          <div class="st-field">
            <label for="st-model">Model ID</label>
            <div class="st-input-row">
              <input
                type="text"
                id="st-model"
                name="model"
                list="mise-model-datalist"
                value="${esc(aiDraft.providers[id].model)}"
                placeholder="${esc(cfg.defaultModel || "Enter model identifier")}"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
                required
              >
              <button type="button" class="tbtn" id="st-fetch-models">Fetch live models</button>
            </div>
            <datalist id="mise-model-datalist">
              ${modelOptions.map((m) => `<option value="${esc(m)}">`).join("")}
            </datalist>
            ${
              modelOptions.length
                ? `
              <div class="st-presets" aria-label="Model presets">
                ${modelOptions
                  .slice(0, 12)
                  .map(
                    (m) =>
                      `<button type="button" class="chip ${aiDraft.providers[id].model === m ? "is-active" : ""}" data-preset-model="${esc(m)}">${esc(m)}</button>`
                  )
                  .join("")}
              </div>
            `
                : ""
            }
          </div>

          <div class="st-field">
            <div class="st-range-head">
              <label for="st-temp">Creativity (Temperature)</label>
              <span class="m3-range-badge" id="st-temp-val">${Number(aiDraft.temperature).toFixed(1)}</span>
            </div>
            <div class="st-range-row">
              <span>Precise (0.0)</span>
              <input
                class="m3-slider"
                type="range"
                id="st-temp"
                name="temperature"
                min="0"
                max="1.2"
                step="0.1"
                value="${esc(aiDraft.temperature)}"
                style="--val-pct: ${sliderPercent(aiDraft.temperature)}"
              >
              <span>Inventive (1.2)</span>
            </div>
          </div>

          <p class="st-help" id="st-provider-help">${esc(cfg.helpText || "")}</p>
        </fieldset>

        <div class="st-actions">
          <button type="submit" class="go" id="st-save-ai">Save settings</button>
          <button type="button" class="tbtn" id="st-test-btn">Test connection</button>
        </div>
        <div id="st-status" class="st-status ${statusMsg.isError ? "is-error" : ""}" role="status" aria-live="polite">${esc(statusMsg.text)}</div>
      </form>
    `;
  };

  const renderPhotographyTab = () => {
    const imgProviders = PROVIDER_ORDER.filter((pid) => PROVIDERS[pid].supportsImages);
    const targetId =
      aiDraft.imageProvider && aiDraft.imageProvider !== "auto" ? aiDraft.imageProvider : aiDraft.activeProvider;
    const imgCfg = PROVIDERS[targetId] || PROVIDERS.gemini;
    const presetImgs = imgCfg.imageModels || [];
    const currentModelVal =
      aiDraft.imageProvider !== "auto"
        ? aiDraft.providers[targetId]?.imageModel || ""
        : aiDraft.providers[imgCfg.supportsImages ? aiDraft.activeProvider : "gemini"]?.imageModel || "";

    return `
      <form id="st-photo-form" aria-labelledby="settings-heading" novalidate>
        <fieldset class="st-group">
          <legend>Default dish photography</legend>
          <div class="prov-grid prov-grid-2">
            <div class="prov-card-wrap">
              <input
                class="visually-hidden"
                type="radio"
                id="st-img-open"
                name="imageMode"
                value="open"
                ${aiDraft.imageMode === "open" ? "checked" : ""}
              >
              <label class="prov-card ${aiDraft.imageMode === "open" ? "is-selected" : ""}" for="st-img-open">
                <span class="prov-card-name">Open web photography</span>
                <span class="prov-card-tag">Default · Free</span>
                <small class="prov-card-sub">Openverse, Wikimedia Commons, TheMealDB &amp; Wikipedia</small>
              </label>
            </div>
            <div class="prov-card-wrap">
              <input
                class="visually-hidden"
                type="radio"
                id="st-img-ai"
                name="imageMode"
                value="ai"
                ${aiDraft.imageMode === "ai" ? "checked" : ""}
              >
              <label class="prov-card ${aiDraft.imageMode === "ai" ? "is-selected" : ""}" for="st-img-ai">
                <span class="prov-card-name">AI-generated photography</span>
                <span class="prov-card-tag">Opt-in</span>
                <small class="prov-card-sub">Uses your configured AI provider key directly</small>
              </label>
            </div>
          </div>
        </fieldset>

        <fieldset class="st-group">
          <legend>AI image generation preferences</legend>
          <div class="st-field">
            <label for="st-img-prov">Image provider</label>
            <select class="m3-select" id="st-img-prov" name="imageProvider">
              <option value="auto" ${aiDraft.imageProvider === "auto" ? "selected" : ""}>Auto (active provider or first configured key)</option>
              ${imgProviders
                .map(
                  (pid) =>
                    `<option value="${esc(pid)}" ${aiDraft.imageProvider === pid ? "selected" : ""}>${esc(PROVIDERS[pid].label)}</option>`
                )
                .join("")}
            </select>
          </div>

          <div class="st-field">
            <label for="st-img-model">Image model ID (${esc(imgCfg.label)})</label>
            <input
              type="text"
              id="st-img-model"
              name="imageModel"
              list="mise-img-model-datalist"
              value="${esc(currentModelVal)}"
              placeholder="${esc(imgCfg.defaultImageModel || "e.g. gpt-image-1")}"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
            >
            <datalist id="mise-img-model-datalist">
              ${presetImgs.map((m) => `<option value="${esc(m)}">`).join("")}
            </datalist>
            ${
              presetImgs.length
                ? `
              <div class="st-presets" aria-label="Image model presets">
                ${presetImgs
                  .map(
                    (m) =>
                      `<button type="button" class="chip ${currentModelVal === m ? "is-active" : ""}" data-preset-img-model="${esc(m)}">${esc(m)}</button>`
                  )
                  .join("")}
              </div>
            `
                : ""
            }
          </div>
          <p class="st-help">Even with Open web photography selected, you can still generate an AI dish photo on demand from any recipe hero.</p>
        </fieldset>

        <div class="st-actions">
          <button type="submit" class="go" id="st-save-photo">Save photography</button>
        </div>
        <div id="st-status" class="st-status ${statusMsg.isError ? "is-error" : ""}" role="status" aria-live="polite">${esc(statusMsg.text)}</div>
      </form>
    `;
  };

  const renderKitchenTab = () => `
    <form id="st-kitchen-form" aria-labelledby="settings-heading" novalidate>
      <fieldset class="st-group">
        <legend>Dietary &amp; Allergies</legend>
        <div class="st-field">
          <span class="st-field-label">Dietary preferences</span>
          <div class="preset-chips">
            ${DIET_OPTIONS.map(
              (d) => `<button type="button" class="chip m3-check-chip ${kpDraft.diet.includes(d) ? "is-active" : ""}" data-st-diet="${esc(d)}">${esc(d)}</button>`
            ).join("")}
          </div>
        </div>
        <div class="st-field">
          <label for="st-kp-allergies">Allergies &amp; strict avoidances</label>
          <input type="text" id="st-kp-allergies" name="allergies" value="${esc(kpDraft.allergies)}" placeholder="e.g. peanuts, shellfish, cilantro">
        </div>
      </fieldset>

      <fieldset class="st-group">
        <legend>Kitchen defaults</legend>
        <div class="field-split">
          <div class="st-field">
            <label for="st-kp-skill">Skill level</label>
            <select class="m3-select" id="st-kp-skill" name="skillLevel">
              ${["Beginner", "Home Cook", "Confident", "Chef"]
                .map((s) => `<option value="${esc(s)}" ${kpDraft.skillLevel === s ? "selected" : ""}>${esc(s)}</option>`)
                .join("")}
            </select>
          </div>
          <div class="st-field">
            <label for="st-kp-units">Default units</label>
            <select class="m3-select" id="st-kp-units" name="units">
              <option value="metric" ${kpDraft.units === "metric" ? "selected" : ""}>Metric (g, ml, °C)</option>
              <option value="us" ${kpDraft.units === "us" ? "selected" : ""}>US (oz, cup, °F)</option>
            </select>
          </div>
          <div class="st-field">
            <span class="st-field-label" id="st-sv-label">Default servings</span>
            <div class="m3-stepper" role="group" aria-labelledby="st-sv-label">
              <button type="button" class="m3-step-btn" id="st-sv-dec" aria-label="Decrease default servings">−</button>
              <span class="m3-step-val" id="st-sv-val">${kpDraft.defaultServings}</span>
              <button type="button" class="m3-step-btn" id="st-sv-inc" aria-label="Increase default servings">+</button>
            </div>
          </div>
        </div>

        <div class="st-field">
          <span class="st-field-label">Cookware &amp; appliances</span>
          <div class="preset-chips">
            ${EQUIPMENT_OPTIONS.map(
              (eq) => `<button type="button" class="chip m3-check-chip ${kpDraft.equipment.includes(eq) ? "is-active" : ""}" data-st-eq="${esc(eq)}">${esc(eq)}</button>`
            ).join("")}
          </div>
        </div>

        <div class="st-field">
          <label for="st-kp-pantry">Pantry staples on hand</label>
          <input type="text" id="st-kp-pantry" name="pantry" value="${esc(kpDraft.pantry)}" placeholder="e.g. white miso, mirin, sesame oil, arborio rice">
        </div>

        <div class="st-field">
          <label for="st-kp-note">House style notes</label>
          <input type="text" id="st-kp-note" name="customNote" value="${esc(kpDraft.customNote)}" placeholder="e.g. keep weeknight recipes under 30 min, love bright acid">
        </div>
      </fieldset>

      <div class="st-actions">
        <button type="submit" class="go" id="st-save-kp">Save profile</button>
        <button type="button" class="tbtn" id="st-kp-reset">Reset profile</button>
      </div>
      <div id="st-status" class="st-status ${statusMsg.isError ? "is-error" : ""}" role="status" aria-live="polite">${esc(statusMsg.text)}</div>
    </form>
  `;

  const renderDataTab = () => {
    const keyCount = PROVIDER_ORDER.filter((pid) => Boolean(aiDraft.providers[pid]?.apiKey)).length;
    const renderConfirmBtn = (action, label, confirmLabel) =>
      confirmDanger === action
        ? `
          <button type="button" class="go" data-confirm-danger="${esc(action)}">${esc(confirmLabel)}</button>
          <button type="button" class="tbtn" id="st-cancel-danger">Cancel</button>
        `
        : `<button type="button" class="tbtn" data-arm-danger="${esc(action)}">${esc(label)}</button>`;

    return `
      <div class="st-data">
        <fieldset class="st-group">
          <legend>Stored on this device</legend>
          <dl class="st-data-list">
            <div><dt>Saved API keys</dt><dd>${keyCount} provider${keyCount === 1 ? "" : "s"}</dd></div>
            <div><dt>Recent recipes</dt><dd>${ctx.histCount || 0}</dd></div>
            <div><dt>Saved bookmarks</dt><dd>${ctx.savedCount || 0}</dd></div>
          </dl>
          <p class="st-help">All API keys, custom model choices, kitchen preferences, and saved recipes live exclusively in this browser's <code>localStorage</code>.</p>
        </fieldset>

        <fieldset class="st-group">
          <legend>Reset &amp; cleanup</legend>
          <div class="st-danger-rows">
            <div class="st-danger-row">
              <div>
                <strong>Replay welcome setup</strong>
                <small>Walk through the calm step-by-step setup guide for units, taste notes, and AI again.</small>
              </div>
              <div class="st-danger-btns">
                <button type="button" class="tbtn" id="st-replay-onboarding">Replay onboarding</button>
              </div>
            </div>
            <div class="st-danger-row">
              <div>
                <strong>Clear all API keys</strong>
                <small>Removes stored API tokens across every provider while keeping your models and kitchen profile.</small>
              </div>
              <div class="st-danger-btns">
                ${renderConfirmBtn("keys", "Clear all API keys", "Confirm clear keys")}
              </div>
            </div>
            <div class="st-danger-row">
              <div>
                <strong>Clear recipe history</strong>
                <small>Clears recent generated dishes from this browser (saved bookmarks stay intact).</small>
              </div>
              <div class="st-danger-btns">
                ${renderConfirmBtn("history", "Clear history", "Confirm clear history")}
              </div>
            </div>
            <div class="st-danger-row">
              <div>
                <strong>Reset all settings</strong>
                <small>Restores factory AI settings, clears keys, and resets Kitchen Profile defaults.</small>
              </div>
              <div class="st-danger-btns">
                ${renderConfirmBtn("all", "Reset everything", "Confirm full reset")}
              </div>
            </div>
          </div>
        </fieldset>
        <div id="st-status" class="st-status ${statusMsg.isError ? "is-error" : ""}" role="status" aria-live="polite">${esc(statusMsg.text)}</div>
      </div>
    `;
  };

  const render = () => {
    const tabs = [
      { id: "ai", label: "AI & Models" },
      { id: "photo", label: "Photography" },
      { id: "kitchen", label: "Kitchen Profile" },
      { id: "data", label: "Data" }
    ];

    let tabHtml = "";
    if (activeTab === "ai") tabHtml = renderAiTab();
    else if (activeTab === "photo") tabHtml = renderPhotographyTab();
    else if (activeTab === "kitchen") tabHtml = renderKitchenTab();
    else tabHtml = renderDataTab();

    rootEl.innerHTML = `
      <div class="settings-shell">
        <div class="st-head">
          <button type="button" class="quiet-act" id="settings-back-btn">← Back</button>
          <h1 id="settings-heading" tabindex="-1">Settings</h1>
          <p class="st-sub">Bring your own AI. Keys stay in your browser — never sent to any proxy.</p>
        </div>

        <nav class="st-tabs" aria-label="Settings sections">
          ${tabs
            .map(
              (t) =>
                `<button type="button" class="st-tab ${activeTab === t.id ? "is-active" : ""}" data-st-tab="${esc(t.id)}" aria-current="${activeTab === t.id ? "page" : "false"}">${esc(t.label)}</button>`
            )
            .join("")}
        </nav>

        <div class="st-body">
          ${tabHtml}
        </div>
      </div>
    `;

    rootEl.querySelector("#settings-back-btn")?.addEventListener("click", () => {
      keyTestController?.abort();
      ctx.onBack?.();
    });

    rootEl.querySelectorAll("[data-st-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        keyTestController?.abort();
        activeTab = btn.dataset.stTab;
        statusMsg = { text: "", isError: false };
        confirmDanger = "";
        ctx.onTabChange?.(activeTab);
        render();
      });
    });

    if (activeTab === "ai") bindAiTab();
    else if (activeTab === "photo") bindPhotoTab();
    else if (activeTab === "kitchen") bindKitchenTab();
    else bindDataTab();
  };

  const syncAiInputsToDraft = () => {
    const id = aiDraft.activeProvider;
    const baseEl = rootEl.querySelector("#st-baseurl");
    const keyEl = rootEl.querySelector("#st-apikey");
    const modelEl = rootEl.querySelector("#st-model");
    const tempEl = rootEl.querySelector("#st-temp");
    if (baseEl) aiDraft.providers[id].baseUrl = baseEl.value.trim().replace(/\/+$/, "");
    if (keyEl) aiDraft.providers[id].apiKey = keyEl.value.trim();
    if (modelEl) aiDraft.providers[id].model = modelEl.value.trim();
    if (tempEl) aiDraft.temperature = Number(tempEl.value);
  };

  const bindAiTab = () => {
    rootEl.querySelectorAll('#st-ai-form input[name="provider"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        syncAiInputsToDraft();
        aiDraft.activeProvider = radio.value;
        showKey = false;
        statusMsg = { text: "", isError: false };
        render();
      });
    });

    rootEl.querySelector("#st-key-toggle")?.addEventListener("click", () => {
      syncAiInputsToDraft();
      showKey = !showKey;
      const input = rootEl.querySelector("#st-apikey");
      const btn = rootEl.querySelector("#st-key-toggle");
      if (input && btn) {
        input.type = showKey ? "text" : "password";
        btn.textContent = showKey ? "Hide" : "Show";
        btn.setAttribute("aria-pressed", String(showKey));
        btn.setAttribute("aria-label", showKey ? "Hide API key" : "Show API key");
      }
    });

    rootEl.querySelector("#st-key-clear")?.addEventListener("click", () => {
      const id = aiDraft.activeProvider;
      aiDraft.providers[id].apiKey = "";
      const input = rootEl.querySelector("#st-apikey");
      if (input) {
        input.value = "";
        input.focus();
      }
      setStatus("API key field cleared. Save settings to apply.");
    });

    rootEl.querySelector("#st-temp")?.addEventListener("input", (e) => {
      aiDraft.temperature = Number(e.target.value);
      e.target.style.setProperty("--val-pct", sliderPercent(aiDraft.temperature));
      const valEl = rootEl.querySelector("#st-temp-val");
      if (valEl) valEl.textContent = aiDraft.temperature.toFixed(1);
    });

    rootEl.querySelectorAll("[data-preset-model]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const model = btn.dataset.presetModel;
        aiDraft.providers[aiDraft.activeProvider].model = model;
        const input = rootEl.querySelector("#st-model");
        if (input) input.value = model;
        rootEl.querySelectorAll("[data-preset-model]").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
      });
    });

    rootEl.querySelector("#st-model")?.addEventListener("input", (e) => {
      const val = e.target.value.trim();
      aiDraft.providers[aiDraft.activeProvider].model = val;
      rootEl.querySelectorAll("[data-preset-model]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.presetModel === val);
      });
    });

    rootEl.querySelector("#st-fetch-models")?.addEventListener("click", async () => {
      syncAiInputsToDraft();
      const id = aiDraft.activeProvider;
      const btn = rootEl.querySelector("#st-fetch-models");
      if (btn) btn.disabled = true;
      setStatus(`Fetching live models from ${PROVIDERS[id].label}…`);
      try {
        keyTestController?.abort();
        keyTestController = new AbortController();
        const models = await ctx.onFetchModels(id, aiDraft.providers[id], keyTestController.signal);
        fetchedModels[id] = models;
        if (models.length && !aiDraft.providers[id].model) {
          aiDraft.providers[id].model = models[0];
        }
        statusMsg = {
          text: models.length
            ? `Loaded ${models.length} live model${models.length === 1 ? "" : "s"} from ${PROVIDERS[id].label}.`
            : `Connected, but ${PROVIDERS[id].label} returned an empty model list.`,
          isError: false
        };
        render();
      } catch (err) {
        if (err?.name !== "AbortError") {
          setStatus(err?.message || "Could not fetch live models.", true);
        }
      } finally {
        const b = rootEl.querySelector("#st-fetch-models");
        if (b) b.disabled = false;
      }
    });

    rootEl.querySelector("#st-test-btn")?.addEventListener("click", async () => {
      syncAiInputsToDraft();
      const btn = rootEl.querySelector("#st-test-btn");
      if (btn) btn.disabled = true;
      setStatus(`Testing ${PROVIDERS[aiDraft.activeProvider].label}…`);
      try {
        keyTestController?.abort();
        keyTestController = new AbortController();
        const result = await ctx.onTestConnection(aiDraft, keyTestController.signal);
        setStatus(`Connected to ${result.provider} (${result.model}) in ${result.latencyMs} ms.`);
      } catch (err) {
        if (err?.name !== "AbortError") {
          setStatus(err?.message || "Connection test failed.", true);
        }
      } finally {
        const b = rootEl.querySelector("#st-test-btn");
        if (b) b.disabled = false;
      }
    });

    rootEl.querySelector("#st-ai-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      syncAiInputsToDraft();
      const saved = ctx.onSaveAi(aiDraft);
      Object.assign(aiDraft, structuredClone(saved));
      statusMsg = { text: `Saved ${PROVIDERS[aiDraft.activeProvider].label} settings.`, isError: false };
      render();
    });
  };

  const bindPhotoTab = () => {
    rootEl.querySelectorAll('#st-photo-form input[name="imageMode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        aiDraft.imageMode = radio.value === "ai" ? "ai" : "open";
        statusMsg = { text: "", isError: false };
        render();
      });
    });

    rootEl.querySelector("#st-img-prov")?.addEventListener("change", (e) => {
      aiDraft.imageProvider = e.target.value;
      statusMsg = { text: "", isError: false };
      render();
    });

    const targetImgPid =
      aiDraft.imageProvider && aiDraft.imageProvider !== "auto"
        ? aiDraft.imageProvider
        : PROVIDERS[aiDraft.activeProvider]?.supportsImages
        ? aiDraft.activeProvider
        : "gemini";

    rootEl.querySelectorAll("[data-preset-img-model]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.presetImgModel;
        aiDraft.providers[targetImgPid].imageModel = val;
        const input = rootEl.querySelector("#st-img-model");
        if (input) input.value = val;
        rootEl.querySelectorAll("[data-preset-img-model]").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
      });
    });

    rootEl.querySelector("#st-photo-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = rootEl.querySelector("#st-img-model");
      if (input && aiDraft.providers[targetImgPid]) {
        aiDraft.providers[targetImgPid].imageModel = input.value.trim();
      }
      const saved = ctx.onSaveAi(aiDraft);
      Object.assign(aiDraft, structuredClone(saved));
      statusMsg = {
        text: `Photography set to ${aiDraft.imageMode === "ai" ? "AI-generated (opt-in)" : "Open web photography"}.`,
        isError: false
      };
      render();
    });
  };

  const bindKitchenTab = () => {
    const syncProfileFields = () => {
      kpDraft.allergies = rootEl.querySelector("#st-kp-allergies")?.value || "";
      kpDraft.skillLevel = rootEl.querySelector("#st-kp-skill")?.value || "Home Cook";
      kpDraft.units = rootEl.querySelector("#st-kp-units")?.value === "us" ? "us" : "metric";
      kpDraft.pantry = rootEl.querySelector("#st-kp-pantry")?.value || "";
      kpDraft.customNote = rootEl.querySelector("#st-kp-note")?.value || "";
    };

    rootEl.querySelector("#st-sv-dec")?.addEventListener("click", () => {
      kpDraft.defaultServings = Math.max(1, Number(kpDraft.defaultServings || 2) - 1);
      const el = rootEl.querySelector("#st-sv-val");
      if (el) el.textContent = String(kpDraft.defaultServings);
      statusMsg = { text: "", isError: false };
    });

    rootEl.querySelector("#st-sv-inc")?.addEventListener("click", () => {
      kpDraft.defaultServings = Math.min(16, Number(kpDraft.defaultServings || 2) + 1);
      const el = rootEl.querySelector("#st-sv-val");
      if (el) el.textContent = String(kpDraft.defaultServings);
      statusMsg = { text: "", isError: false };
    });

    rootEl.querySelectorAll("[data-st-diet]").forEach((btn) => {
      btn.addEventListener("click", () => {
        syncProfileFields();
        const val = btn.dataset.stDiet;
        const idx = kpDraft.diet.indexOf(val);
        if (idx === -1) kpDraft.diet.push(val);
        else kpDraft.diet.splice(idx, 1);
        statusMsg = { text: "", isError: false };
        render();
      });
    });

    rootEl.querySelectorAll("[data-st-eq]").forEach((btn) => {
      btn.addEventListener("click", () => {
        syncProfileFields();
        const val = btn.dataset.stEq;
        const idx = kpDraft.equipment.indexOf(val);
        if (idx === -1) kpDraft.equipment.push(val);
        else kpDraft.equipment.splice(idx, 1);
        statusMsg = { text: "", isError: false };
        render();
      });
    });

    rootEl.querySelector("#st-kp-reset")?.addEventListener("click", () => {
      Object.assign(kpDraft, structuredClone(DEFAULT_PROFILE));
      ctx.onSaveProfile(kpDraft);
      statusMsg = { text: "Kitchen profile reset to defaults.", isError: false };
      render();
    });

    rootEl.querySelector("#st-kitchen-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      syncProfileFields();
      ctx.onSaveProfile(kpDraft);
      statusMsg = { text: "Kitchen profile saved.", isError: false };
      render();
    });
  };

  const bindDataTab = () => {
    rootEl.querySelector("#st-replay-onboarding")?.addEventListener("click", () => {
      ctx.onReplayOnboarding?.();
    });

    rootEl.querySelectorAll("[data-arm-danger]").forEach((btn) => {
      btn.addEventListener("click", () => {
        confirmDanger = btn.dataset.armDanger;
        statusMsg = { text: "", isError: false };
        render();
      });
    });

    rootEl.querySelector("#st-cancel-danger")?.addEventListener("click", () => {
      confirmDanger = "";
      render();
    });

    rootEl.querySelectorAll("[data-confirm-danger]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.confirmDanger;
        confirmDanger = "";
        if (action === "keys") {
          const updated = ctx.onClearKeys();
          Object.assign(aiDraft, structuredClone(updated));
          statusMsg = { text: "All API keys removed from this browser.", isError: false };
        } else if (action === "history") {
          ctx.onClearHistory();
          ctx.histCount = 0;
          statusMsg = { text: "Recent recipe history cleared.", isError: false };
        } else if (action === "all") {
          const updated = ctx.onResetAll();
          Object.assign(aiDraft, structuredClone(updated.aiSettings));
          Object.assign(kpDraft, structuredClone(updated.profile));
          ctx.histCount = 0;
          ctx.savedCount = 0;
          statusMsg = { text: "All settings and local data reset.", isError: false };
        }
        render();
      });
    });
  };

  render();
}

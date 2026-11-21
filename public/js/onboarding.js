import {
  PROVIDERS,
  PROVIDER_ORDER,
  getProviderConfig,
  isProviderReady
} from "./ai-client.js";
import { renderPotSvg } from "./cooking-loader.js";

export const ONBOARDING_STORAGE_KEY = "mise:onboarded:v1";

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));

const SKILL_LEVELS = [
  { id: "Beginner", hint: "Clear guidance & timing cues" },
  { id: "Home Cook", hint: "Balanced weeknight technique" },
  { id: "Confident", hint: "Faster prep & bolder flavors" },
  { id: "Chef", hint: "Concise pro proportions" }
];

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

function getDefaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function hasCompletedOnboarding(storage = getDefaultStorage()) {
  if (!storage) return false;
  try {
    return Boolean(storage.getItem(ONBOARDING_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function markOnboardingComplete(status = "done", storage = getDefaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, String(status || "done"));
  } catch {
    // Storage unavailable
  }
}

export function resetOnboarding(storage = getDefaultStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // Storage unavailable
  }
}

function sliderPercent(value, min = 0, max = 1.2) {
  const num = Number(value);
  if (!Number.isFinite(num) || max <= min) return "58%";
  const pct = Math.min(100, Math.max(0, ((num - min) / (max - min)) * 100));
  return `${pct.toFixed(1)}%`;
}

/**
 * Renders the calm 4-step full-screen onboarding flow.
 * Every choice saved here maps directly to Kitchen Profile & BYOK Settings.
 */
export function renderOnboardingView(rootEl, ctx) {
  if (!rootEl) return;

  let step = 1;
  let direction = "next"; // "next" | "prev"
  let showKey = false;
  let modelStatus = "";
  let fetchedModels = {};
  const kpDraft = structuredClone(ctx.profile);
  const aiDraft = structuredClone(ctx.aiSettings);

  const goStep = (nextStep) => {
    syncCurrentStepInputs();
    direction = nextStep >= step ? "next" : "prev";
    step = Math.max(1, Math.min(4, nextStep));
    modelStatus = "";
    render(true);
  };

  const finish = ({ skipped = false } = {}) => {
    syncCurrentStepInputs();
    markOnboardingComplete(skipped ? "skipped" : "done");
    ctx.onComplete?.({ aiSettings: aiDraft, profile: kpDraft, skipped });
  };

  const syncCurrentStepInputs = () => {
    if (step === 2) {
      const noteEl = rootEl.querySelector("#ob-note");
      if (noteEl) kpDraft.customNote = noteEl.value.trim();
    } else if (step === 3) {
      const algEl = rootEl.querySelector("#ob-allergies");
      const panEl = rootEl.querySelector("#ob-pantry");
      if (algEl) kpDraft.allergies = algEl.value.trim();
      if (panEl) kpDraft.pantry = panEl.value.trim();
    } else if (step === 4) {
      const pid = aiDraft.activeProvider;
      const baseEl = rootEl.querySelector("#ob-baseurl");
      const keyEl = rootEl.querySelector("#ob-apikey");
      const modEl = rootEl.querySelector("#ob-model");
      const tempEl = rootEl.querySelector("#ob-temp");
      if (baseEl) aiDraft.providers[pid].baseUrl = baseEl.value.trim().replace(/\/+$/, "");
      if (keyEl) aiDraft.providers[pid].apiKey = keyEl.value.trim();
      if (modEl) aiDraft.providers[pid].model = modEl.value.trim();
      if (tempEl) aiDraft.temperature = Number(tempEl.value);
    }
  };

  const renderStepBody = () => {
    if (step === 1) {
      return `
        <div class="ob-welcome">
          <div class="ob-emblem">${renderPotSvg("cook-pot-svg ob-pot")}</div>
          <h1 id="ob-heading" tabindex="-1" class="ob-title">Welcome to Mise.</h1>
          <p class="ob-sub">
            A calm, tactile kitchen companion for cooking anything. Set up your units, dietary notes, and AI model in less than a minute — everything can be changed anytime in Settings.
          </p>
          <div class="ob-welcome-acts">
            <button type="button" class="go ob-primary" id="ob-next-btn">Begin setup →</button>
            <button type="button" class="quiet-act" id="ob-skip-main-btn">Skip to Mise</button>
          </div>
        </div>
      `;
    }

    if (step === 2) {
      return `
        <div class="ob-panel">
          <span class="ob-step-tag">Step 02 · Your Kitchen</span>
          <h1 id="ob-heading" tabindex="-1" class="ob-title">How do you like to cook?</h1>
          <p class="ob-sub">Shapes portion scaling, temperatures, and instruction clarity.</p>

          <fieldset class="st-group">
            <legend>Skill level</legend>
            <div class="prov-grid prov-grid-2">
              ${SKILL_LEVELS.map((lv) => {
                const checked = kpDraft.skillLevel === lv.id;
                return `
                  <div class="prov-card-wrap">
                    <input
                      class="visually-hidden"
                      type="radio"
                      id="ob-skill-${esc(lv.id)}"
                      name="ob-skill"
                      value="${esc(lv.id)}"
                      ${checked ? "checked" : ""}
                    >
                    <label class="prov-card ${checked ? "is-selected" : ""}" for="ob-skill-${esc(lv.id)}">
                      <span class="prov-card-name">${esc(lv.id)}</span>
                      <small class="prov-card-sub">${esc(lv.hint)}</small>
                    </label>
                  </div>
                `;
              }).join("")}
            </div>
          </fieldset>

          <div class="ob-two-col">
            <fieldset class="st-group">
              <legend>Default units</legend>
              <div class="m3-seg" role="radiogroup" aria-label="Default measurement units">
                <button type="button" class="m3-seg-btn ${kpDraft.units === "metric" ? "is-active" : ""}" data-ob-unit="metric" role="radio" aria-checked="${kpDraft.units === "metric"}">Metric (g, °C)</button>
                <button type="button" class="m3-seg-btn ${kpDraft.units === "us" ? "is-active" : ""}" data-ob-unit="us" role="radio" aria-checked="${kpDraft.units === "us"}">US (oz, °F)</button>
              </div>
            </fieldset>

            <fieldset class="st-group">
              <legend>Default servings</legend>
              <div class="m3-stepper">
                <button type="button" class="m3-step-btn" id="ob-sv-dec" aria-label="Decrease default servings">−</button>
                <span class="m3-step-val" id="ob-sv-val">${kpDraft.defaultServings}</span>
                <button type="button" class="m3-step-btn" id="ob-sv-inc" aria-label="Increase default servings">+</button>
              </div>
            </fieldset>
          </div>

          <div class="st-field">
            <label for="ob-note">House cooking note (optional)</label>
            <input type="text" id="ob-note" value="${esc(kpDraft.customNote)}" placeholder="e.g. weeknight 30-min meals, bright acidity, crisp textures" enterkeyhint="next">
          </div>

          <div class="ob-foot">
            <button type="button" class="tbtn" id="ob-prev-btn">← Back</button>
            <button type="button" class="go ob-primary" id="ob-next-btn">Continue →</button>
          </div>
        </div>
      `;
    }

    if (step === 3) {
      return `
        <div class="ob-panel">
          <span class="ob-step-tag">Step 03 · Taste &amp; Pantry</span>
          <h1 id="ob-heading" tabindex="-1" class="ob-title">Dietary notes &amp; cookware.</h1>
          <p class="ob-sub">Honored automatically in every dish suggestion, swap, and recipe.</p>

          <fieldset class="st-group">
            <legend>Dietary preferences</legend>
            <div class="preset-chips">
              ${DIET_OPTIONS.map((d) => {
                const on = kpDraft.diet.includes(d);
                return `<button type="button" class="chip m3-check-chip ${on ? "is-active" : ""}" data-ob-diet="${esc(d)}" aria-pressed="${on}">${esc(d)}</button>`;
              }).join("")}
            </div>
          </fieldset>

          <div class="st-field">
            <label for="ob-allergies">Allergies or strict avoidances</label>
            <input type="text" id="ob-allergies" value="${esc(kpDraft.allergies)}" placeholder="e.g. peanuts, shellfish, cilantro" enterkeyhint="next">
          </div>

          <fieldset class="st-group">
            <legend>Cookware &amp; appliances you own</legend>
            <div class="preset-chips">
              ${EQUIPMENT_OPTIONS.map((eq) => {
                const on = kpDraft.equipment.includes(eq);
                return `<button type="button" class="chip m3-check-chip ${on ? "is-active" : ""}" data-ob-eq="${esc(eq)}" aria-pressed="${on}">${esc(eq)}</button>`;
              }).join("")}
            </div>
          </fieldset>

          <div class="st-field">
            <label for="ob-pantry">Pantry staples usually on hand</label>
            <input type="text" id="ob-pantry" value="${esc(kpDraft.pantry)}" placeholder="e.g. white miso, mirin, sesame oil, arborio rice" enterkeyhint="next">
          </div>

          <div class="ob-foot">
            <button type="button" class="tbtn" id="ob-prev-btn">← Back</button>
            <button type="button" class="go ob-primary" id="ob-next-btn">Continue →</button>
          </div>
        </div>
      `;
    }

    const id = aiDraft.activeProvider;
    const cfg = getProviderConfig(aiDraft, id);
    const liveList = fetchedModels[id] || [];
    const modelOptions = Array.from(new Set([...liveList, ...(cfg.presets || [])])).filter(Boolean);

    return `
      <div class="ob-panel">
        <span class="ob-step-tag">Step 04 · Bring Your Own AI</span>
        <h1 id="ob-heading" tabindex="-1" class="ob-title">Connect a model &amp; photos.</h1>
        <p class="ob-sub">API keys stay strictly in this browser. Prefer exploring samples first? Skip AI for now.</p>

        <fieldset class="st-group">
          <legend>Choose AI provider</legend>
          <div class="prov-grid">
            ${PROVIDER_ORDER.map((pid) => {
              const meta = PROVIDERS[pid];
              const checked = pid === id;
              const tag = pid === "ollama" ? "Local" : isProviderReady(aiDraft, pid) ? "Ready" : "Optional";
              return `
                <div class="prov-card-wrap">
                  <input class="visually-hidden" type="radio" id="ob-prov-${esc(pid)}" name="ob-provider" value="${esc(pid)}" ${checked ? "checked" : ""}>
                  <label class="prov-card ${checked ? "is-selected" : ""}" for="ob-prov-${esc(pid)}">
                    <span class="prov-card-name">${esc(meta.label)}</span>
                    <span class="prov-card-tag">${esc(tag)}</span>
                  </label>
                </div>
              `;
            }).join("")}
          </div>
        </fieldset>

        ${
          cfg.editableBaseUrl
            ? `
          <div class="st-field">
            <label for="ob-baseurl">Endpoint Base URL</label>
            <input type="url" id="ob-baseurl" value="${esc(aiDraft.providers[id].baseUrl)}" placeholder="${esc(cfg.defaultBaseUrl || "https://...")}" autocorrect="off" autocapitalize="none" spellcheck="false">
          </div>
        `
            : ""
        }

        ${
          id !== "ollama"
            ? `
          <div class="st-field">
            <label for="ob-apikey">${esc(cfg.label)} API Key (optional now)</label>
            <div class="st-input-row">
              <input
                type="${showKey ? "text" : "password"}"
                id="ob-apikey"
                value="${esc(aiDraft.providers[id].apiKey)}"
                placeholder="${esc(cfg.keyPlaceholder || "Paste API key")}"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
              >
              <button type="button" class="tbtn" id="ob-key-toggle" aria-pressed="${showKey}">${showKey ? "Hide" : "Show"}</button>
            </div>
          </div>
        `
            : ""
        }

        <div class="st-field">
          <label for="ob-model">Model ID</label>
          <div class="st-input-row">
            <input type="text" id="ob-model" list="ob-model-list" value="${esc(aiDraft.providers[id].model)}" placeholder="${esc(cfg.defaultModel || "Enter model ID")}" autocorrect="off" autocapitalize="none" spellcheck="false">
            <button type="button" class="tbtn" id="ob-fetch-models">Fetch models</button>
          </div>
          <datalist id="ob-model-list">
            ${modelOptions.map((m) => `<option value="${esc(m)}">`).join("")}
          </datalist>
          ${
            modelOptions.length
              ? `
            <div class="st-presets">
              ${modelOptions
                .slice(0, 6)
                .map(
                  (m) =>
                    `<button type="button" class="chip ${aiDraft.providers[id].model === m ? "is-active" : ""}" data-ob-model="${esc(m)}">${esc(m)}</button>`
                )
                .join("")}
            </div>
          `
              : ""
          }
          ${modelStatus ? `<p class="st-help" role="status" aria-live="polite">${esc(modelStatus)}</p>` : ""}
        </div>

        <div class="st-field">
          <div class="st-range-head">
            <label for="ob-temp">Creativity (Temperature)</label>
            <span class="m3-range-badge" id="ob-temp-val">${Number(aiDraft.temperature).toFixed(1)}</span>
          </div>
          <div class="st-range-row">
            <span>Precise</span>
            <input
              class="m3-slider"
              type="range"
              id="ob-temp"
              min="0"
              max="1.2"
              step="0.1"
              value="${esc(aiDraft.temperature)}"
              style="--val-pct: ${sliderPercent(aiDraft.temperature)}"
            >
            <span>Inventive</span>
          </div>
        </div>

        <fieldset class="st-group">
          <legend>Dish photography</legend>
          <div class="prov-grid prov-grid-2">
            <div class="prov-card-wrap">
              <input class="visually-hidden" type="radio" id="ob-img-open" name="ob-img-mode" value="open" ${aiDraft.imageMode === "open" ? "checked" : ""}>
              <label class="prov-card ${aiDraft.imageMode === "open" ? "is-selected" : ""}" for="ob-img-open">
                <span class="prov-card-name">Open web photos</span>
                <span class="prov-card-tag">Default · Free</span>
              </label>
            </div>
            <div class="prov-card-wrap">
              <input class="visually-hidden" type="radio" id="ob-img-ai" name="ob-img-mode" value="ai" ${aiDraft.imageMode === "ai" ? "checked" : ""}>
              <label class="prov-card ${aiDraft.imageMode === "ai" ? "is-selected" : ""}" for="ob-img-ai">
                <span class="prov-card-name">AI-generated photos</span>
                <span class="prov-card-tag">Opt-in · Uses key</span>
              </label>
            </div>
          </div>
        </fieldset>

        <div class="ob-foot">
          <button type="button" class="tbtn" id="ob-prev-btn">← Back</button>
          <div class="ob-foot-right">
            <button type="button" class="quiet-act" id="ob-skip-ai-btn">Skip AI for now</button>
            <button type="button" class="go ob-primary" id="ob-finish-btn">Start cooking</button>
          </div>
        </div>
      </div>
    `;
  };

  const render = (focusHeading = false) => {
    const pct = `${Math.round((step / 4) * 100)}%`;
    rootEl.innerHTML = `
      <div class="ob-shell">
        <div class="ob-top">
          <div class="ob-progress-wrap">
            <span class="ob-step-count">0${step} / 04</span>
            <div class="ob-progress" aria-hidden="true">
              <div class="ob-progress-fill" style="width: ${pct}"></div>
            </div>
          </div>
          <button type="button" class="quiet-act" id="ob-skip-btn">Skip for now</button>
        </div>

        <section class="ob-card ob-anim-${esc(direction)}" aria-labelledby="ob-heading">
          ${renderStepBody()}
        </section>
      </div>
    `;

    rootEl.querySelector("#ob-skip-btn")?.addEventListener("click", () => finish({ skipped: true }));
    rootEl.querySelector("#ob-skip-main-btn")?.addEventListener("click", () => finish({ skipped: true }));
    rootEl.querySelector("#ob-skip-ai-btn")?.addEventListener("click", () => finish({ skipped: false }));
    rootEl.querySelector("#ob-next-btn")?.addEventListener("click", () => goStep(step + 1));
    rootEl.querySelector("#ob-prev-btn")?.addEventListener("click", () => goStep(step - 1));
    rootEl.querySelector("#ob-finish-btn")?.addEventListener("click", () => finish({ skipped: false }));

    if (step === 2) {
      rootEl.querySelectorAll('input[name="ob-skill"]').forEach((r) => {
        r.addEventListener("change", () => {
          syncCurrentStepInputs();
          kpDraft.skillLevel = r.value;
          rootEl.querySelectorAll('input[name="ob-skill"]').forEach((el) => {
            el.nextElementSibling?.classList.toggle("is-selected", el.checked);
          });
        });
      });
      rootEl.querySelectorAll("[data-ob-unit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          kpDraft.units = btn.dataset.obUnit === "us" ? "us" : "metric";
          rootEl.querySelectorAll("[data-ob-unit]").forEach((b) => {
            const active = b === btn;
            b.classList.toggle("is-active", active);
            b.setAttribute("aria-checked", String(active));
          });
        });
      });
      rootEl.querySelector("#ob-sv-dec")?.addEventListener("click", () => {
        kpDraft.defaultServings = Math.max(1, Number(kpDraft.defaultServings || 2) - 1);
        const v = rootEl.querySelector("#ob-sv-val");
        if (v) v.textContent = String(kpDraft.defaultServings);
      });
      rootEl.querySelector("#ob-sv-inc")?.addEventListener("click", () => {
        kpDraft.defaultServings = Math.min(16, Number(kpDraft.defaultServings || 2) + 1);
        const v = rootEl.querySelector("#ob-sv-val");
        if (v) v.textContent = String(kpDraft.defaultServings);
      });
    } else if (step === 3) {
      rootEl.querySelectorAll("[data-ob-diet]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.obDiet;
          const idx = kpDraft.diet.indexOf(val);
          if (idx === -1) kpDraft.diet.push(val);
          else kpDraft.diet.splice(idx, 1);
          const on = idx === -1;
          btn.classList.toggle("is-active", on);
          btn.setAttribute("aria-pressed", String(on));
        });
      });
      rootEl.querySelectorAll("[data-ob-eq]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.obEq;
          const idx = kpDraft.equipment.indexOf(val);
          if (idx === -1) kpDraft.equipment.push(val);
          else kpDraft.equipment.splice(idx, 1);
          const on = idx === -1;
          btn.classList.toggle("is-active", on);
          btn.setAttribute("aria-pressed", String(on));
        });
      });
    } else if (step === 4) {
      rootEl.querySelectorAll('input[name="ob-provider"]').forEach((r) => {
        r.addEventListener("change", () => {
          syncCurrentStepInputs();
          aiDraft.activeProvider = r.value;
          showKey = false;
          modelStatus = "";
          render(false);
        });
      });
      rootEl.querySelector("#ob-key-toggle")?.addEventListener("click", () => {
        showKey = !showKey;
        const inp = rootEl.querySelector("#ob-apikey");
        const btn = rootEl.querySelector("#ob-key-toggle");
        if (inp && btn) {
          inp.type = showKey ? "text" : "password";
          btn.textContent = showKey ? "Hide" : "Show";
          btn.setAttribute("aria-pressed", String(showKey));
        }
      });
      rootEl.querySelectorAll("[data-ob-model]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.obModel;
          aiDraft.providers[aiDraft.activeProvider].model = val;
          const inp = rootEl.querySelector("#ob-model");
          if (inp) inp.value = val;
          rootEl.querySelectorAll("[data-ob-model]").forEach((b) => {
            b.classList.toggle("is-active", b === btn);
          });
        });
      });
      rootEl.querySelector("#ob-fetch-models")?.addEventListener("click", async () => {
        syncCurrentStepInputs();
        const pid = aiDraft.activeProvider;
        const btn = rootEl.querySelector("#ob-fetch-models");
        if (btn) btn.disabled = true;
        try {
          const list = await ctx.onFetchModels?.(pid, aiDraft.providers[pid]);
          fetchedModels[pid] = list || [];
          modelStatus = list?.length
            ? `Loaded ${list.length} model${list.length === 1 ? "" : "s"}.`
            : "Connected, no models returned.";
        } catch (err) {
          modelStatus = err?.message || "Could not fetch models.";
        } finally {
          render(false);
        }
      });
      rootEl.querySelector("#ob-temp")?.addEventListener("input", (e) => {
        const val = Number(e.target.value);
        aiDraft.temperature = val;
        e.target.style.setProperty("--val-pct", sliderPercent(val));
        const badge = rootEl.querySelector("#ob-temp-val");
        if (badge) badge.textContent = val.toFixed(1);
      });
      rootEl.querySelectorAll('input[name="ob-img-mode"]').forEach((r) => {
        r.addEventListener("change", () => {
          aiDraft.imageMode = r.value === "ai" ? "ai" : "open";
          rootEl.querySelectorAll('input[name="ob-img-mode"]').forEach((el) => {
            el.nextElementSibling?.classList.toggle("is-selected", el.checked);
          });
        });
      });
    }

    if (focusHeading) {
      rootEl.querySelector("#ob-heading")?.focus({ preventScroll: true });
    }
  };

  render(false);
}

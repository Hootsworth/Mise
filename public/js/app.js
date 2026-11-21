import {
  convertAmount,
  convertStepTemperatures,
  extractTimersFromStep,
  diffRecipes,
  isExploratoryPrompt
} from "./units.js";
import { extractPartialRecipe } from "./stream-parser.js";
import { TimerManager, formatClock } from "./timers.js";
import {
  initThemeToggle,
  setupModalDialog,
  closeTopLayer,
  openAnchoredPopover
} from "./overlays.js";
import {
  loadSelectedProvider,
  saveSelectedProvider,
  loadAiImagesOptIn,
  saveAiImagesOptIn,
  getHealth,
  postJson,
  streamRecipeEndpoint,
  fetchDishIdeas,
  fetchDishImage
} from "./api.js";
import { SAMPLE_RECIPES, SAMPLE_IDEAS } from "./samples.js";
import { CookModeController } from "./cook-mode.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));

const SUGG = [
  "Weeknight miso pasta",
  "Something with leftover rice",
  "Crispy tofu, no fuss"
];

const MODE_LABELS = {
  any: "Mode",
  fridge: "What I have",
  craving: "Ingredient X",
  recreate: "Recreate",
  mealprep: "Meal prep",
  drink: "Drink"
};

const TWEAKS = [
  "Make it vegan",
  "Faster",
  "Spicier",
  "Fewer ingredients",
  "High protein",
  "Cheaper",
  "Explain for a beginner"
];

const MODE_PLACEHOLDERS = {
  any: "A dish, ingredients you have, or a craving…",
  fridge: "Any extras or cravings? (optional)",
  craving: "Describe the vibe, or add ingredient X above",
  recreate: "Describe a restaurant dish or drop a photo",
  mealprep: "Batch lunches for 4 days that reheat well",
  drink: "Smoky citrus spritz or iced hojicha tonic"
};

const REFINE_CHIPS = [
  "Under 20 min",
  "One pan",
  "Comforting",
  "Light & fresh",
  "High protein",
  "More ideas"
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

const STEP_RESCUE_CHIPS = [
  "What should this look or smell like?",
  "Too watery / not thickening",
  "Too salty or acidic",
  "Burning on the bottom — rescue it"
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

const FALLBACK_PROVIDERS = [
  { id: "gemini", label: "Google Gemini", configured: false, supportsImages: true },
  { id: "meta", label: "Meta AI", configured: false, supportsImages: true },
  { id: "openai", label: "OpenAI", configured: false, supportsImages: true },
  { id: "claude", label: "Anthropic Claude", configured: false, supportsImages: false },
  { id: "openrouter", label: "OpenRouter", configured: false, supportsImages: true },
  { id: "ollama", label: "Local Ollama", configured: false, supportsImages: false }
];

function loadJson(key, fallback) {
  try {
    const val = JSON.parse(localStorage.getItem(key) || "null");
    return val ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    // Storage quota exceeded or unavailable
  }
}

const state = {
  view: "home", // "home" | "ideas" | "recipe"
  mode: "any",
  ingDrawerOpen: false,
  libTab: "recent",
  images: [], // attached input photos [{ id, mimeType, dataUrl, name }]
  ingredientTags: [],
  ideasContext: { query: "", mode: "any", ingredients: [], images: [] },
  ideasData: null, // { prompt_summary, options }
  ideasLoading: false,
  ideasError: "",
  ideasSeenTitles: [],
  ideasController: null,
  ideasImageController: null,
  versions: [],
  versionIndex: 0,
  servings: 2,
  unitSystem: "metric",
  checkedIng: new Set(),
  checkedSteps: new Set(),
  streaming: false,
  streamPhase: "",
  streamController: null,
  heroColor: false,
  heroImageLoading: false,
  aiImagesOptIn: loadAiImagesOptIn(),
  seenHeroUrls: new Map(), // title.toLowerCase() -> string[] for cycling open photos
  sessionImageMap: new Map(), // title.toLowerCase() -> { imageUrl, credit, creditUrl, isAi }
  hist: loadJson("mise:hist", []),
  saved: loadJson("mise:saved", []),
  profile: { ...DEFAULT_PROFILE, ...(loadJson("mise:profile", {}) || {}) },
  health: null,
  ingIntelCache: new Map(),
  stepHelpCache: new Map(),
  activePopIngIdx: null,
  activePopStepIdx: null
};

state.unitSystem = state.profile.units === "us" ? "us" : "metric";

const timerManager = new TimerManager();
let cookMode = null;

function activeRecipe() {
  return state.versions[state.versionIndex] || null;
}

function prevRecipeForDiff() {
  if (state.versionIndex <= 0) return null;
  return state.versions[state.versionIndex - 1] || null;
}

function resolveRecipeImage(recipe) {
  if (!recipe) return "";
  if (recipe.imageUrl) return recipe.imageUrl;
  const cached = state.sessionImageMap.get(String(recipe.title || "").toLowerCase());
  return typeof cached === "string" ? cached : cached?.imageUrl || "";
}

function resolveRecipeImageMeta(recipe) {
  if (!recipe) return { imageUrl: "", credit: "", creditUrl: "", isAi: false };
  const cached = state.sessionImageMap.get(String(recipe.title || "").toLowerCase());
  const meta = cached && typeof cached === "object" ? cached : {};
  return {
    imageUrl: recipe.imageUrl || meta.imageUrl || "",
    credit: recipe.imageCredit || meta.credit || "",
    creditUrl: recipe.imageCreditUrl || meta.creditUrl || "",
    isAi: Boolean(recipe.imageIsAi ?? meta.isAi)
  };
}

function showView(which) {
  state.view = which;
  $("#home-view").hidden = which !== "home";
  $("#ideas-view").hidden = which !== "ideas";
  $("#view").hidden = which !== "recipe";
  $("#dock").hidden = which !== "recipe";
  $("#home-err").hidden = true;
  $("#view-err").hidden = true;
  if (which !== "recipe") hidePopovers();
  window.scrollTo(0, 0);
}

function showError(msg) {
  const target = state.view === "recipe" ? $("#view-err") : $("#home-err");
  target.textContent = msg;
  target.hidden = false;
}

function clearErrors() {
  $("#home-err").hidden = true;
  $("#view-err").hidden = true;
}

function flashFeedback(btn, text, duration = 1600) {
  if (!btn) return;
  const orig = btn.dataset.origLabel || btn.textContent;
  btn.dataset.origLabel = orig;
  btn.textContent = text;
  clearTimeout(btn._resetTimer);
  btn._resetTimer = setTimeout(() => {
    btn.textContent = orig;
  }, duration);
}

function hidePopovers() {
  for (const id of ["#ing-popover", "#step-popover"]) {
    const el = $(id);
    if (el && el.matches(":popover-open")) {
      try {
        el.hidePopover();
      } catch {
        // Ignore
      }
    }
  }
}

/* ---------------- Mode & Ingredient Tag Controls ---------------- */

function syncModeUi() {
  const isExploreMode = state.mode === "fridge" || state.mode === "craving";
  const showTags = state.ingDrawerOpen || isExploreMode || state.ingredientTags.length > 0;
  $("#ing-tags-bar").hidden = !showTags;
  const ingBtn = $("#ing-toggle-btn");
  if (ingBtn) {
    ingBtn.textContent = state.ingredientTags.length
      ? `Ingredients (${state.ingredientTags.length})`
      : "+ Ingredients";
    ingBtn.classList.toggle("is-active", showTags);
    ingBtn.setAttribute("aria-expanded", String(showTags));
  }
  const modeBtn = $("#mode-btn");
  if (modeBtn) {
    modeBtn.textContent = state.mode === "any" ? "Mode" : MODE_LABELS[state.mode] || "Mode";
    modeBtn.classList.toggle("is-active", state.mode !== "any");
  }
  document.querySelectorAll("#mode-popover [data-mode]").forEach((b) => {
    const active = b.dataset.mode === state.mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-checked", String(active));
  });
  $("#q").placeholder = MODE_PLACEHOLDERS[state.mode] || MODE_PLACEHOLDERS.any;
  $("#cook-submit").textContent = isExploreMode ? "Find ideas" : "Cook";
  $("#alt-submit").textContent = isExploreMode ? "Single recipe" : "Options grid";
}

function addIngredientTagsFromText(raw) {
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let added = false;
  for (const item of parts) {
    if (!state.ingredientTags.some((t) => t.toLowerCase() === item.toLowerCase())) {
      state.ingredientTags.push(item);
      added = true;
    }
  }
  if (added) {
    renderIngredientTags();
    syncModeUi();
  }
}

function renderIngredientTags() {
  const listEl = $("#ing-tag-list");
  listEl.innerHTML = state.ingredientTags
    .map(
      (tag, idx) =>
        `<span class="ing-tag-pill">${esc(tag)}<button type="button" data-rm-tag="${idx}" aria-label="Remove ${esc(tag)}">×</button></span>`
    )
    .join("");
}

/* ---------------- Image Attachment & Canvas Resize ---------------- */

async function resizeImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Unsupported image format."));
    el.src = dataUrl;
  });

  const maxSide = 1280;
  let { width, height } = img;
  if (width > maxSide || height > maxSide) {
    const ratio = Math.min(maxSide / width, maxSide / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  const compressed = canvas.toDataURL("image/jpeg", 0.82);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    mimeType: "image/jpeg",
    dataUrl: compressed,
    name: file.name || "Photo"
  };
}

async function addImages(files) {
  const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;
  const remaining = Math.max(0, 3 - state.images.length);
  for (const file of list.slice(0, remaining)) {
    try {
      const processed = await resizeImageFile(file);
      state.images.push(processed);
    } catch (err) {
      showError(err.message);
    }
  }
  renderPhotoStrip();
}

function renderPhotoStrip() {
  const strip = $("#photo-strip");
  if (!state.images.length) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  strip.hidden = false;
  strip.innerHTML =
    state.images
      .map(
        (img) => `
      <figure class="photo-thumb">
        <img src="${esc(img.dataUrl)}" alt="${esc(img.name)}">
        <button type="button" class="photo-rm" data-rm-img="${esc(img.id)}" aria-label="Remove photo">×</button>
      </figure>
    `
      )
      .join("") + `<span class="photo-hint">${state.images.length}/3 attached</span>`;
}

/* ---------------- Library (Recent & Saved) ---------------- */

function isSaved(recipe) {
  if (!recipe) return false;
  return state.saved.some((item) => item.title.toLowerCase() === recipe.title.toLowerCase());
}

function serializeRecipeForStorage(recipe) {
  const clone = structuredClone(recipe);
  // Keep lightweight paths (/images/...) and https URLs, strip large base64 strings from localStorage
  if (clone.imageUrl && clone.imageUrl.startsWith("data:") && clone.imageUrl.length > 48000) {
    delete clone.imageUrl;
  }
  return clone;
}

function pushHistory(recipe) {
  const meta = resolveRecipeImageMeta(recipe);
  const imgUrl = meta.imageUrl;
  if (imgUrl) {
    state.sessionImageMap.set(recipe.title.toLowerCase(), meta);
  }
  const storedRecipe = serializeRecipeForStorage({
    ...recipe,
    imageUrl: imgUrl,
    imageCredit: meta.credit,
    imageCreditUrl: meta.creditUrl,
    imageIsAi: meta.isAi
  });
  const entry = {
    title: recipe.title,
    tagline: recipe.tagline || "",
    cuisine: recipe.cuisine || "",
    time_minutes: recipe.time_minutes || 0,
    imageUrl: storedRecipe.imageUrl || "",
    updatedAt: Date.now(),
    recipe: storedRecipe
  };
  state.hist = [entry, ...state.hist.filter((h) => h.title !== recipe.title)].slice(0, 12);
  saveJson("mise:hist", state.hist);

  const sIdx = state.saved.findIndex((s) => s.title.toLowerCase() === recipe.title.toLowerCase());
  if (sIdx !== -1) {
    state.saved[sIdx] = entry;
    saveJson("mise:saved", state.saved);
  }
  renderLibrary();
}

function toggleSaveCurrent() {
  const r = activeRecipe();
  if (!r) return;
  const idx = state.saved.findIndex((s) => s.title.toLowerCase() === r.title.toLowerCase());
  if (idx !== -1) {
    state.saved.splice(idx, 1);
  } else {
    const meta = resolveRecipeImageMeta(r);
    const storedRecipe = serializeRecipeForStorage({
      ...r,
      imageUrl: meta.imageUrl,
      imageCredit: meta.credit,
      imageCreditUrl: meta.creditUrl,
      imageIsAi: meta.isAi
    });
    state.saved.unshift({
      title: r.title,
      tagline: r.tagline || "",
      cuisine: r.cuisine || "",
      time_minutes: r.time_minutes || 0,
      imageUrl: storedRecipe.imageUrl || "",
      updatedAt: Date.now(),
      recipe: storedRecipe
    });
  }
  saveJson("mise:saved", state.saved);
  renderLibrary();
  const btn = $("#save-recipe-btn");
  if (btn) {
    const saved = isSaved(r);
    btn.textContent = saved ? "Saved" : "Save";
    btn.classList.toggle("is-active", saved);
  }
}

function renderLibrary() {
  const countEl = $("#saved-count");
  if (countEl) countEl.textContent = state.saved.length ? `(${state.saved.length})` : "";

  const totalCount = state.hist.length + state.saved.length;
  $("#library").hidden = totalCount === 0;

  document.querySelectorAll(".lib-tab").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.lib === state.libTab);
  });

  const items = state.libTab === "saved" ? state.saved : state.hist;
  const listEl = $("#rlist");
  if (!items.length) {
    listEl.innerHTML = `<p class="lib-empty">${
      state.libTab === "saved"
        ? "No saved recipes yet. Click Save on any recipe to bookmark it here."
        : "No recent recipes yet."
    }</p>`;
    return;
  }

  listEl.innerHTML = items
    .map((item, idx) => {
      const cached = state.sessionImageMap.get(String(item.title || "").toLowerCase());
      const thumb = item.imageUrl || (typeof cached === "string" ? cached : cached?.imageUrl) || "";
      return `
      <div class="lib-row">
        <button type="button" class="lib-open" data-lib-open="${idx}">
          <span class="lib-main">
            ${thumb ? `<img class="lib-thumb" src="${esc(thumb)}" alt="" loading="lazy" width="48" height="48">` : ""}
            <span class="lib-title">${esc(item.title)}</span>
          </span>
          <span class="lib-meta">${item.time_minutes ? `${esc(item.time_minutes)} min` : ""}${item.cuisine ? ` · ${esc(item.cuisine)}` : ""}</span>
        </button>
        <button type="button" class="lib-del" data-lib-del="${idx}" aria-label="Remove ${esc(item.title)}">×</button>
      </div>
    `;
    })
    .join("");
}

function openRecipeInView(recipe, { pushToHistory = false } = {}) {
  const cloned = structuredClone(recipe);
  const existingMeta = resolveRecipeImageMeta(cloned);
  if (existingMeta.imageUrl) {
    cloned.imageUrl = existingMeta.imageUrl;
    cloned.imageCredit = existingMeta.credit;
    cloned.imageCreditUrl = existingMeta.creditUrl;
    cloned.imageIsAi = existingMeta.isAi;
    state.sessionImageMap.set(cloned.title.toLowerCase(), existingMeta);
  }

  state.versions = [cloned];
  state.versionIndex = 0;
  state.servings = Math.max(1, Math.round(cloned.servings || state.profile.defaultServings || 2));
  state.checkedIng.clear();
  state.checkedSteps.clear();
  state.ingIntelCache.clear();
  state.stepHelpCache.clear();
  state.heroImageLoading = false;
  if (pushToHistory) pushHistory(cloned);
  showView("recipe");
  renderRecipe();
  renderDock();
  if (!cloned.imageUrl) {
    hydrateRecipeHeroImage(cloned);
  }
}

/* ---------------- Dish Options Grid (#ideas-view) ---------------- */

function renderIdeasView() {
  const el = $("#ideas-view");
  const data = state.ideasData;

  const headerHtml = `
    <div class="ideas-head">
      <div>
        <button type="button" class="tbtn" id="ideas-back-btn">← Back</button>
        <h2 class="ideas-title">Choose what to make</h2>
        <p class="ideas-sub">${esc(
          data?.prompt_summary ||
            (state.ideasLoading ? "Curating varied dish options for you…" : "Pick a direction to cook in full.")
        )}</p>
      </div>
      ${
        data?.options?.length && !state.ideasLoading
          ? `<button type="button" class="go" id="ideas-surprise-btn">Surprise me</button>`
          : ""
      }
    </div>
    <div class="ideas-refine">
      ${REFINE_CHIPS.map(
        (c) => `<button type="button" class="chip" data-refine="${esc(c)}" ${state.ideasLoading ? "disabled" : ""}>${esc(c)}</button>`
      ).join("")}
    </div>
  `;

  if (state.ideasLoading) {
    const skeletons = Array.from({ length: 6 })
      .map(
        () => `
        <div class="idea-card-sk">
          <div class="dish-frame is-loading"></div>
          <div class="idea-body">
            <div class="bar"></div>
            <div class="bar"></div>
            <div class="bar"></div>
          </div>
        </div>
      `
      )
      .join("");
    el.innerHTML = `${headerHtml}<div class="ideas-grid">${skeletons}</div>`;
    $("#ideas-back-btn", el).addEventListener("click", () => {
      state.ideasController?.abort();
      state.ideasImageController?.abort();
      showView("home");
    });
    return;
  }

  if (state.ideasError) {
    el.innerHTML = `${headerHtml}<div class="err">${esc(state.ideasError)}</div>`;
    $("#ideas-back-btn", el).addEventListener("click", () => showView("home"));
    return;
  }

  const options = data?.options || [];
  const cardsHtml = options
    .map((opt, idx) => {
      const frameClass = opt.imageUrl ? "dish-frame" : opt.imageLoading ? "dish-frame is-loading" : "dish-frame";
      const frameContent = opt.imageUrl
        ? `<img src="${esc(opt.imageUrl)}" alt="${esc(opt.title)}" loading="lazy" width="640" height="400">`
        : `<div class="dish-frame-empty">${opt.imageLoading ? "" : esc(opt.cuisine || "Dish idea")}</div>`;

      const usesPills = (opt.uses || []).slice(0, 3).map((u) => `<span class="idea-pill">${esc(u)}</span>`).join("");
      const extraBadge = opt.pantry_only
        ? `<span class="idea-pill is-pantry">Pantry ready</span>`
        : opt.extras_needed?.length
        ? `<span class="idea-pill">+${opt.extras_needed.length} extra${opt.extras_needed.length > 1 ? "s" : ""}</span>`
        : "";

      return `
        <button type="button" class="idea-card" data-pick-idea="${idx}">
          <div class="${frameClass}">${frameContent}</div>
          <div class="idea-body">
            <div class="idea-meta">${esc(opt.time_minutes)} min · ${esc(opt.difficulty)}${opt.vibe ? ` · ${esc(opt.vibe)}` : ""}</div>
            <h3 class="idea-title">${esc(opt.title)}</h3>
            <p class="idea-tag">${esc(opt.tagline)}</p>
            <div class="idea-uses">${usesPills}${extraBadge}</div>
            <div class="idea-cta">Cook this →</div>
          </div>
        </button>
      `;
    })
    .join("");

  el.innerHTML = `${headerHtml}<div class="ideas-grid">${cardsHtml}</div>`;

  $("#ideas-back-btn", el).addEventListener("click", () => {
    state.ideasImageController?.abort();
    showView("home");
  });

  $("#ideas-surprise-btn", el)?.addEventListener("click", () => {
    if (!options.length) return;
    const pick = options[Math.floor(Math.random() * options.length)];
    cookSelectedOption(pick);
  });

  el.querySelectorAll("[data-refine]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const label = btn.dataset.refine;
      const isSample = options.some((o) => o.sampleRecipeId);
      if (isSample && !hasAnyConfiguredProvider()) {
        showError("Configure a server API key to generate custom variations.");
        return;
      }
      openIdeasGrid({
        ...state.ideasContext,
        refinement: label === "More ideas" ? "Explore completely fresh culinary angles" : label,
        excludeTitles: state.ideasSeenTitles
      });
    });
  });

  el.querySelectorAll("[data-pick-idea]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const option = options[Number(btn.dataset.pickIdea)];
      if (option) cookSelectedOption(option);
    });
  });
}

async function hydrateIdeasImages(options) {
  if (!options?.length) return;
  if (state.health && !state.health.imageGenerationAvailable) return;

  state.ideasImageController?.abort();
  state.ideasImageController = new AbortController();
  const { signal } = state.ideasImageController;

  const queue = options
    .map((opt, idx) => ({ opt, idx }))
    .filter(({ opt }) => !opt.imageUrl);

  if (!queue.length) return;
  queue.forEach(({ opt }) => {
    opt.imageLoading = true;
  });
  renderIdeasView();

  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length && !signal.aborted) {
      const next = queue.shift();
      if (!next) break;
      const { opt } = next;
      const res = await fetchDishImage(
        {
          title: opt.title,
          tagline: opt.tagline,
          cuisine: opt.cuisine,
          visualPrompt: opt.visual_prompt,
          useAi: state.aiImagesOptIn
        },
        signal
      );
      if (signal.aborted) return;
      opt.imageLoading = false;
      if (res?.imageUrl) {
        opt.imageUrl = res.imageUrl;
        opt.imageCredit = res.credit || "";
        opt.imageCreditUrl = res.creditUrl || "";
        opt.imageIsAi = Boolean(res.isAi);
        state.sessionImageMap.set(opt.title.toLowerCase(), {
          imageUrl: res.imageUrl,
          credit: opt.imageCredit,
          creditUrl: opt.imageCreditUrl,
          isAi: opt.imageIsAi
        });
      }
      if (state.view === "ideas" && !state.ideasLoading) {
        renderIdeasView();
      }
    }
  });

  await Promise.allSettled(workers);
}

async function openIdeasGrid({ query = "", ingredients = [], mode = "any", images = [], refinement = "", excludeTitles = [] } = {}) {
  clearErrors();
  state.ideasController?.abort();
  state.ideasImageController?.abort();
  state.ideasController = new AbortController();

  state.ideasContext = { query, ingredients: [...ingredients], mode, images: [...images] };
  state.ideasLoading = true;
  state.ideasError = "";
  showView("ideas");
  renderIdeasView();

  try {
    const res = await fetchDishIdeas(
      {
        query,
        ingredients,
        mode,
        images: images.map((img) => ({ mimeType: img.mimeType, data: img.dataUrl })),
        refinement,
        excludeTitles,
        profile: state.profile
      },
      state.ideasController.signal
    );

    state.ideasLoading = false;
    state.ideasData = res;
    for (const opt of res.options || []) {
      if (opt.title && !state.ideasSeenTitles.includes(opt.title)) {
        state.ideasSeenTitles.push(opt.title);
      }
    }
    renderIdeasView();
    hydrateIdeasImages(res.options);
  } catch (err) {
    if (err?.name === "AbortError") return;
    state.ideasLoading = false;
    state.ideasError = err?.message || "Could not generate dish options.";
    renderIdeasView();
  }
}

function openSampleIdeasGrid() {
  state.ideasLoading = false;
  state.ideasError = "";
  state.ideasData = structuredClone(SAMPLE_IDEAS);
  state.ideasContext = {
    query: "miso, mushrooms, pantry staples",
    ingredients: ["miso", "mushrooms", "rice"],
    mode: "fridge",
    images: []
  };
  showView("ideas");
  renderIdeasView();
}

function cookSelectedOption(option) {
  if (!option) return;
  state.ideasImageController?.abort();

  if (option.sampleRecipeId) {
    const sample = SAMPLE_RECIPES.find((s) => s.id === option.sampleRecipeId);
    if (sample) {
      openRecipeInView(sample, { pushToHistory: false });
      return;
    }
  }

  runRecipeStream(
    "/api/generate",
    {
      query: state.ideasContext.query,
      ingredients: state.ideasContext.ingredients,
      selectedOption: option,
      mode: state.ideasContext.mode,
      images: state.ideasContext.images.map((img) => ({ mimeType: img.mimeType, data: img.dataUrl })),
      profile: state.profile
    },
    "Writing",
    option.imageUrl
      ? {
          imageUrl: option.imageUrl,
          credit: option.imageCredit || "",
          creditUrl: option.imageCreditUrl || "",
          isAi: Boolean(option.imageIsAi)
        }
      : null
  );
}

/* ---------------- Recipe Hero Image ---------------- */

async function hydrateRecipeHeroImage(recipe, { forceRefresh = false, useAi = state.aiImagesOptIn } = {}) {
  if (!recipe || !recipe.title) return;
  if (state.health && !state.health.imageGenerationAvailable) return;

  const key = recipe.title.toLowerCase();
  const seenList = state.seenHeroUrls.get(key) || [];
  const currentUrl = resolveRecipeImage(recipe);
  if (currentUrl && !seenList.includes(currentUrl)) {
    seenList.push(currentUrl);
  }
  const excludeUrls = forceRefresh ? [...seenList] : [];

  state.heroImageLoading = true;
  if (state.view === "recipe") renderRecipe();

  const res = await fetchDishImage({
    title: recipe.title,
    tagline: recipe.tagline,
    cuisine: recipe.cuisine,
    visualPrompt: recipe.visual_prompt,
    useAi,
    excludeUrls,
    forceRefresh
  });

  state.heroImageLoading = false;
  const current = activeRecipe();
  if (current && current.title === recipe.title && res?.imageUrl) {
    if (!seenList.includes(res.imageUrl)) seenList.push(res.imageUrl);
    state.seenHeroUrls.set(key, seenList);
    current.imageUrl = res.imageUrl;
    current.imageCredit = res.credit || "";
    current.imageCreditUrl = res.creditUrl || "";
    current.imageIsAi = Boolean(res.isAi);
    state.sessionImageMap.set(key, {
      imageUrl: res.imageUrl,
      credit: current.imageCredit,
      creditUrl: current.imageCreditUrl,
      isAi: current.imageIsAi
    });
    pushHistory(current);
  } else if (forceRefresh && !res?.imageUrl && seenList.length > 1) {
    // Wrap back around previously found open photos if no more new matches exist
    state.seenHeroUrls.set(key, currentUrl ? [currentUrl] : []);
  }
  if (state.view === "recipe") renderRecipe();
}

/* ---------------- Recipe Rendering ---------------- */

function renderRecipe() {
  const r = activeRecipe();
  if (!r) return;

  const isStreaming = state.streaming;
  const prev = prevRecipeForDiff();
  const diff = prev ? diffRecipes(prev, r) : { changedIngredientIdx: new Set(), changedStepIdx: new Set() };
  const scaleRatio = state.servings / Math.max(1, r.servings || state.servings || 1);
  const saved = isSaved(r);
  const heroMeta = resolveRecipeImageMeta(r);
  const heroUrl = heroMeta.imageUrl;
  const canOptInAiImage = Boolean(state.health?.aiImageGenerationAvailable) && !heroMeta.isAi;

  const timeDetails = [];
  if (r.prep_minutes != null) timeDetails.push(`${r.prep_minutes}m prep`);
  if (r.cook_minutes != null) timeDetails.push(`${r.cook_minutes}m cook`);

  const creditHtml = heroMeta.credit
    ? `<figcaption class="hero-credit">Photo · ${
        heroMeta.creditUrl
          ? `<a href="${esc(heroMeta.creditUrl)}" target="_blank" rel="noopener noreferrer">${esc(heroMeta.credit)}</a>`
          : esc(heroMeta.credit)
      }</figcaption>`
    : "";

  const heroHtml = heroUrl
    ? `
      <figure class="recipe-hero">
        <div class="dish-frame ${state.heroColor ? "is-color" : ""}">
          <img src="${esc(heroUrl)}" alt="${esc(r.title)}" fetchpriority="high" width="1200" height="750">
        </div>
        <div class="hero-tools">
          <button type="button" class="hero-btn" id="hero-color-btn">${state.heroColor ? "B&W" : "Color"}</button>
          <button type="button" class="hero-btn" id="hero-refresh-btn">New photo</button>
          ${canOptInAiImage ? `<button type="button" class="hero-btn" id="hero-ai-btn">Generate with AI</button>` : ""}
        </div>
        ${creditHtml}
      </figure>
    `
    : state.heroImageLoading
    ? `<figure class="recipe-hero"><div class="dish-frame is-loading"><div class="dish-frame-empty">Finding dish photograph…</div></div></figure>`
    : "";

  const ingHtml = (r.ingredients || [])
    .map((ing, i) => {
      const amt = convertAmount(ing, scaleRatio, state.unitSystem);
      const on = state.checkedIng.has(i) ? "on" : "";
      const revised = diff.changedIngredientIdx.has(i) ? `<span class="rev-tag">revised</span>` : "";
      return `
        <li class="ing-row ${on}" data-ing-idx="${i}">
          <button type="button" class="ing-check" data-toggle-ing="${i}" aria-pressed="${Boolean(on)}">
            <span class="box" aria-hidden="true"></span>
            <span class="t">
              ${amt ? `<span class="amt">${esc(amt)}</span> ` : ""}${esc(ing.item)}${
                ing.note ? ` <span class="sub">${esc(ing.note)}</span>` : ""
              }${revised}
            </span>
          </button>
          ${
            isStreaming
              ? ""
              : `<button type="button" class="inline-ai-btn" data-ing-ai="${i}" aria-label="Why or swap ${esc(ing.item)}">Swap</button>`
          }
        </li>
      `;
    })
    .join("");

  const stepsHtml = (r.steps || [])
    .map((st, i) => {
      const on = state.checkedSteps.has(i) ? "on" : "";
      const revised = diff.changedStepIdx.has(i) ? `<span class="rev-tag">revised</span>` : "";
      const text = convertStepTemperatures(st.text, state.unitSystem);
      const timers = !isStreaming ? extractTimersFromStep(st) : [];
      const timerButtons = timers
        .map((tm) => {
          const id = `step-${i}-${tm.seconds}`;
          return `<button type="button" class="timer-pill" data-step-timer="${esc(id)}" data-seconds="${tm.seconds}" data-default-label="${esc(tm.label)}" data-step-title="${esc(st.title)}">${esc(tm.label)} · Start</button>`;
        })
        .join("");

      return `
        <li class="step-row ${on}" data-step-idx="${i}">
          <div class="step-body">
            <div class="step-head">
              <button type="button" class="step-toggle" data-toggle-step="${i}" aria-pressed="${Boolean(on)}">
                <h3>${esc(st.title || "Step")}${revised}</h3>
              </button>
              ${
                isStreaming
                  ? ""
                  : `<button type="button" class="inline-ai-btn" data-step-ai="${i}" aria-label="Ask chef about step ${i + 1}">Ask</button>`
              }
            </div>
            <p class="step-text" data-toggle-step="${i}">${esc(text)}</p>
            ${
              timerButtons || st.minutes
                ? `<div class="step-tools">${timerButtons || `<span class="mins">${esc(st.minutes)} min</span>`}</div>`
                : ""
            }
          </div>
        </li>
      `;
    })
    .join("");

  const tipsHtml =
    r.tips && r.tips.length
      ? `<section class="tips"><h2 class="h">Notes</h2>${r.tips.map((t) => `<p>${esc(t)}</p>`).join("")}</section>`
      : "";

  const enrichHtml = !isStreaming
    ? `
      <section class="intel" aria-labelledby="intel-heading">
        <h2 id="intel-heading" class="h">Culinary Intelligence</h2>
        <div class="accordion">
          ${renderEnrichSection("nutrition", "Nutrition Estimate", r.enrichment?.nutrition)}
          ${renderEnrichSection("flavor", "Flavor Architecture", r.enrichment?.flavor)}
          ${renderEnrichSection("pairings", "Pairings & Plating", r.enrichment?.pairings)}
          ${renderEnrichSection("storage", "Make-Ahead & Storage", r.enrichment?.storage)}
        </div>
      </section>
    `
    : "";

  const toolbarHtml = isStreaming
    ? `<div class="recipe-bar">
        <span class="stream-badge"><span class="pulse-dot"></span> Writing ${esc(state.streamPhase || "recipe")}…</span>
        <button type="button" class="tbtn" id="stop-stream-btn">Stop</button>
      </div>`
    : `<div class="recipe-bar">
        <div class="bar-left">
          <button type="button" class="go" id="cook-mode-btn">Cook Mode</button>
          <button type="button" class="tbtn ${saved ? "is-active" : ""}" id="save-recipe-btn">${saved ? "Saved" : "Save"}</button>
        </div>
        <div class="bar-right">
          ${
            !heroUrl && !state.heroImageLoading && state.health?.imageGenerationAvailable !== false
              ? `<button type="button" class="tbtn" id="gen-photo-btn">Photo</button>`
              : ""
          }
          <button type="button" class="tbtn" id="copy-md-btn">Copy</button>
          <button type="button" class="tbtn" id="copy-shop-btn">Groceries</button>
          <button type="button" class="tbtn" id="print-btn">Print</button>
        </div>
      </div>`;

  const changeBanner =
    r.change_summary && !isStreaming
      ? `<p class="change-banner"><strong>Revised:</strong> ${esc(r.change_summary)}</p>`
      : "";

  $("#view").innerHTML = `
    ${toolbarHtml}
    ${r.cuisine ? `<div class="kicker">${esc(r.cuisine)}</div>` : ""}
    <h1 class="title">${esc(r.title || "Drafting recipe…")}</h1>
    ${r.tagline ? `<p class="tag">${esc(r.tagline)}</p>` : ""}
    ${changeBanner}
    ${heroHtml}
    <div class="meta">
      <div>
        <small>Time</small>
        <b>${r.time_minutes ? `${esc(r.time_minutes)} min` : "—"}</b>
        ${timeDetails.length ? `<span class="meta-sub">${esc(timeDetails.join(" · "))}</span>` : ""}
      </div>
      <div>
        <small>Difficulty</small>
        <b>${esc(r.difficulty || "—")}</b>
      </div>
      <div>
        <small>Serves</small>
        <div class="step-ctl">
          <button type="button" id="dec-sv" aria-label="Fewer servings">−</button>
          <b id="sv-val">${state.servings}</b>
          <button type="button" id="inc-sv" aria-label="More servings">+</button>
        </div>
      </div>
      <div>
        <small>Units</small>
        <div class="unit-seg" role="group" aria-label="Unit system">
          <button type="button" class="seg-btn ${state.unitSystem === "metric" ? "is-active" : ""}" data-unit="metric">Metric</button>
          <button type="button" class="seg-btn ${state.unitSystem === "us" ? "is-active" : ""}" data-unit="us">US</button>
        </div>
      </div>
    </div>

    <div class="cols">
      <section>
        <h2 class="h">Ingredients</h2>
        ${
          ingHtml
            ? `<ul class="ing" id="ing">${ingHtml}</ul>`
            : `<div class="sk-lines"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>`
        }
      </section>
      <section>
        <h2 class="h">Method</h2>
        ${
          stepsHtml
            ? `<ol class="steps" id="steps">${stepsHtml}</ol>`
            : `<div class="sk-lines"><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>`
        }
      </section>
    </div>

    ${tipsHtml}
    ${enrichHtml}
  `;

  syncStepTimersUi();
  bindRecipeEvents();
}

function renderEnrichSection(sectionKey, label, cached) {
  return `
    <details class="intel-item" data-enrich="${esc(sectionKey)}">
      <summary>${esc(label)}</summary>
      <div class="intel-body" id="intel-body-${esc(sectionKey)}">
        ${cached ? renderEnrichContent(sectionKey, cached) : `<p class="intel-hint">Opens on demand — asks Mise to analyze this recipe.</p>`}
      </div>
    </details>
  `;
}

function renderEnrichContent(sectionKey, data) {
  if (!data) return "";
  if (sectionKey === "nutrition") {
    const p = data.per_serving || {};
    const stats = [
      ["Calories", p.calories != null ? `${Math.round(p.calories)}` : "—"],
      ["Protein", p.protein_g != null ? `${Math.round(p.protein_g)} g` : "—"],
      ["Carbs", p.carbs_g != null ? `${Math.round(p.carbs_g)} g` : "—"],
      ["Fat", p.fat_g != null ? `${Math.round(p.fat_g)} g` : "—"],
      ["Fiber", p.fiber_g != null ? `${Math.round(p.fiber_g)} g` : "—"],
      ["Sodium", p.sodium_mg != null ? `${Math.round(p.sodium_mg)} mg` : "—"]
    ];
    const tags = (data.dietary_tags || []).map((t) => `<span class="tag-pill">${esc(t)}</span>`).join("");
    return `
      <div class="nut-grid">
        ${stats.map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join("")}
      </div>
      ${tags ? `<div class="tag-row">${tags}</div>` : ""}
      ${data.note ? `<p class="intel-note">${esc(data.note)}</p>` : ""}
    `;
  }

  if (sectionKey === "flavor") {
    const axes = data.axes || {};
    const keys = ["salt", "acid", "fat", "heat", "sweet", "umami"];
    const bars = keys
      .map((k) => {
        const val = Math.max(0, Math.min(10, Number(axes[k] ?? 0)));
        return `
          <div class="flavor-row">
            <span class="flavor-lbl">${esc(k)}</span>
            <div class="flavor-track" aria-label="${esc(k)} ${val} out of 10">
              <div class="flavor-fill" style="width:${val * 10}%"></div>
            </div>
            <span class="flavor-num">${val}</span>
          </div>
        `;
      })
      .join("");
    const adj = (data.finish_adjustments || []).map((a) => `<li>${esc(a)}</li>`).join("");
    return `
      <div class="flavor-grid">${bars}</div>
      ${data.summary ? `<p class="intel-summary">${esc(data.summary)}</p>` : ""}
      ${adj ? `<ul class="intel-list">${adj}</ul>` : ""}
    `;
  }

  if (sectionKey === "pairings") {
    const rows = [
      ["Wine", data.wine],
      ["Zero-Proof", data.zero_proof],
      ["Side", data.side]
    ].filter(([, v]) => v && v.name);
    return `
      <div class="pair-grid">
        ${rows
          .map(
            ([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v.name)}</b><p>${esc(v.why || "")}</p></div>`
          )
          .join("")}
      </div>
      ${data.plating ? `<p class="intel-note"><strong>Plating:</strong> ${esc(data.plating)}</p>` : ""}
    `;
  }

  if (sectionKey === "storage") {
    const rows = [
      ["Make Ahead", data.make_ahead],
      ["Refrigerate", data.fridge],
      ["Freeze", data.freezer],
      ["Reheat", data.reheat]
    ].filter(([, v]) => v);
    return `
      <div class="pair-grid">
        ${rows.map(([k, v]) => `<div><small>${esc(k)}</small><p>${esc(v)}</p></div>`).join("")}
      </div>
    `;
  }
  return "";
}

function bindRecipeEvents() {
  const view = $("#view");

  $("#stop-stream-btn", view)?.addEventListener("click", () => {
    state.streamController?.abort();
  });

  $("#cook-mode-btn", view)?.addEventListener("click", () => {
    const r = activeRecipe();
    if (r) cookMode.open(r, 0);
  });

  $("#save-recipe-btn", view)?.addEventListener("click", toggleSaveCurrent);

  $("#hero-color-btn", view)?.addEventListener("click", () => {
    state.heroColor = !state.heroColor;
    renderRecipe();
  });

  $("#hero-refresh-btn", view)?.addEventListener("click", () => {
    const r = activeRecipe();
    if (r) hydrateRecipeHeroImage(r, { forceRefresh: true, useAi: state.aiImagesOptIn });
  });

  $("#hero-ai-btn", view)?.addEventListener("click", () => {
    const r = activeRecipe();
    if (r) hydrateRecipeHeroImage(r, { forceRefresh: true, useAi: true });
  });

  $("#gen-photo-btn", view)?.addEventListener("click", () => {
    const r = activeRecipe();
    if (r) hydrateRecipeHeroImage(r, { forceRefresh: true, useAi: state.aiImagesOptIn });
  });

  $("#copy-md-btn", view)?.addEventListener("click", (e) => {
    const md = formatRecipeMarkdown(activeRecipe());
    navigator.clipboard?.writeText(md).then(() => flashFeedback(e.currentTarget, "Copied"));
  });

  $("#copy-shop-btn", view)?.addEventListener("click", (e) => {
    const list = formatGroceryList(activeRecipe());
    navigator.clipboard?.writeText(list).then(() => flashFeedback(e.currentTarget, "Copied"));
  });

  $("#print-btn", view)?.addEventListener("click", () => window.print());

  $("#dec-sv", view)?.addEventListener("click", () => {
    if (state.servings > 1) {
      state.servings--;
      renderRecipe();
    }
  });

  $("#inc-sv", view)?.addEventListener("click", () => {
    if (state.servings < 24) {
      state.servings++;
      renderRecipe();
    }
  });

  view.querySelectorAll("[data-unit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.unit;
      if (next && next !== state.unitSystem) {
        state.unitSystem = next;
        renderRecipe();
      }
    });
  });

  view.querySelectorAll("[data-toggle-ing]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.toggleIng);
      if (state.checkedIng.has(idx)) state.checkedIng.delete(idx);
      else state.checkedIng.add(idx);
      const row = btn.closest(".ing-row");
      const isOn = state.checkedIng.has(idx);
      row?.classList.toggle("on", isOn);
      btn.setAttribute("aria-pressed", String(isOn));
    });
  });

  view.querySelectorAll("[data-toggle-step]").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.toggleStep);
      if (state.checkedSteps.has(idx)) state.checkedSteps.delete(idx);
      else state.checkedSteps.add(idx);
      const row = el.closest(".step-row");
      const isOn = state.checkedSteps.has(idx);
      row?.classList.toggle("on", isOn);
      row?.querySelector("[data-toggle-step]")?.setAttribute("aria-pressed", String(isOn));
    });
  });

  view.querySelectorAll("[data-step-timer]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      timerManager.startOrToggle(
        btn.dataset.stepTimer,
        `${btn.dataset.stepTitle} (${btn.dataset.defaultLabel})`,
        Number(btn.dataset.seconds)
      );
    });
  });

  view.querySelectorAll("[data-ing-ai]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openIngredientPopover(Number(btn.dataset.ingAi), btn);
    });
  });

  view.querySelectorAll("[data-step-ai]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openStepPopover(Number(btn.dataset.stepAi), btn);
    });
  });

  view.querySelectorAll("details[data-enrich]").forEach((det) => {
    det.addEventListener("toggle", () => {
      if (det.open) handleEnrichOpen(det.dataset.enrich);
    });
  });
}

async function handleEnrichOpen(section) {
  const r = activeRecipe();
  if (!r) return;
  if (r.enrichment?.[section]) return;
  const bodyEl = $(`#intel-body-${section}`);
  if (!bodyEl) return;

  bodyEl.innerHTML = `<p class="intel-loading">Analyzing ${esc(section)}…</p>`;
  try {
    const data = await postJson("/api/enrich", {
      recipe: r,
      section,
      profile: state.profile
    });
    r.enrichment = { ...(r.enrichment || {}), [section]: data };
    pushHistory(r);
    bodyEl.innerHTML = renderEnrichContent(section, data);
  } catch (err) {
    bodyEl.innerHTML = `<p class="intel-err">${esc(err.message)}</p>`;
  }
}

/* ---------------- Inline Popovers (Ingredient & Step) ---------------- */

async function openIngredientPopover(ingIdx, triggerEl, customQuestion = "") {
  const r = activeRecipe();
  if (!r || !r.ingredients?.[ingIdx]) return;
  const ing = r.ingredients[ingIdx];
  const pop = $("#ing-popover");
  state.activePopIngIdx = ingIdx;

  const cacheKey = `${state.versionIndex}:${ingIdx}`;
  const cached = !customQuestion ? state.ingIntelCache.get(cacheKey) : null;

  openAnchoredPopover(pop, triggerEl);

  const renderPopBody = (status, data, errMsg = "") => {
    const scaleRatio = state.servings / Math.max(1, r.servings || state.servings || 1);
    const scaledAmt = convertAmount(ing, scaleRatio, state.unitSystem);

    let bodyHtml = "";
    if (status === "loading") {
      bodyHtml = `<p class="pop-status">Consulting test kitchen…</p>`;
    } else if (status === "error") {
      bodyHtml = `<p class="pop-err">${esc(errMsg)}</p>`;
    } else if (data) {
      const swapsHtml = (data.swaps || [])
        .map(
          (sw, sIdx) => `
          <div class="swap-row">
            <div class="swap-info">
              <b>${esc(sw.amount != null ? `${sw.amount}${sw.unit ? ` ${sw.unit}` : ""} ` : "")}${esc(sw.item)}</b>
              ${sw.ratio_note ? `<small>${esc(sw.ratio_note)}</small>` : ""}
            </div>
            <button type="button" class="tbtn pop-apply-swap" data-swap-idx="${sIdx}">Apply</button>
          </div>
        `
        )
        .join("");

      bodyHtml = `
        ${data.answer ? `<div class="pop-answer"><strong>Answer:</strong> ${esc(data.answer)}</div>` : ""}
        ${data.role ? `<p class="pop-p"><strong>Why it’s here:</strong> ${esc(data.role)}</p>` : ""}
        ${data.prep_tip ? `<p class="pop-p"><strong>Prep:</strong> ${esc(data.prep_tip)}</p>` : ""}
        ${swapsHtml ? `<div class="pop-swaps"><div class="pop-subhead">Smart swaps (updates steps automatically)</div>${swapsHtml}</div>` : ""}
      `;
    }

    pop.innerHTML = `
      <div class="pop-head">
        <div>
          <small>Ingredient</small>
          <strong>${scaledAmt ? `${esc(scaledAmt)} ` : ""}${esc(ing.item)}</strong>
        </div>
        <button type="button" class="pop-close" aria-label="Close">×</button>
      </div>
      <div class="pop-body">${bodyHtml}</div>
      <form class="pop-form" id="ing-pop-form">
        <input type="text" id="ing-pop-q" autocomplete="off" placeholder="Ask about this ingredient or another sub…" aria-label="Ask about this ingredient">
        <button type="submit" class="go">Ask</button>
      </form>
    `;

    pop.querySelector(".pop-close").addEventListener("click", () => pop.hidePopover());
    pop.querySelector("#ing-pop-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = pop.querySelector("#ing-pop-q").value.trim();
      if (q) openIngredientPopover(ingIdx, triggerEl, q);
    });

    pop.querySelectorAll(".pop-apply-swap").forEach((btn) => {
      btn.addEventListener("click", () => {
        const swap = data.swaps[Number(btn.dataset.swapIdx)];
        if (swap) {
          pop.hidePopover();
          runRecipeStream(
            "/api/apply-swap",
            {
              recipe: r,
              ingredientIndex: ingIdx,
              swap,
              profile: state.profile
            },
            "Swapping ingredient"
          );
        }
      });
    });
  };

  if (cached) {
    renderPopBody("ready", cached);
    return;
  }

  renderPopBody("loading", null);
  try {
    const res = await postJson("/api/ingredient-intel", {
      recipe: r,
      ingredientIndex: ingIdx,
      question: customQuestion,
      profile: state.profile
    });
    if (!customQuestion) state.ingIntelCache.set(cacheKey, res);
    if (state.activePopIngIdx === ingIdx) renderPopBody("ready", res);
  } catch (err) {
    if (state.activePopIngIdx === ingIdx) renderPopBody("error", null, err.message);
  }
}

function openStepPopover(stepIdx, triggerEl) {
  const r = activeRecipe();
  if (!r || !r.steps?.[stepIdx]) return;
  const st = r.steps[stepIdx];
  const pop = $("#step-popover");
  state.activePopStepIdx = stepIdx;

  openAnchoredPopover(pop, triggerEl);

  const cacheKey = `${state.versionIndex}:${stepIdx}`;
  const cached = state.stepHelpCache.get(cacheKey);

  const renderStepPop = (status, data, errMsg = "") => {
    let outHtml = "";
    if (status === "loading") {
      outHtml = `<p class="pop-status">Asking chef…</p>`;
    } else if (status === "error") {
      outHtml = `<p class="pop-err">${esc(errMsg)}</p>`;
    } else if (data) {
      outHtml = `
        <div class="pop-answer">
          <p>${esc(data.answer)}</p>
          ${data.sensory_cue ? `<p class="cook-cue">Check: ${esc(data.sensory_cue)}</p>` : ""}
          ${
            data.suggested_revision
              ? `<button type="button" class="tbtn" id="step-apply-rev">Apply fix: ${esc(data.suggested_revision)}</button>`
              : ""
          }
        </div>
      `;
    }

    pop.innerHTML = `
      <div class="pop-head">
        <div>
          <small>Step ${stepIdx + 1}</small>
          <strong>${esc(st.title)}</strong>
        </div>
        <button type="button" class="pop-close" aria-label="Close">×</button>
      </div>
      <div class="pop-chips">
        ${STEP_RESCUE_CHIPS.map((c) => `<button type="button" class="chip step-q-chip">${esc(c)}</button>`).join("")}
      </div>
      <div class="pop-body">${outHtml}</div>
      <form class="pop-form" id="step-pop-form">
        <input type="text" id="step-pop-q" autocomplete="off" placeholder="Describe what’s happening in the pan…" aria-label="Ask chef about this step">
        <button type="submit" class="go">Ask</button>
      </form>
    `;

    pop.querySelector(".pop-close").addEventListener("click", () => pop.hidePopover());

    const submitQuestion = async (q) => {
      renderStepPop("loading", null);
      try {
        const res = await postJson("/api/step-help", {
          recipe: r,
          stepIndex: stepIdx,
          question: q,
          profile: state.profile
        });
        state.stepHelpCache.set(cacheKey, res);
        if (state.activePopStepIdx === stepIdx) renderStepPop("ready", res);
      } catch (err) {
        if (state.activePopStepIdx === stepIdx) renderStepPop("error", null, err.message);
      }
    };

    pop.querySelectorAll(".step-q-chip").forEach((chip) => {
      chip.addEventListener("click", () => submitQuestion(chip.textContent));
    });

    pop.querySelector("#step-pop-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = pop.querySelector("#step-pop-q");
      if (input.value.trim()) submitQuestion(input.value.trim());
    });

    pop.querySelector("#step-apply-rev")?.addEventListener("click", () => {
      if (data?.suggested_revision) {
        pop.hidePopover();
        reviseRecipe(data.suggested_revision);
      }
    });
  };

  renderStepPop(cached ? "ready" : "idle", cached || null);
}

/* ---------------- Dock & Version History ---------------- */

function renderDock() {
  const verBox = $("#version-pills");
  if (!verBox) return;
  if (state.versions.length <= 1) {
    verBox.innerHTML = "";
  } else {
    verBox.innerHTML = state.versions
      .map(
        (v, idx) =>
          `<button type="button" class="ver-pill ${idx === state.versionIndex ? "is-active" : ""}" data-ver="${idx}" title="${esc(v.change_summary || v.title)}">v${idx + 1}</button>`
      )
      .join("");
    verBox.querySelectorAll("[data-ver]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.streaming) return;
        state.versionIndex = Number(btn.dataset.ver);
        state.ingIntelCache.clear();
        state.stepHelpCache.clear();
        renderRecipe();
        renderDock();
      });
    });
  }

  const reviseBtn = $("#revise-submit");
  if (reviseBtn) {
    reviseBtn.disabled = state.streaming;
    reviseBtn.textContent = state.streaming ? "Working" : "Revise";
  }
}

/* ---------------- Streaming Generation & Revision ---------------- */

async function runRecipeStream(endpoint, payload, phaseLabel = "Writing", preloadedImage = null) {
  if (state.streaming) return;
  clearErrors();

  const isFromHome = endpoint === "/api/generate";
  const prevMeta = !isFromHome
    ? resolveRecipeImageMeta(activeRecipe())
    : typeof preloadedImage === "string"
    ? { imageUrl: preloadedImage, credit: "", creditUrl: "", isAi: false }
    : preloadedImage || { imageUrl: "", credit: "", creditUrl: "", isAi: false };
  const prevHero = prevMeta.imageUrl || "";

  if (isFromHome) {
    state.versions = [
      {
        title: payload.selectedOption?.title || "Writing your recipe…",
        tagline: payload.selectedOption?.tagline || "",
        imageUrl: prevHero,
        imageCredit: prevMeta.credit || "",
        imageCreditUrl: prevMeta.creditUrl || "",
        imageIsAi: Boolean(prevMeta.isAi),
        ingredients: [],
        steps: []
      }
    ];
    state.versionIndex = 0;
    state.servings = Number(state.profile.defaultServings || 2);
    state.checkedIng.clear();
    state.checkedSteps.clear();
    state.ingIntelCache.clear();
    state.stepHelpCache.clear();
  }

  state.streaming = true;
  state.streamPhase = phaseLabel.toLowerCase();
  state.streamController = new AbortController();
  state.heroImageLoading = false;

  showView("recipe");
  renderRecipe();
  renderDock();

  let rawBuffer = "";
  let lastRenderAt = 0;
  let scheduled = false;

  const flushPartial = () => {
    scheduled = false;
    const { recipe: partial, phase } = extractPartialRecipe(rawBuffer);
    if (partial) {
      state.streamPhase = phase;
      const base = activeRecipe() || {};
      state.versions[state.versionIndex] = {
        ...base,
        ...partial,
        imageUrl: prevHero || base.imageUrl || "",
        ingredients: partial.ingredients || base.ingredients || [],
        steps: partial.steps || base.steps || []
      };
      if (partial.servings && isFromHome) {
        state.servings = Math.max(1, Math.round(partial.servings));
      }
      renderRecipe();
    }
  };

  try {
    const finalRecipe = await streamRecipeEndpoint(endpoint, payload, {
      signal: state.streamController.signal,
      onDelta: (chunk) => {
        rawBuffer += chunk;
        const now = performance.now();
        if (now - lastRenderAt > 90) {
          lastRenderAt = now;
          flushPartial();
        } else if (!scheduled) {
          scheduled = true;
          requestAnimationFrame(() => {
            lastRenderAt = performance.now();
            flushPartial();
          });
        }
      }
    });

    if (finalRecipe) {
      if (prevHero) {
        finalRecipe.imageUrl = prevHero;
        finalRecipe.imageCredit = prevMeta.credit || "";
        finalRecipe.imageCreditUrl = prevMeta.creditUrl || "";
        finalRecipe.imageIsAi = Boolean(prevMeta.isAi);
      }
      if (isFromHome) {
        state.versions = [finalRecipe];
        state.versionIndex = 0;
        state.servings = Math.max(1, Math.round(finalRecipe.servings || state.profile.defaultServings || 2));
      } else {
        state.versions = [...state.versions.slice(0, state.versionIndex + 1), finalRecipe];
        state.versionIndex = state.versions.length - 1;
        state.ingIntelCache.clear();
        state.stepHelpCache.clear();
        if (cookMode) cookMode.updateRecipe(finalRecipe);
      }
      pushHistory(finalRecipe);
      if (!finalRecipe.imageUrl) {
        hydrateRecipeHeroImage(finalRecipe);
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      if (isFromHome && !activeRecipe()?.ingredients?.length) {
        showView("home");
      }
    } else {
      if (isFromHome && !activeRecipe()?.ingredients?.length) {
        showView("home");
      }
      showError(err?.message || "Something went wrong. Check server provider configuration.");
    }
  } finally {
    state.streaming = false;
    state.streamController = null;
    if (state.view === "recipe") {
      renderRecipe();
      renderDock();
    }
  }
}

function collectHomeInput() {
  const query = $("#q").value.trim();
  const pendingTag = $("#ing-tag-input").value.trim();
  if (pendingTag) {
    addIngredientTagsFromText(pendingTag);
    $("#ing-tag-input").value = "";
  }
  return {
    query,
    ingredients: [...state.ingredientTags],
    mode: state.mode,
    images: [...state.images]
  };
}

function cookDirect(overrideText) {
  const input = collectHomeInput();
  const q = String(overrideText ?? input.query).trim();
  if (!q && !input.ingredients.length && !input.images.length) {
    showError("Type a dish idea, add ingredients, or attach a photo first.");
    return;
  }
  runRecipeStream(
    "/api/generate",
    {
      query: q,
      ingredients: input.ingredients,
      mode: input.mode,
      images: input.images.map((img) => ({ mimeType: img.mimeType, data: img.dataUrl })),
      profile: state.profile
    },
    "Writing"
  );
}

function handleHomeSubmit({ forceMode = "auto" } = {}) {
  const input = collectHomeInput();
  if (!input.query && !input.ingredients.length && !input.images.length) {
    showError("Type a dish idea, add ingredients, or attach a photo first.");
    return;
  }

  const explore =
    forceMode === "ideas"
      ? true
      : forceMode === "direct"
      ? false
      : isExploratoryPrompt(input.query, input.mode, input.images.length > 0, input.ingredients);

  if (explore) {
    state.ideasSeenTitles = [];
    openIdeasGrid(input);
  } else {
    cookDirect(input.query);
  }
}

function reviseRecipe(overrideText) {
  const r = activeRecipe();
  const instruction = String(overrideText ?? $("#tw").value).trim();
  if (!r || !instruction || state.streaming) return;
  if (!overrideText) $("#tw").value = "";
  runRecipeStream(
    "/api/revise",
    {
      recipe: r,
      instruction,
      profile: state.profile
    },
    "Revising"
  );
}

/* ---------------- Timers UI Sync ---------------- */

function syncStepTimersUi() {
  document.querySelectorAll("[data-step-timer]").forEach((btn) => {
    const t = timerManager.get(btn.dataset.stepTimer);
    const label = btn.dataset.defaultLabel;
    if (!t) {
      btn.textContent = `${label} · Start`;
      btn.classList.remove("is-running", "is-done");
    } else if (t.done) {
      btn.textContent = `${label} · Done`;
      btn.classList.remove("is-running");
      btn.classList.add("is-done");
    } else if (t.running) {
      btn.textContent = `Pause ${formatClock(t.remainingSec)}`;
      btn.classList.add("is-running");
      btn.classList.remove("is-done");
    } else {
      btn.textContent = `Resume ${formatClock(t.remainingSec)}`;
      btn.classList.remove("is-running");
      btn.classList.remove("is-done");
    }
  });
}

function renderTimerBar(timers) {
  const bar = $("#timer-bar");
  if (!bar) return;
  if (!timers.length) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `
    <div class="timer-bar-in">
      ${timers
        .map(
          (t) => `
          <div class="tb-item ${t.done ? "is-done" : ""}">
            <span class="tb-name">${esc(t.label)}</span>
            <strong class="tb-clock">${t.done ? "Done" : formatClock(t.remainingSec)}</strong>
            <button type="button" class="tb-btn" data-tb-toggle="${esc(t.id)}">${t.done ? "Restart" : t.running ? "Pause" : "Start"}</button>
            <button type="button" class="tb-btn" data-tb-del="${esc(t.id)}" aria-label="Dismiss timer">×</button>
          </div>
        `
        )
        .join("")}
    </div>
  `;
  bar.querySelectorAll("[data-tb-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = timerManager.get(btn.dataset.tbToggle);
      if (t) timerManager.startOrToggle(t.id, t.label, t.totalSec);
    });
  });
  bar.querySelectorAll("[data-tb-del]").forEach((btn) => {
    btn.addEventListener("click", () => timerManager.remove(btn.dataset.tbDel));
  });
}

/* ---------------- Markdown / Grocery Export ---------------- */

function formatRecipeMarkdown(r) {
  if (!r) return "";
  const scaleRatio = state.servings / Math.max(1, r.servings || state.servings || 1);
  const lines = [
    `# ${r.title}`,
    r.tagline ? `_${r.tagline}_` : "",
    `\nTime: ${r.time_minutes} min | Difficulty: ${r.difficulty} | Serves: ${state.servings}`,
    "\n## Ingredients",
    ...(r.ingredients || []).map((ing) => {
      const amt = convertAmount(ing, scaleRatio, state.unitSystem);
      return `- ${amt ? `${amt} ` : ""}${ing.item}${ing.note ? ` (${ing.note})` : ""}`;
    }),
    "\n## Method",
    ...(r.steps || []).map(
      (st, i) => `${i + 1}. **${st.title}** — ${convertStepTemperatures(st.text, state.unitSystem)}`
    )
  ];
  if (r.tips?.length) {
    lines.push("\n## Notes", ...r.tips.map((t) => `- ${t}`));
  }
  return lines.filter(Boolean).join("\n");
}

function formatGroceryList(r) {
  if (!r) return "";
  const scaleRatio = state.servings / Math.max(1, r.servings || state.servings || 1);
  const needed = (r.ingredients || [])
    .filter((_, i) => !state.checkedIng.has(i))
    .map((ing) => {
      const amt = convertAmount(ing, scaleRatio, state.unitSystem);
      return `[ ] ${amt ? `${amt} ` : ""}${ing.item}${ing.note ? ` (${ing.note})` : ""}`;
    });
  return [`Grocery list — ${r.title} (${state.servings} servings)`, ...needed].join("\n");
}

/* ---------------- Provider Picker Dialog (Server-Secret Only) ---------------- */

function getProviderList() {
  return state.health?.providers?.length ? state.health.providers : FALLBACK_PROVIDERS;
}

function hasAnyConfiguredProvider() {
  return getProviderList().some((p) => p.configured);
}

function getEffectiveProviderId() {
  const list = getProviderList();
  const saved = loadSelectedProvider();
  const savedEntry = list.find((p) => p.id === saved);
  if (savedEntry && (savedEntry.configured || !hasAnyConfiguredProvider())) {
    return savedEntry.id;
  }
  return state.health?.defaultProvider || list.find((p) => p.configured)?.id || "gemini";
}

function updateAiHeaderBadge() {
  const list = getProviderList();
  const activeId = getEffectiveProviderId();
  const active = list.find((p) => p.id === activeId) || list[0];
  $("#ai-label").textContent = active ? active.label.replace(/^Google |^Anthropic |^Local /, "") : "Provider";

  const note = $("#ai-note");
  const wireSamplesBtn = () => {
    $("#open-samples-from-note")?.addEventListener("click", () => {
      const disc = $("#samples-disclosure");
      if (disc) {
        disc.open = true;
        disc.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  };
  if (state.health?.staticOnly) {
    note.hidden = false;
    note.innerHTML = `Static mode active — <button type="button" class="link-btn" id="open-samples-from-note">browse samples</button> or connect a Cloudflare Worker in GitHub Secrets.`;
    wireSamplesBtn();
  } else if (state.health && !hasAnyConfiguredProvider()) {
    note.hidden = false;
    note.innerHTML = `No AI key configured — <button type="button" class="link-btn" id="open-samples-from-note">browse samples</button> or <button type="button" class="link-btn" id="open-ai-from-note">choose provider</button>.`;
    wireSamplesBtn();
    $("#open-ai-from-note")?.addEventListener("click", openAiDialog);
  } else {
    note.hidden = true;
  }
}

function openAiDialog() {
  const dialog = $("#ai-dialog");
  const list = getProviderList();
  let selectedId = getEffectiveProviderId();

  const renderDialog = () => {
    dialog.innerHTML = `
      <div class="modal-head">
        <div>
          <small>Server-configured AI</small>
          <h2 id="ai-dialog-title">Choose Provider</h2>
        </div>
        <button type="button" class="pop-close" id="ai-close-btn" aria-label="Close">×</button>
      </div>

      <div class="prov-list" role="radiogroup" aria-label="AI Providers">
        ${list
          .map((p) => {
            const active = p.id === selectedId;
            return `
              <button
                type="button"
                role="radio"
                aria-checked="${active}"
                class="prov-item ${active ? "is-active" : ""} ${p.configured ? "" : "is-unconfigured"}"
                data-pick-prov="${esc(p.id)}"
              >
                <span class="prov-item-main">
                  <strong>${esc(p.label)}</strong>
                  <small>${p.supportsImages ? "Recipes + optional AI photography" : "Recipes & culinary text"}</small>
                </span>
                <span class="prov-status">${p.configured ? "Ready" : "Not configured"}</span>
              </button>
            `;
          })
          .join("")}
      </div>

      <div class="img-optin-box">
        <div class="img-optin-head">
          <div>
            <strong>Dish Photography</strong>
            <small>Default uses free open photography (Openverse, Wikimedia Commons, TheMealDB). Opt in to generate custom AI photos.</small>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked="${state.aiImagesOptIn}"
            class="tbtn ${state.aiImagesOptIn ? "is-active" : ""}"
            id="ai-images-toggle"
          >${state.aiImagesOptIn ? "On · AI opt-in" : "Off · Open web photos"}</button>
        </div>
      </div>

      <p class="field-help">Models and API keys are managed securely on the server via GitHub Secrets / environment variables.</p>
    `;

    dialog.querySelector("#ai-close-btn").addEventListener("click", () => closeTopLayer(dialog));
    dialog.querySelector("#ai-images-toggle").addEventListener("click", () => {
      state.aiImagesOptIn = !state.aiImagesOptIn;
      saveAiImagesOptIn(state.aiImagesOptIn);
      renderDialog();
    });
    dialog.querySelectorAll("[data-pick-prov]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedId = btn.dataset.pickProv;
        saveSelectedProvider(selectedId);
        updateAiHeaderBadge();
        closeTopLayer(dialog);
      });
    });
  };

  renderDialog();
  dialog.showModal();
}

/* ---------------- Kitchen Profile Dialog ---------------- */

function updateKitchenDot() {
  const p = state.profile;
  const hasPrefs =
    (p.diet && p.diet.length > 0) ||
    Boolean(p.allergies?.trim()) ||
    (p.equipment && p.equipment.length > 0) ||
    Boolean(p.pantry?.trim()) ||
    Boolean(p.customNote?.trim()) ||
    p.units === "us";
  $("#kitchen-dot").hidden = !hasPrefs;
}

function openKitchenDialog() {
  const dialog = $("#kitchen-dialog");
  const draft = structuredClone(state.profile);

  const renderProfile = () => {
    dialog.innerHTML = `
      <div class="modal-head">
        <div>
          <small>Always applied to prompts</small>
          <h2 id="kitchen-dialog-title">Kitchen Profile</h2>
        </div>
        <button type="button" class="pop-close" id="kp-close" aria-label="Close">×</button>
      </div>

      <div class="modal-fields">
        <div class="field">
          <span>Dietary Preferences</span>
          <div class="preset-chips">
            ${DIET_OPTIONS.map(
              (d) => `<button type="button" class="chip ${draft.diet.includes(d) ? "is-active" : ""}" data-diet="${esc(d)}">${esc(d)}</button>`
            ).join("")}
          </div>
        </div>

        <label class="field">
          <span>Allergies & Strict Avoidances</span>
          <input type="text" id="kp-allergies" value="${esc(draft.allergies)}" placeholder="e.g. peanuts, shellfish, cilantro">
        </label>

        <div class="field-split">
          <label class="field">
            <span>Skill Level</span>
            <select id="kp-skill">
              ${["Beginner", "Home Cook", "Confident", "Chef"]
                .map((s) => `<option value="${esc(s)}" ${draft.skillLevel === s ? "selected" : ""}>${esc(s)}</option>`)
                .join("")}
            </select>
          </label>
          <label class="field">
            <span>Default Units</span>
            <select id="kp-units">
              <option value="metric" ${draft.units === "metric" ? "selected" : ""}>Metric (g, ml, °C)</option>
              <option value="us" ${draft.units === "us" ? "selected" : ""}>US (oz, cup, °F)</option>
            </select>
          </label>
          <label class="field">
            <span>Default Servings</span>
            <input type="number" id="kp-servings" min="1" max="16" value="${esc(draft.defaultServings)}">
          </label>
        </div>

        <div class="field">
          <span>Cookware & Appliances</span>
          <div class="preset-chips">
            ${EQUIPMENT_OPTIONS.map(
              (eq) => `<button type="button" class="chip ${draft.equipment.includes(eq) ? "is-active" : ""}" data-eq="${esc(eq)}">${esc(eq)}</button>`
            ).join("")}
          </div>
        </div>

        <label class="field">
          <span>Pantry Staples on Hand</span>
          <input type="text" id="kp-pantry" value="${esc(draft.pantry)}" placeholder="e.g. white miso, mirin, sesame oil, arborio rice">
        </label>

        <label class="field">
          <span>House Style Notes</span>
          <input type="text" id="kp-note" value="${esc(draft.customNote)}" placeholder="e.g. keep weeknight recipes under 30 min, love bright acid">
        </label>
      </div>

      <div class="modal-foot">
        <button type="button" class="tbtn" id="kp-clear">Reset</button>
        <button type="button" class="go" id="kp-save">Save profile</button>
      </div>
    `;

    dialog.querySelector("#kp-close").addEventListener("click", () => closeTopLayer(dialog));

    dialog.querySelectorAll("[data-diet]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.diet;
        const idx = draft.diet.indexOf(val);
        if (idx === -1) draft.diet.push(val);
        else draft.diet.splice(idx, 1);
        renderProfile();
      });
    });

    dialog.querySelectorAll("[data-eq]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.eq;
        const idx = draft.equipment.indexOf(val);
        if (idx === -1) draft.equipment.push(val);
        else draft.equipment.splice(idx, 1);
        renderProfile();
      });
    });

    dialog.querySelector("#kp-allergies").addEventListener("input", (e) => {
      draft.allergies = e.target.value;
    });
    dialog.querySelector("#kp-skill").addEventListener("change", (e) => {
      draft.skillLevel = e.target.value;
    });
    dialog.querySelector("#kp-units").addEventListener("change", (e) => {
      draft.units = e.target.value;
    });
    dialog.querySelector("#kp-servings").addEventListener("input", (e) => {
      draft.defaultServings = Math.max(1, Math.min(16, Number(e.target.value) || 2));
    });
    dialog.querySelector("#kp-pantry").addEventListener("input", (e) => {
      draft.pantry = e.target.value;
    });
    dialog.querySelector("#kp-note").addEventListener("input", (e) => {
      draft.customNote = e.target.value;
    });

    dialog.querySelector("#kp-clear").addEventListener("click", () => {
      Object.assign(draft, structuredClone(DEFAULT_PROFILE));
      renderProfile();
    });

    dialog.querySelector("#kp-save").addEventListener("click", () => {
      state.profile = draft;
      state.unitSystem = draft.units === "us" ? "us" : "metric";
      saveJson("mise:profile", state.profile);
      updateKitchenDot();
      if (state.view === "recipe") renderRecipe();
      closeTopLayer(dialog);
    });
  };

  renderProfile();
  dialog.showModal();
}

/* ---------------- Bootstrap & Event Wiring ---------------- */

async function init() {
  initThemeToggle($("#theme-btn"));
  setupModalDialog($("#ai-dialog"));
  setupModalDialog($("#kitchen-dialog"));

  cookMode = new CookModeController($("#cook-dialog"), {
    timerManager,
    getUnitSystem: () => state.unitSystem,
    getServings: () => state.servings,
    onAskStep: (stepIndex, question) =>
      postJson("/api/step-help", {
        recipe: activeRecipe(),
        stepIndex,
        question,
        profile: state.profile
      }),
    onApplyRevision: (instruction) => {
      closeTopLayer($("#cook-dialog"));
      reviseRecipe(instruction);
    }
  });

  timerManager.subscribe((timers) => {
    syncStepTimersUi();
    renderTimerBar(timers);
  });

  $("#sugg").innerHTML =
    `<span class="prompts-label">Try</span>` +
    SUGG.map((s) => `<button type="button" class="prompt-link">${esc(s)}</button>`).join(
      `<span aria-hidden="true">·</span>`
    );
  $("#tweaks").innerHTML = TWEAKS.map((s) => `<button type="button" class="chip">${esc(s)}</button>`).join("");

  $("#home-btn").addEventListener("click", () => {
    if (state.streaming) state.streamController?.abort();
    state.ideasController?.abort();
    state.ideasImageController?.abort();
    showView("home");
  });
  $("#ai-btn").addEventListener("click", openAiDialog);
  $("#kitchen-btn").addEventListener("click", openKitchenDialog);

  $("#ing-toggle-btn").addEventListener("click", () => {
    state.ingDrawerOpen = !state.ingDrawerOpen;
    syncModeUi();
    if (state.ingDrawerOpen) {
      $("#ing-tag-input")?.focus();
    }
  });

  $("#mode-popover").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    const isExplore = state.mode === "fridge" || state.mode === "craving";
    state.ingDrawerOpen = isExplore;
    syncModeUi();
    try {
      $("#mode-popover").hidePopover();
    } catch {
      // Ignore
    }
    if (isExplore) {
      $("#ing-tag-input")?.focus();
    }
  });

  $("#ing-tag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = $("#ing-tag-input").value.trim();
      if (val) {
        addIngredientTagsFromText(val);
        $("#ing-tag-input").value = "";
      }
    }
  });

  $("#ing-tag-add").addEventListener("click", () => {
    const val = $("#ing-tag-input").value.trim();
    if (val) {
      addIngredientTagsFromText(val);
      $("#ing-tag-input").value = "";
    }
  });

  $("#ing-tag-list").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm-tag]");
    if (!rm) return;
    state.ingredientTags.splice(Number(rm.dataset.rmTag), 1);
    renderIngredientTags();
    syncModeUi();
  });

  $("#ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handleHomeSubmit({ forceMode: "auto" });
  });

  $("#alt-submit").addEventListener("click", () => {
    const isExploreMode = state.mode === "fridge" || state.mode === "craving";
    handleHomeSubmit({ forceMode: isExploreMode ? "direct" : "ideas" });
  });

  $("#revise-form").addEventListener("submit", (e) => {
    e.preventDefault();
    reviseRecipe();
  });

  $("#sugg").addEventListener("click", (e) => {
    const chip = e.target.closest(".prompt-link");
    if (!chip) return;
    $("#q").value = chip.textContent;
    handleHomeSubmit({ forceMode: "auto" });
  });

  $("#tweaks").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) reviseRecipe(chip.textContent);
  });

  $("#sample-ideas-btn").addEventListener("click", openSampleIdeasGrid);

  document.querySelectorAll("[data-sample]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sample = SAMPLE_RECIPES[Number(btn.dataset.sample)];
      if (sample) openRecipeInView(sample, { pushToHistory: false });
    });
  });

  $("#photo-input").addEventListener("change", (e) => {
    addImages(e.target.files);
    e.target.value = "";
  });

  $("#photo-strip").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm-img]");
    if (!rm) return;
    state.images = state.images.filter((img) => img.id !== rm.dataset.rmImg);
    renderPhotoStrip();
  });

  const homeEl = $("#home-view");
  homeEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    homeEl.classList.add("is-drag");
  });
  homeEl.addEventListener("dragleave", () => homeEl.classList.remove("is-drag"));
  homeEl.addEventListener("drop", (e) => {
    e.preventDefault();
    homeEl.classList.remove("is-drag");
    if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
  });

  document.addEventListener("paste", (e) => {
    if (state.view !== "home") return;
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) addImages(files);
  });

  document.querySelectorAll(".lib-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.libTab = btn.dataset.lib;
      renderLibrary();
    });
  });

  $("#rlist").addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-lib-open]");
    if (openBtn) {
      const list = state.libTab === "saved" ? state.saved : state.hist;
      const entry = list[Number(openBtn.dataset.libOpen)];
      if (entry?.recipe) openRecipeInView(entry.recipe, { pushToHistory: false });
      return;
    }
    const delBtn = e.target.closest("[data-lib-del]");
    if (delBtn) {
      const idx = Number(delBtn.dataset.libDel);
      if (state.libTab === "saved") {
        state.saved.splice(idx, 1);
        saveJson("mise:saved", state.saved);
      } else {
        state.hist.splice(idx, 1);
        saveJson("mise:hist", state.hist);
      }
      renderLibrary();
    }
  });

  syncModeUi();
  renderLibrary();
  updateKitchenDot();
  updateAiHeaderBadge();

  try {
    state.health = await getHealth();
    updateAiHeaderBadge();
  } catch {
    // Non-fatal if restarting
  }
}

init();

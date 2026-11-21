import {
  PROVIDERS,
  PROVIDER_ORDER,
  createDefaultAiSettings,
  loadAiSettings,
  saveAiSettings,
  clearAllApiKeys,
  getProviderConfig,
  isProviderReady,
  hasAnyReadyProvider,
  canGenerateAiImage,
  formatActiveProviderBadge,
  fetchProviderModels,
  testProviderConnection,
  extractJsonObject,
  streamCompletionDirect,
  completeJsonDirect,
  generateDishImageDirect
} from "./ai-client.js";
import {
  buildIdeasPrompt,
  buildGeneratePrompt,
  buildRevisePrompt,
  buildIngredientIntelPrompt,
  buildApplySwapPrompt,
  buildStepHelpPrompt,
  buildEnrichPrompt
} from "./prompts.js";
import { isValidRecipe, normalizeRecipe, normalizeIdeasPayload } from "./recipe-helpers.js";

export {
  PROVIDERS,
  PROVIDER_ORDER,
  createDefaultAiSettings,
  loadAiSettings,
  saveAiSettings,
  clearAllApiKeys,
  getProviderConfig,
  isProviderReady,
  hasAnyReadyProvider,
  canGenerateAiImage,
  formatActiveProviderBadge,
  fetchProviderModels,
  testProviderConnection
};

const MAX_IMAGE_CACHE = 40;
const imageCache = new Map();

function rememberImage(key, result) {
  if (!result?.imageUrl) return;
  if (imageCache.has(key)) imageCache.delete(key);
  imageCache.set(key, result);
  if (imageCache.size > MAX_IMAGE_CACHE) {
    imageCache.delete(imageCache.keys().next().value);
  }
}

export async function postJson(endpoint, payload = {}, signal) {
  const settings = payload.settings || loadAiSettings();

  if (endpoint === "/api/ideas") {
    const query = String(payload.query || "").trim();
    const ingredients = Array.isArray(payload.ingredients) ? payload.ingredients : [];
    const images = Array.isArray(payload.images) ? payload.images : [];
    if (!query && !ingredients.length && !images.length) {
      throw new Error("Enter ingredients, a dish idea, or attach a photo first.");
    }
    const prompt = buildIdeasPrompt({
      query,
      ingredients,
      mode: payload.mode || "any",
      hasImages: images.length > 0,
      excludeTitles: payload.excludeTitles,
      refinement: payload.refinement,
      profile: payload.profile
    });
    const raw = await completeJsonDirect(
      {
        settings,
        providerId: payload.provider,
        images,
        system: prompt.system,
        userText: prompt.userText,
        jsonMode: true
      },
      signal
    );
    if (raw?.error) throw new Error(String(raw.error));
    const normalized = normalizeIdeasPayload(raw);
    if (!normalized) throw new Error("Could not build dish options. Try rephrasing.");
    return normalized;
  }

  if (endpoint === "/api/ingredient-intel") {
    if (!isValidRecipe(payload.recipe) || payload.ingredientIndex == null) {
      throw new Error("Recipe and ingredientIndex are required.");
    }
    const idx = Number(payload.ingredientIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= payload.recipe.ingredients.length) {
      throw new Error("Ingredient index out of range.");
    }
    const prompt = buildIngredientIntelPrompt({
      recipe: payload.recipe,
      ingredientIndex: idx,
      question: payload.question,
      profile: payload.profile
    });
    return await completeJsonDirect(
      {
        settings,
        providerId: payload.provider,
        system: prompt.system,
        userText: prompt.userText,
        jsonMode: true
      },
      signal
    );
  }

  if (endpoint === "/api/step-help") {
    if (!isValidRecipe(payload.recipe) || payload.stepIndex == null || !String(payload.question || "").trim()) {
      throw new Error("Recipe, stepIndex, and a question are required.");
    }
    const idx = Number(payload.stepIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= payload.recipe.steps.length) {
      throw new Error("Step index out of range.");
    }
    const prompt = buildStepHelpPrompt({
      recipe: payload.recipe,
      stepIndex: idx,
      question: payload.question,
      profile: payload.profile
    });
    return await completeJsonDirect(
      {
        settings,
        providerId: payload.provider,
        system: prompt.system,
        userText: prompt.userText,
        jsonMode: true
      },
      signal
    );
  }

  if (endpoint === "/api/enrich") {
    if (!isValidRecipe(payload.recipe) || !payload.section) {
      throw new Error("Recipe and section are required.");
    }
    const prompt = buildEnrichPrompt({
      recipe: payload.recipe,
      section: payload.section,
      profile: payload.profile
    });
    return await completeJsonDirect(
      {
        settings,
        providerId: payload.provider,
        system: prompt.system,
        userText: prompt.userText,
        jsonMode: true
      },
      signal
    );
  }

  throw new Error(`Unsupported local AI action: ${endpoint}`);
}

export async function fetchDishIdeas(payload, signal) {
  return postJson("/api/ideas", payload, signal);
}

/**
 * Resolves dish photography via open endpoints by default (`useAi: false`),
 * or via the configured BYOK image provider when explicitly opted in (`useAi: true`).
 */
export async function fetchDishImage(payload = {}, signal) {
  const settings = payload.settings || loadAiSettings();
  const title = String(payload.title || "").trim();
  if (!title) {
    return { imageUrl: null, source: "none", credit: "", creditUrl: "" };
  }

  const useAi = Boolean(payload.useAi);
  const excludeUrls = Array.isArray(payload.excludeUrls) ? payload.excludeUrls : [];
  const visualPrompt = String(payload.visualPrompt || "").trim();
  const cacheKey = `${useAi ? "ai" : "open"}|${title.toLowerCase()}|${visualPrompt.toLowerCase()}`;

  if (!payload.forceRefresh && excludeUrls.length === 0 && imageCache.has(cacheKey)) {
    const cached = imageCache.get(cacheKey);
    imageCache.delete(cacheKey);
    imageCache.set(cacheKey, cached);
    return { ...cached, cached: true };
  }

  const result = await generateDishImageDirect({
    settings,
    title,
    tagline: payload.tagline,
    cuisine: payload.cuisine,
    visualPrompt,
    useAi,
    excludeUrls,
    signal
  });

  rememberImage(cacheKey, result);
  return result;
}

/**
 * Executes a recipe streaming workflow (`/api/generate`, `/api/revise`, `/api/apply-swap`)
 * directly in the browser against the configured BYOK AI provider.
 */
export async function streamRecipeEndpoint(endpoint, payload = {}, { onDelta, onDone, onError, signal } = {}) {
  const settings = payload.settings || loadAiSettings();
  let prompt;
  let images = [];

  if (endpoint === "/api/generate") {
    const query = String(payload.query || "").trim();
    const ingredients = Array.isArray(payload.ingredients) ? payload.ingredients : [];
    images = Array.isArray(payload.images) ? payload.images : [];
    const selectedOption =
      payload.selectedOption && typeof payload.selectedOption === "object" ? payload.selectedOption : null;
    if (!query && !ingredients.length && !images.length && !selectedOption?.title) {
      throw new Error("Ask for a dish, add ingredients, or attach a photo first.");
    }
    prompt = buildGeneratePrompt({
      query,
      ingredients,
      selectedOption,
      mode: payload.mode || "any",
      hasImages: images.length > 0,
      profile: payload.profile
    });
  } else if (endpoint === "/api/revise") {
    if (!isValidRecipe(payload.recipe)) {
      throw new Error("A valid current recipe is required to revise.");
    }
    const instruction = String(payload.instruction || "").trim();
    if (!instruction) {
      throw new Error("Describe what you want to change.");
    }
    prompt = buildRevisePrompt({
      recipe: payload.recipe,
      instruction,
      profile: payload.profile
    });
  } else if (endpoint === "/api/apply-swap") {
    if (!isValidRecipe(payload.recipe) || payload.ingredientIndex == null || !payload.swap) {
      throw new Error("Recipe, ingredientIndex, and swap are required.");
    }
    const idx = Number(payload.ingredientIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= payload.recipe.ingredients.length) {
      throw new Error("Ingredient index out of range.");
    }
    prompt = buildApplySwapPrompt({
      recipe: payload.recipe,
      ingredientIndex: idx,
      swap: payload.swap,
      profile: payload.profile
    });
  } else {
    throw new Error(`Unsupported streaming action: ${endpoint}`);
  }

  try {
    const fullText = await streamCompletionDirect(
      {
        settings,
        providerId: payload.provider,
        images,
        system: prompt.system,
        userText: prompt.userText,
        jsonMode: true
      },
      (delta) => {
        if (delta && onDelta) onDelta(delta);
      },
      signal
    );

    const parsed = extractJsonObject(fullText);
    if (parsed?.error) {
      throw new Error(String(parsed.error));
    }

    const recipe = normalizeRecipe(parsed);
    if (!isValidRecipe(recipe)) {
      throw new Error("The recipe came back incomplete. Try rephrasing or switching AI providers in Settings.");
    }

    if (onDone) onDone(recipe);
    return recipe;
  } catch (err) {
    if (onError && err?.name !== "AbortError") onError(err);
    throw err;
  }
}

import { getPublicProviderCatalog } from "../server/catalog.mjs";
import {
  buildIdeasPrompt,
  buildGeneratePrompt,
  buildRevisePrompt,
  buildIngredientIntelPrompt,
  buildApplySwapPrompt,
  buildStepHelpPrompt,
  buildEnrichPrompt
} from "../server/prompts.mjs";
import {
  resolveCredentials,
  streamCompletion,
  completeJson,
  extractJsonObject,
  generateDishImage
} from "../server/providers.mjs";
import {
  isOriginAllowed,
  buildCorsHeaders,
  isValidRecipe,
  normalizeRecipe,
  normalizeIdeasPayload
} from "../server/http-helpers.mjs";

const MAX_IMAGE_CACHE = 40;
const defaultImageCache = new Map();

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders
    }
  });
}

async function readBody(request) {
  const text = (await request.text()).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("Malformed JSON request body.");
    err.status = 400;
    throw err;
  }
}

function streamRecipeResponse(request, providerOpts, prompt, env, fetchImpl, corsHeaders) {
  resolveCredentials({ provider: providerOpts.provider }, env);

  const encoder = new TextEncoder();
  const sendEvent = (controller, event, data) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const fullText = await streamCompletion(
          {
            provider: providerOpts.provider,
            images: providerOpts.images,
            system: prompt.system,
            userText: prompt.userText,
            jsonMode: true,
            fetchImpl,
            env
          },
          (delta) => sendEvent(controller, "delta", { text: delta }),
          request.signal
        );

        const parsed = extractJsonObject(fullText);
        if (parsed?.error) {
          sendEvent(controller, "error", { message: String(parsed.error) });
          controller.close();
          return;
        }

        const recipe = normalizeRecipe(parsed);
        if (!isValidRecipe(recipe)) {
          sendEvent(controller, "error", {
            message: "The recipe came back incomplete. Try rephrasing or switching AI providers."
          });
          controller.close();
          return;
        }

        sendEvent(controller, "done", { recipe });
        controller.close();
      } catch (err) {
        if (err?.name !== "AbortError") {
          sendEvent(controller, "error", {
            message: err?.message || "Something went wrong while generating the recipe."
          });
        }
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders
    }
  });
}

/**
 * Handles Cloudflare Worker HTTP requests with injectable fetch & imageCache for testing.
 */
export async function handleWorkerRequest(
  request,
  env = {},
  { fetchImpl = fetch, imageCache = defaultImageCache } = {}
) {
  const url = new URL(request.url);
  const { pathname } = url;
  const origin = request.headers.get("Origin") || "";

  if (origin && !isOriginAllowed(origin, env)) {
    return jsonResponse({ error: "Origin not allowed." }, 403);
  }

  const corsHeaders = buildCorsHeaders(origin, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (request.method === "GET" && pathname === "/api/health") {
      return jsonResponse({ ok: true, ...getPublicProviderCatalog(env) }, 200, corsHeaders);
    }

    if (request.method === "POST" && pathname === "/api/ideas") {
      const body = await readBody(request);
      const query = String(body.query || "").trim();
      const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
      const images = Array.isArray(body.images) ? body.images : [];
      if (!query && !ingredients.length && !images.length) {
        return jsonResponse(
          { error: "Enter ingredients, a dish idea, or attach a photo first." },
          400,
          corsHeaders
        );
      }
      const prompt = buildIdeasPrompt({
        query,
        ingredients,
        mode: body.mode || "any",
        hasImages: images.length > 0,
        excludeTitles: body.excludeTitles,
        refinement: body.refinement,
        profile: body.profile
      });
      const raw = await completeJson(
        {
          provider: body.provider,
          images,
          system: prompt.system,
          userText: prompt.userText,
          jsonMode: true,
          fetchImpl,
          env
        },
        request.signal
      );
      if (raw?.error) {
        return jsonResponse({ error: String(raw.error) }, 400, corsHeaders);
      }
      const normalized = normalizeIdeasPayload(raw);
      if (!normalized) {
        return jsonResponse({ error: "Could not build dish options. Try rephrasing." }, 502, corsHeaders);
      }
      return jsonResponse(normalized, 200, corsHeaders);
    }

    if (request.method === "POST" && pathname === "/api/dish-image") {
      const body = await readBody(request);
      const title = String(body.title || "").trim();
      if (!title) {
        return jsonResponse({ error: "Dish title is required." }, 400, corsHeaders);
      }
      const useAi = Boolean(body.useAi);
      const excludeUrls = Array.isArray(body.excludeUrls) ? body.excludeUrls : [];
      const visualPrompt = String(body.visualPrompt || "").trim();
      const cacheKey = `${useAi ? "ai" : "open"}|${title.toLowerCase()}|${visualPrompt.toLowerCase()}`;

      if (!body.forceRefresh && excludeUrls.length === 0 && imageCache.has(cacheKey)) {
        const cached = imageCache.get(cacheKey);
        imageCache.delete(cacheKey);
        imageCache.set(cacheKey, cached);
        return jsonResponse({ ...cached, cached: true }, 200, corsHeaders);
      }

      const result = await generateDishImage({
        title,
        tagline: body.tagline,
        cuisine: body.cuisine,
        visualPrompt,
        provider: body.provider,
        useAi,
        excludeUrls,
        env,
        fetchImpl,
        signal: request.signal
      });

      if (result?.imageUrl) {
        if (imageCache.has(cacheKey)) imageCache.delete(cacheKey);
        imageCache.set(cacheKey, result);
        if (imageCache.size > MAX_IMAGE_CACHE) {
          imageCache.delete(imageCache.keys().next().value);
        }
      }

      return jsonResponse(result, 200, corsHeaders);
    }

    if (request.method === "POST" && pathname === "/api/generate") {
      const body = await readBody(request);
      const query = String(body.query || "").trim();
      const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
      const images = Array.isArray(body.images) ? body.images : [];
      const selectedOption =
        body.selectedOption && typeof body.selectedOption === "object" ? body.selectedOption : null;
      if (!query && !ingredients.length && !images.length && !selectedOption?.title) {
        return jsonResponse(
          { error: "Ask for a dish, add ingredients, or attach a photo first." },
          400,
          corsHeaders
        );
      }
      const prompt = buildGeneratePrompt({
        query,
        ingredients,
        selectedOption,
        mode: body.mode || "any",
        hasImages: images.length > 0,
        profile: body.profile
      });
      return streamRecipeResponse(
        request,
        { provider: body.provider, images },
        prompt,
        env,
        fetchImpl,
        corsHeaders
      );
    }

    if (request.method === "POST" && pathname === "/api/revise") {
      const body = await readBody(request);
      if (!isValidRecipe(body.recipe)) {
        return jsonResponse({ error: "A valid current recipe is required to revise." }, 400, corsHeaders);
      }
      const instruction = String(body.instruction || "").trim();
      if (!instruction) {
        return jsonResponse({ error: "Describe what you want to change." }, 400, corsHeaders);
      }
      const prompt = buildRevisePrompt({
        recipe: body.recipe,
        instruction,
        profile: body.profile
      });
      return streamRecipeResponse(
        request,
        { provider: body.provider },
        prompt,
        env,
        fetchImpl,
        corsHeaders
      );
    }

    if (request.method === "POST" && pathname === "/api/apply-swap") {
      const body = await readBody(request);
      if (!isValidRecipe(body.recipe) || body.ingredientIndex == null || !body.swap) {
        return jsonResponse({ error: "Recipe, ingredientIndex, and swap are required." }, 400, corsHeaders);
      }
      const idx = Number(body.ingredientIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= body.recipe.ingredients.length) {
        return jsonResponse({ error: "Ingredient index out of range." }, 400, corsHeaders);
      }
      const prompt = buildApplySwapPrompt({
        recipe: body.recipe,
        ingredientIndex: idx,
        swap: body.swap,
        profile: body.profile
      });
      return streamRecipeResponse(
        request,
        { provider: body.provider },
        prompt,
        env,
        fetchImpl,
        corsHeaders
      );
    }

    if (request.method === "POST" && pathname === "/api/ingredient-intel") {
      const body = await readBody(request);
      if (!isValidRecipe(body.recipe) || body.ingredientIndex == null) {
        return jsonResponse({ error: "Recipe and ingredientIndex are required." }, 400, corsHeaders);
      }
      const idx = Number(body.ingredientIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= body.recipe.ingredients.length) {
        return jsonResponse({ error: "Ingredient index out of range." }, 400, corsHeaders);
      }
      const prompt = buildIngredientIntelPrompt({
        recipe: body.recipe,
        ingredientIndex: idx,
        question: body.question,
        profile: body.profile
      });
      const out = await completeJson(
        {
          provider: body.provider,
          system: prompt.system,
          userText: prompt.userText,
          jsonMode: true,
          fetchImpl,
          env
        },
        request.signal
      );
      return jsonResponse(out, 200, corsHeaders);
    }

    if (request.method === "POST" && pathname === "/api/step-help") {
      const body = await readBody(request);
      if (!isValidRecipe(body.recipe) || body.stepIndex == null || !String(body.question || "").trim()) {
        return jsonResponse({ error: "Recipe, stepIndex, and a question are required." }, 400, corsHeaders);
      }
      const idx = Number(body.stepIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= body.recipe.steps.length) {
        return jsonResponse({ error: "Step index out of range." }, 400, corsHeaders);
      }
      const prompt = buildStepHelpPrompt({
        recipe: body.recipe,
        stepIndex: idx,
        question: body.question,
        profile: body.profile
      });
      const out = await completeJson(
        {
          provider: body.provider,
          system: prompt.system,
          userText: prompt.userText,
          jsonMode: true,
          fetchImpl,
          env
        },
        request.signal
      );
      return jsonResponse(out, 200, corsHeaders);
    }

    if (request.method === "POST" && pathname === "/api/enrich") {
      const body = await readBody(request);
      if (!isValidRecipe(body.recipe) || !body.section) {
        return jsonResponse({ error: "Recipe and section are required." }, 400, corsHeaders);
      }
      const prompt = buildEnrichPrompt({
        recipe: body.recipe,
        section: body.section,
        profile: body.profile
      });
      const out = await completeJson(
        {
          provider: body.provider,
          system: prompt.system,
          userText: prompt.userText,
          jsonMode: true,
          fetchImpl,
          env
        },
        request.signal
      );
      return jsonResponse(out, 200, corsHeaders);
    }

    return jsonResponse({ error: "Unknown API route." }, 404, corsHeaders);
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    return jsonResponse({ error: err?.message || "Internal server error." }, status, corsHeaders);
  }
}

export default {
  fetch(request, env) {
    return handleWorkerRequest(request, env);
  }
};

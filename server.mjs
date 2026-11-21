import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getPublicProviderCatalog } from "./server/env.mjs";
import {
  buildIdeasPrompt,
  buildGeneratePrompt,
  buildRevisePrompt,
  buildIngredientIntelPrompt,
  buildApplySwapPrompt,
  buildStepHelpPrompt,
  buildEnrichPrompt
} from "./server/prompts.mjs";
import {
  resolveCredentials,
  streamCompletion,
  completeJson,
  extractJsonObject,
  generateDishImage
} from "./server/providers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 12 * 1024 * 1024; // 12 MB
const MAX_IMAGE_CACHE = 40;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function writeSseEvent(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("Request body too large (max 12 MB).");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("Malformed JSON request body.");
    err.status = 400;
    throw err;
  }
}

function isValidRecipe(recipe) {
  return Boolean(
    recipe &&
      typeof recipe === "object" &&
      typeof recipe.title === "string" &&
      recipe.title.trim() &&
      Array.isArray(recipe.ingredients) &&
      recipe.ingredients.length > 0 &&
      Array.isArray(recipe.steps) &&
      recipe.steps.length > 0
  );
}

function normalizeRecipe(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const prep = Number.isFinite(Number(raw.prep_minutes)) ? Math.max(0, Math.round(Number(raw.prep_minutes))) : null;
  const cook = Number.isFinite(Number(raw.cook_minutes)) ? Math.max(0, Math.round(Number(raw.cook_minutes))) : null;
  const total = Number.isFinite(Number(raw.time_minutes))
    ? Math.max(1, Math.round(Number(raw.time_minutes)))
    : (prep ?? 0) + (cook ?? 0) || 25;

  return {
    title: String(raw.title || "").trim(),
    tagline: String(raw.tagline || "").trim(),
    prep_minutes: prep,
    cook_minutes: cook,
    time_minutes: total,
    difficulty: ["Easy", "Medium", "Hard"].includes(raw.difficulty) ? raw.difficulty : "Medium",
    servings: Math.max(1, Math.round(Number(raw.servings) || 4)),
    cuisine: String(raw.cuisine || "").trim(),
    visual_prompt: String(raw.visual_prompt || "").trim(),
    ingredients: (raw.ingredients || []).map((ing) => ({
      item: String(ing?.item || "").trim(),
      amount: ing?.amount === null || ing?.amount === undefined || ing?.amount === "" ? null : Number(ing.amount),
      unit: String(ing?.unit || "").trim(),
      note: String(ing?.note || "").trim()
    })).filter((ing) => ing.item),
    steps: (raw.steps || []).map((st) => ({
      title: String(st?.title || "Step").trim(),
      text: String(st?.text || "").trim(),
      minutes: st?.minutes === null || st?.minutes === undefined || st?.minutes === "" ? null : Number(st.minutes)
    })).filter((st) => st.text),
    tips: Array.isArray(raw.tips) ? raw.tips.map((t) => String(t || "").trim()).filter(Boolean) : [],
    ...(raw.change_summary ? { change_summary: String(raw.change_summary).trim() } : {})
  };
}

function normalizeIdeasPayload(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.options)) return null;
  const options = raw.options
    .slice(0, 6)
    .map((opt, idx) => ({
      id: String(opt?.id || `opt-${idx + 1}`).trim(),
      title: String(opt?.title || "").trim(),
      tagline: String(opt?.tagline || "").trim(),
      time_minutes: Number.isFinite(Number(opt?.time_minutes)) ? Math.max(1, Math.round(Number(opt.time_minutes))) : 25,
      difficulty: ["Easy", "Medium", "Hard"].includes(opt?.difficulty) ? opt.difficulty : "Medium",
      cuisine: String(opt?.cuisine || "").trim(),
      vibe: String(opt?.vibe || "").trim(),
      uses: Array.isArray(opt?.uses) ? opt.uses.map((s) => String(s || "").trim()).filter(Boolean) : [],
      extras_needed: Array.isArray(opt?.extras_needed)
        ? opt.extras_needed.map((s) => String(s || "").trim()).filter(Boolean)
        : [],
      pantry_only: Boolean(opt?.pantry_only),
      visual_prompt: String(opt?.visual_prompt || "").trim()
    }))
    .filter((opt) => opt.title);

  if (!options.length) return null;
  return {
    prompt_summary: String(raw.prompt_summary || "").trim(),
    options
  };
}

async function handleSseRecipeStream(req, res, providerOpts, prompt, fetchImpl, env) {
  resolveCredentials({ provider: providerOpts.provider }, env);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff"
  });

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
      (delta) => {
        writeSseEvent(res, "delta", { text: delta });
      },
      controller.signal
    );

    const parsed = extractJsonObject(fullText);
    if (parsed?.error) {
      writeSseEvent(res, "error", { message: String(parsed.error) });
      res.end();
      return;
    }

    const recipe = normalizeRecipe(parsed);
    if (!isValidRecipe(recipe)) {
      writeSseEvent(res, "error", {
        message: "The recipe came back incomplete. Try rephrasing or switching AI providers."
      });
      res.end();
      return;
    }

    writeSseEvent(res, "done", { recipe });
    res.end();
  } catch (err) {
    if (err?.name === "AbortError" || res.writableEnded || res.destroyed) {
      if (!res.writableEnded) res.end();
      return;
    }
    writeSseEvent(res, "error", {
      message: err?.message || "Something went wrong while generating the recipe."
    });
    res.end();
  }
}

async function serveStatic(res, publicDir, pathname) {
  if (pathname.includes("\0")) {
    return sendJson(res, 400, { error: "Bad path" });
  }
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const root = path.resolve(publicDir);
  const target = path.resolve(root, rel);

  if (target !== root && !target.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }

  const filePath = stat.isDirectory() ? path.join(target, "index.html") : target;
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": content.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

/**
 * Creates the Mise HTTP server with injectable fetch & env for testing.
 */
export function createServer({ fetchImpl = fetch, publicDir = DEFAULT_PUBLIC_DIR, env = process.env } = {}) {
  const imageCache = new Map();

  const rememberImage = (key, result) => {
    if (!result?.imageUrl) return;
    if (imageCache.has(key)) imageCache.delete(key);
    imageCache.set(key, result);
    if (imageCache.size > MAX_IMAGE_CACHE) {
      const oldest = imageCache.keys().next().value;
      imageCache.delete(oldest);
    }
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const { pathname } = url;

    try {
      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          ...getPublicProviderCatalog(env)
        });
      }

      if (req.method === "POST" && pathname === "/api/ideas") {
        const body = await readJsonBody(req);
        const query = String(body.query || "").trim();
        const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
        const images = Array.isArray(body.images) ? body.images : [];
        if (!query && !ingredients.length && !images.length) {
          return sendJson(res, 400, { error: "Enter ingredients, a dish idea, or attach a photo first." });
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

        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
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
          controller.signal
        );

        if (raw?.error) {
          return sendJson(res, 400, { error: String(raw.error) });
        }
        const normalized = normalizeIdeasPayload(raw);
        if (!normalized) {
          return sendJson(res, 502, { error: "Could not build dish options. Try rephrasing." });
        }
        return sendJson(res, 200, normalized);
      }

      if (req.method === "POST" && pathname === "/api/dish-image") {
        const body = await readJsonBody(req);
        const title = String(body.title || "").trim();
        if (!title) {
          return sendJson(res, 400, { error: "Dish title is required." });
        }
        const visualPrompt = String(body.visualPrompt || "").trim();
        const cacheKey = `${title.toLowerCase()}|${visualPrompt.toLowerCase()}`;

        if (!body.forceRefresh && imageCache.has(cacheKey)) {
          const cached = imageCache.get(cacheKey);
          imageCache.delete(cacheKey);
          imageCache.set(cacheKey, cached);
          return sendJson(res, 200, { ...cached, cached: true });
        }

        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });

        const result = await generateDishImage({
          title,
          tagline: body.tagline,
          cuisine: body.cuisine,
          visualPrompt,
          provider: body.provider,
          env,
          fetchImpl,
          signal: controller.signal
        });

        rememberImage(cacheKey, result);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/generate") {
        const body = await readJsonBody(req);
        const query = String(body.query || "").trim();
        const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
        const images = Array.isArray(body.images) ? body.images : [];
        const selectedOption = body.selectedOption && typeof body.selectedOption === "object" ? body.selectedOption : null;
        if (!query && !ingredients.length && !images.length && !selectedOption?.title) {
          return sendJson(res, 400, { error: "Ask for a dish, add ingredients, or attach a photo first." });
        }
        const prompt = buildGeneratePrompt({
          query,
          ingredients,
          selectedOption,
          mode: body.mode || "any",
          hasImages: images.length > 0,
          profile: body.profile
        });
        return await handleSseRecipeStream(
          req,
          res,
          { provider: body.provider, images },
          prompt,
          fetchImpl,
          env
        );
      }

      if (req.method === "POST" && pathname === "/api/revise") {
        const body = await readJsonBody(req);
        if (!isValidRecipe(body.recipe)) {
          return sendJson(res, 400, { error: "A valid current recipe is required to revise." });
        }
        const instruction = String(body.instruction || "").trim();
        if (!instruction) {
          return sendJson(res, 400, { error: "Describe what you want to change." });
        }
        const prompt = buildRevisePrompt({
          recipe: body.recipe,
          instruction,
          profile: body.profile
        });
        return await handleSseRecipeStream(
          req,
          res,
          { provider: body.provider },
          prompt,
          fetchImpl,
          env
        );
      }

      if (req.method === "POST" && pathname === "/api/apply-swap") {
        const body = await readJsonBody(req);
        if (!isValidRecipe(body.recipe) || body.ingredientIndex == null || !body.swap) {
          return sendJson(res, 400, { error: "Recipe, ingredientIndex, and swap are required." });
        }
        const idx = Number(body.ingredientIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= body.recipe.ingredients.length) {
          return sendJson(res, 400, { error: "Ingredient index out of range." });
        }
        const prompt = buildApplySwapPrompt({
          recipe: body.recipe,
          ingredientIndex: idx,
          swap: body.swap,
          profile: body.profile
        });
        return await handleSseRecipeStream(
          req,
          res,
          { provider: body.provider },
          prompt,
          fetchImpl,
          env
        );
      }

      if (req.method === "POST" && pathname === "/api/ingredient-intel") {
        const body = await readJsonBody(req);
        if (!isValidRecipe(body.recipe) || body.ingredientIndex == null) {
          return sendJson(res, 400, { error: "Recipe and ingredientIndex are required." });
        }
        const idx = Number(body.ingredientIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= body.recipe.ingredients.length) {
          return sendJson(res, 400, { error: "Ingredient index out of range." });
        }
        const prompt = buildIngredientIntelPrompt({
          recipe: body.recipe,
          ingredientIndex: idx,
          question: body.question,
          profile: body.profile
        });
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
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
          controller.signal
        );
        return sendJson(res, 200, out);
      }

      if (req.method === "POST" && pathname === "/api/step-help") {
        const body = await readJsonBody(req);
        if (!isValidRecipe(body.recipe) || body.stepIndex == null || !String(body.question || "").trim()) {
          return sendJson(res, 400, { error: "Recipe, stepIndex, and a question are required." });
        }
        const idx = Number(body.stepIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= body.recipe.steps.length) {
          return sendJson(res, 400, { error: "Step index out of range." });
        }
        const prompt = buildStepHelpPrompt({
          recipe: body.recipe,
          stepIndex: idx,
          question: body.question,
          profile: body.profile
        });
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
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
          controller.signal
        );
        return sendJson(res, 200, out);
      }

      if (req.method === "POST" && pathname === "/api/enrich") {
        const body = await readJsonBody(req);
        if (!isValidRecipe(body.recipe) || !body.section) {
          return sendJson(res, 400, { error: "Recipe and section are required." });
        }
        const prompt = buildEnrichPrompt({
          recipe: body.recipe,
          section: body.section,
          profile: body.profile
        });
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
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
          controller.signal
        );
        return sendJson(res, 200, out);
      }

      if (pathname.startsWith("/api/")) {
        return sendJson(res, 404, { error: "Unknown API route." });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return await serveStatic(res, publicDir, pathname);
      }

      return sendJson(res, 405, { error: "Method not allowed." });
    } catch (err) {
      if (err?.name === "AbortError") return;
      const status = Number.isInteger(err?.status) ? err.status : 500;
      sendJson(res, status, { error: err?.message || "Internal server error." });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadEnv();
  const port = Number(process.env.PORT) || 3456;
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Mise running at http://127.0.0.1:${port}`);
  });
}

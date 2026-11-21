/**
 * Shared pure HTTP helpers (origin CORS policy + payload validation/normalization)
 * used by both Node (`server.mjs`) and Cloudflare Workers (`worker/index.mjs`).
 */

export function isOriginAllowed(origin, env = {}) {
  if (!origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const normalized = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  if (
    normalized === "https://adityapdixit.me" ||
    normalized === "http://adityapdixit.me" ||
    normalized === "https://hootsworth.github.io"
  ) {
    return true;
  }

  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return true;
  }

  const extra = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
  return extra.includes(normalized);
}

export function buildCorsHeaders(origin, env = {}) {
  if (!origin || !isOriginAllowed(origin, env)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

export function isValidRecipe(recipe) {
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

export function normalizeRecipe(raw) {
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
    ingredients: (raw.ingredients || [])
      .map((ing) => ({
        item: String(ing?.item || "").trim(),
        amount: ing?.amount === null || ing?.amount === undefined || ing?.amount === "" ? null : Number(ing.amount),
        unit: String(ing?.unit || "").trim(),
        note: String(ing?.note || "").trim()
      }))
      .filter((ing) => ing.item),
    steps: (raw.steps || [])
      .map((st) => ({
        title: String(st?.title || "Step").trim(),
        text: String(st?.text || "").trim(),
        minutes: st?.minutes === null || st?.minutes === undefined || st?.minutes === "" ? null : Number(st.minutes)
      }))
      .filter((st) => st.text),
    tips: Array.isArray(raw.tips) ? raw.tips.map((t) => String(t || "").trim()).filter(Boolean) : [],
    ...(raw.change_summary ? { change_summary: String(raw.change_summary).trim() } : {})
  };
}

export function normalizeIdeasPayload(raw) {
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

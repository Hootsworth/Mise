const FRACTION_TABLE = [
  [0, ""],
  [1 / 8, "⅛"],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [3 / 8, "⅜"],
  [1 / 2, "½"],
  [5 / 8, "⅝"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
  [7 / 8, "⅞"],
  [1, "__CARRY__"]
];

/**
 * Formats a positive numeric amount into clean editorial unicode fractions.
 */
export function formatFraction(n) {
  if (n == null || Number.isNaN(Number(n))) return "";
  const num = Number(n);
  if (num <= 0) return "";
  let whole = Math.floor(num);
  const frac = num - whole;

  let bestFrac = "";
  let bestDist = Infinity;
  for (const [val, glyph] of FRACTION_TABLE) {
    const d = Math.abs(frac - val);
    if (d < bestDist) {
      bestDist = d;
      bestFrac = glyph;
    }
  }

  if (bestFrac === "__CARRY__") {
    whole += 1;
    bestFrac = "";
  }
  if (whole === 0 && bestFrac === "") {
    return "⅛";
  }
  return `${whole || ""}${bestFrac}`;
}

function formatMetricWeight(grams) {
  if (grams >= 1000) {
    const kg = grams / 1000;
    const rounded = kg >= 10 ? Math.round(kg * 10) / 10 : Math.round(kg * 100) / 100;
    return `${rounded} kg`;
  }
  if (grams >= 100) {
    return `${Math.round(grams / 5) * 5} g`;
  }
  if (grams >= 1) {
    return `${Math.round(grams)} g`;
  }
  return `${Math.max(0.5, Math.round(grams * 2) / 2)} g`;
}

function formatMetricVolume(ml) {
  if (ml >= 1000) {
    const liters = ml / 1000;
    const rounded = liters >= 10 ? Math.round(liters * 10) / 10 : Math.round(liters * 100) / 100;
    return `${rounded} L`;
  }
  if (ml >= 100) {
    return `${Math.round(ml / 5) * 5} ml`;
  }
  if (ml >= 1) {
    return `${Math.round(ml)} ml`;
  }
  return `${Math.max(0.5, Math.round(ml * 2) / 2)} ml`;
}

/**
 * Scales and converts an ingredient quantity for display in `metric` or `us` units.
 */
export function convertAmount(ingredient, scaleRatio = 1, targetSystem = "metric") {
  if (!ingredient || ingredient.amount == null || ingredient.amount === "" || Number.isNaN(Number(ingredient.amount))) {
    return "";
  }
  const raw = Number(ingredient.amount) * scaleRatio;
  if (!(raw > 0)) return "";
  const unit = String(ingredient.unit || "").trim();
  const ul = unit.toLowerCase();

  if (targetSystem === "metric") {
    if (ul === "oz") return formatMetricWeight(raw * 28.3495);
    if (ul === "lb" || ul === "lbs") return formatMetricWeight(raw * 453.592);
    if (ul === "fl oz") return formatMetricVolume(raw * 29.5735);
    if (ul === "cup" || ul === "cups") return formatMetricVolume(raw * 240);
    if (ul === "g") return formatMetricWeight(raw);
    if (ul === "kg") return formatMetricWeight(raw * 1000);
    if (ul === "ml") return formatMetricVolume(raw);
    if (ul === "l") return formatMetricVolume(raw * 1000);
    return `${formatFraction(raw)}${unit ? ` ${unit}` : ""}`.trim();
  }

  // US customary system
  if (ul === "g" || ul === "kg") {
    const grams = ul === "kg" ? raw * 1000 : raw;
    const oz = grams / 28.3495;
    if (oz >= 16) {
      return `${formatFraction(Math.round((oz / 16) * 4) / 4)} lb`;
    }
    if (oz < 0.35) {
      return `${Math.max(0.1, Math.round(oz * 10) / 10)} oz`;
    }
    const cleanOz = oz >= 2 ? Math.round(oz * 4) / 4 : oz;
    return `${formatFraction(cleanOz)} oz`;
  }

  if (ul === "ml" || ul === "l") {
    const ml = ul === "l" ? raw * 1000 : raw;
    if (ml >= 60) {
      return `${formatFraction(ml / 240)} cup`;
    }
    if (ml >= 15) {
      return `${formatFraction(ml / 15)} tbsp`;
    }
    return `${formatFraction(ml / 5)} tsp`;
  }

  const label = ul === "cups" && raw <= 1 ? "cup" : unit;
  return `${formatFraction(raw)}${label ? ` ${label}` : ""}`.trim();
}

/**
 * Converts °C / °F temperature notations inside step instructions.
 */
export function convertStepTemperatures(text, targetSystem = "metric") {
  const str = String(text || "");
  return str.replace(/(\d+(?:\.\d+)?)\s*°\s*([CFcf])\b/g, (match, numStr, unitChar) => {
    const val = Number(numStr);
    if (Number.isNaN(val)) return match;
    const u = unitChar.toUpperCase();
    if (targetSystem === "us" && u === "C") {
      const f = Math.round(((val * 9) / 5 + 32) / 5) * 5;
      return `${f}°F`;
    }
    if (targetSystem === "metric" && u === "F") {
      const c = Math.round((((val - 32) * 5) / 9) / 5) * 5;
      return `${c}°C`;
    }
    return `${Math.round(val)}°${u}`;
  });
}

/**
 * Extracts explicit step timer + inline duration phrases from a recipe step.
 */
export function extractTimersFromStep(step) {
  const timers = [];
  const seenSeconds = new Set();

  const pushTimer = (label, seconds) => {
    const sec = Math.round(seconds);
    if (!(sec > 0) || seenSeconds.has(sec)) return;
    seenSeconds.add(sec);
    timers.push({ label, seconds: sec });
  };

  if (step?.minutes != null && Number(step.minutes) > 0) {
    const mins = Number(step.minutes);
    const label = mins >= 60 && mins % 60 === 0 ? `${mins / 60} hr` : `${mins} min`;
    pushTimer(label, mins * 60);
  }

  const text = String(step?.text || "");
  const rx = /(\d+(?:\.\d+)?)(?:\s*(?:–|-|to)\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec)\b/gi;
  for (const m of text.matchAll(rx)) {
    const n1 = Number(m[1]);
    const n2 = m[2] ? Number(m[2]) : null;
    const unitRaw = m[3].toLowerCase();
    const targetVal = n2 && n2 > n1 ? n2 : n1;
    let multiplier = 60;
    let unitShort = "min";
    if (unitRaw.startsWith("h")) {
      multiplier = 3600;
      unitShort = "hr";
    } else if (unitRaw.startsWith("s")) {
      multiplier = 1;
      unitShort = "sec";
    }
    const label = n2 ? `${m[1]}–${m[2]} ${unitShort}` : `${m[1]} ${unitShort}`;
    pushTimer(label, targetVal * multiplier);
  }

  return timers;
}

const STOP_WORDS = new Set([
  "fresh", "large", "small", "medium", "whole", "organic", "unsalted", "salted",
  "ground", "dried", "cold", "warm", "hot", "extra", "virgin", "taste", "optional",
  "fine", "finely", "chopped", "minced", "sliced", "diced", "grated", "crushed",
  "good", "quality", "plus", "more", "for", "the", "and", "with", "into", "of", "or",
  "to", "in", "on", "a", "an", "room", "temperature", "kosher", "sea", "black", "white"
]);

function normalizeToken(word) {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/**
 * Returns indices of recipe ingredients mentioned in a given step's text.
 */
export function matchStepIngredients(stepText, ingredients = []) {
  const tokens = new Set(
    String(stepText || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(normalizeToken)
      .filter((t) => t.length >= 3)
  );
  if (!tokens.size || !Array.isArray(ingredients)) return [];

  const matched = [];
  ingredients.forEach((ing, idx) => {
    const words = String(ing?.item || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .map(normalizeToken);
    if (words.some((w) => tokens.has(w))) {
      matched.push(idx);
    }
  });
  return matched;
}

function normIng(ing) {
  return `${ing?.amount ?? ""}|${String(ing?.unit || "").trim().toLowerCase()}|${String(ing?.item || "").trim().toLowerCase()}|${String(ing?.note || "").trim().toLowerCase()}`;
}

function normStep(st) {
  return `${String(st?.title || "").trim().toLowerCase()}|${String(st?.text || "").trim().toLowerCase()}|${st?.minutes ?? ""}`;
}

/**
 * Compares two recipe versions and identifies changed/added ingredient and step indices.
 */
export function diffRecipes(prevRecipe, nextRecipe) {
  const changedIngredientIdx = new Set();
  const changedStepIdx = new Set();
  if (!prevRecipe || !nextRecipe) {
    return { changedIngredientIdx, changedStepIdx, metaChanged: false };
  }

  const prevIngSet = new Set((prevRecipe.ingredients || []).map(normIng));
  (nextRecipe.ingredients || []).forEach((ing, idx) => {
    if (!prevIngSet.has(normIng(ing))) changedIngredientIdx.add(idx);
  });

  const prevStepSet = new Set((prevRecipe.steps || []).map(normStep));
  (nextRecipe.steps || []).forEach((st, idx) => {
    if (!prevStepSet.has(normStep(st))) changedStepIdx.add(idx);
  });

  const metaChanged =
    prevRecipe.title !== nextRecipe.title ||
    prevRecipe.time_minutes !== nextRecipe.time_minutes ||
    prevRecipe.difficulty !== nextRecipe.difficulty;

  return { changedIngredientIdx, changedStepIdx, metaChanged };
}

/**
 * Determines whether a prompt is exploratory ("what I have" / "something with X")
 * so Mise can present a curated dish options grid instead of jumping straight to one recipe.
 */
export function isExploratoryPrompt(query = "", mode = "any", hasImages = false, ingredientTags = []) {
  if (mode === "fridge" || mode === "craving") return true;
  if (Array.isArray(ingredientTags) && ingredientTags.length > 0) return true;
  if (hasImages && mode !== "recreate") return true;
  if (mode !== "any") return false;

  const q = String(query || "").trim();
  if (!q) return false;
  if (
    /\b(something with|what can i make|ideas? (for|with)|using|have in my|leftover|stuff i have|dishes? with|made with|around)\b/i.test(
      q
    )
  ) {
    return true;
  }

  const commaParts = q.split(",").map((s) => s.trim()).filter(Boolean);
  if (commaParts.length >= 2) return true;

  return false;
}

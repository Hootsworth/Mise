const RECIPE_SCHEMA_DESC = `{
  "title": string,
  "tagline": string (one evocative editorial sentence),
  "prep_minutes": number,
  "cook_minutes": number,
  "time_minutes": number,
  "difficulty": "Easy" | "Medium" | "Hard",
  "servings": number,
  "cuisine": string (1-2 words, e.g. "Japanese-Italian"),
  "visual_prompt": string (1 short sentence describing the finished dish plating for overhead editorial photography),
  "ingredients": [
    {
      "item": string,
      "amount": number | null,
      "unit": string ("g", "ml", "tsp", "tbsp", "cup", "oz", "lb", or "" for counts),
      "note": string (optional prep like "finely chopped" or "")
    }
  ],
  "steps": [
    {
      "title": string (2-4 words),
      "text": string (clear, specific, with heat levels and sensory cues),
      "minutes": number | null
    }
  ],
  "tips": [string]
}`;

const MODE_INSTRUCTIONS = {
  any: "Create a deeply reliable, restaurant-worthy yet home-cookable recipe that nails flavor balance, texture, and timing.",
  fridge: "FRIDGE MODE: Strictly prioritize the ingredients listed or pictured in the photo(s), using only basic pantry staples (salt, pepper, oil, water, basic spices/vinegar) unless clearly needed. Never invent expensive main proteins or produce not shown or named.",
  craving: "INGREDIENT FEATURE MODE: Center the dish thoughtfully around the named/tagged key ingredient(s), letting their flavor and texture shine.",
  recreate: "RECREATE MODE: Reverse-engineer the described or photographed dish with chef-level accuracy, identifying sauces, garnishes, cooking method, and visual cues.",
  mealprep: "MEAL PREP MODE: Design a batch-friendly dish that holds texture, portions cleanly, stores 4-5 days refrigerated, and reheats without turning soggy or overcooking.",
  drink: "DRINK MODE: Craft a balanced cocktail, mocktail, coffee, or tea recipe with exact ml/oz/tsp measurements, ice, glassware, temperature, and garnish cues."
};

/**
 * Formats user kitchen profile settings into a crisp constraint block for system prompts.
 */
export function formatKitchenProfile(profile = {}) {
  if (!profile || typeof profile !== "object") return "";
  const lines = [];
  const diets = Array.isArray(profile.diet) ? profile.diet.filter(Boolean) : [];
  if (diets.length) lines.push(`- Dietary preferences: ${diets.join(", ")}`);
  if (profile.allergies && String(profile.allergies).trim()) {
    lines.push(`- STRICT ALLERGIES / AVOIDANCES (never include these or derivatives): ${String(profile.allergies).trim()}`);
  }
  if (profile.skillLevel) {
    lines.push(`- Cook skill level: ${profile.skillLevel}`);
  }
  if (profile.units === "us") {
    lines.push("- Preferred units: US customary (oz, lb, cup, tbsp, tsp, °F) unless the user asks otherwise.");
  } else if (profile.units === "metric") {
    lines.push("- Preferred units: Metric (g, ml, °C) and tsp/tbsp for small amounts.");
  }
  if (Number.isFinite(Number(profile.defaultServings)) && Number(profile.defaultServings) > 0) {
    lines.push(`- Default servings: ${Math.round(Number(profile.defaultServings))} (unless the request asks for a different yield).`);
  }
  const equipment = Array.isArray(profile.equipment) ? profile.equipment.filter(Boolean) : [];
  if (equipment.length) {
    lines.push(`- Available cookware/appliances: ${equipment.join(", ")}`);
  }
  if (profile.pantry && String(profile.pantry).trim()) {
    lines.push(`- Pantry staples on hand: ${String(profile.pantry).trim()}`);
  }
  if (profile.customNote && String(profile.customNote).trim()) {
    lines.push(`- House style notes: ${String(profile.customNote).trim()}`);
  }
  if (!lines.length) return "";
  return `Kitchen Profile:\n${lines.join("\n")}`;
}

export function buildIdeasPrompt({
  query = "",
  ingredients = [],
  mode = "any",
  hasImages = false,
  excludeTitles = [],
  refinement = "",
  profile = {}
} = {}) {
  const profileBlock = formatKitchenProfile(profile);
  const ingList = Array.isArray(ingredients) ? ingredients.map((s) => String(s || "").trim()).filter(Boolean) : [];
  const excludes = Array.isArray(excludeTitles) ? excludeTitles.map((s) => String(s || "").trim()).filter(Boolean) : [];

  const modeRule =
    mode === "fridge"
      ? "Every option MUST be realistic using primarily the user's listed/pictured ingredients plus everyday pantry staples (salt, oil, pepper, vinegar, flour, basic spices). Set pantry_only: true when no extra grocery items are needed."
      : mode === "drink"
      ? "Propose 6 distinct drink concepts spanning different spirits/bases, textures, and temperatures."
      : mode === "mealprep"
      ? "Propose 6 distinct batch-friendly meal prep concepts that hold up cleanly over 4 days."
      : "Propose 6 genuinely distinct dish concepts spanning different cooking techniques, textures, cuisines, and prep times.";

  const system = [
    "You are Mise, a creative culinary director curating a compact editorial menu of dish ideas.",
    "Reply with ONLY one valid JSON object — no markdown fences, no commentary.",
    `Exact JSON shape:
{
  "prompt_summary": string (short editorial phrase, e.g. "6 dishes built around miso, mushrooms & rice"),
  "options": [
    {
      "id": string ("opt-1" .. "opt-6"),
      "title": string (crisp, appetizing dish name),
      "tagline": string (one evocative sentence),
      "time_minutes": number,
      "difficulty": "Easy" | "Medium" | "Hard",
      "cuisine": string (1-2 words),
      "vibe": string (2-3 words, e.g. "Crisp & Savory", "Brothy & Comforting"),
      "uses": [string (key ingredients from the user's input or photo)],
      "extras_needed": [string (optional extra ingredients beyond user's list/pantry, empty array [] if pantry-only)],
      "pantry_only": boolean,
      "visual_prompt": string (concise plating & texture description for overhead editorial food photography)
    }
  ]
}`,
    "Rules:",
    "- Generate exactly 6 genuinely varied options (no near-duplicates).",
    modeRule,
    excludes.length ? `- Do NOT repeat or slightly rename any of these previously shown titles: ${excludes.join("; ")}` : "",
    refinement ? `- Apply this steering constraint to ALL 6 options: ${refinement}` : "",
    "- If the input is clearly not about food or drink, reply ONLY with {\"error\": \"short, friendly culinary redirect\"}.",
    profileBlock
  ].filter(Boolean).join("\n\n");

  const parts = [];
  if (ingList.length) parts.push(`Available / featured ingredients: ${ingList.join(", ")}`);
  if (String(query || "").trim()) parts.push(`User request: ${String(query).trim()}`);
  if (hasImages) parts.push("Also examine the attached food/fridge photo(s) closely and incorporate what you see.");
  if (!parts.length) parts.push("Suggest 6 inspiring dishes to cook today.");

  return { system, userText: parts.join("\n") };
}

export function buildDishImagePrompt({ title = "", tagline = "", cuisine = "", visualPrompt = "" } = {}) {
  const subject = visualPrompt
    ? `${title}: ${visualPrompt}`
    : [title, tagline, cuisine ? `${cuisine} style` : ""].filter(Boolean).join(" — ");
  return `Minimalist overhead fine-dining editorial food photography of ${subject}. Plated on matte ceramic stoneware against a clean stone surface, natural directional window lighting, crisp textures, shallow depth of field, Kinfolk magazine aesthetic. No text, no typography, no labels, no watermarks, no hands.`;
}

export function buildGeneratePrompt({
  query = "",
  ingredients = [],
  selectedOption = null,
  mode = "any",
  hasImages = false,
  profile = {}
} = {}) {
  const profileBlock = formatKitchenProfile(profile);
  const modeNote = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.any;
  const ingList = Array.isArray(ingredients) ? ingredients.map((s) => String(s || "").trim()).filter(Boolean) : [];

  const system = [
    "You are Mise, a world-class chef, recipe developer, and minimalist culinary editor.",
    "Reply with ONLY one valid JSON object — no markdown fences, no commentary before or after.",
    `Exact JSON shape:\n${RECIPE_SCHEMA_DESC}`,
    "Rules:",
    "- Use realistic, tested proportions that actually cook well.",
    "- Write 4 to 9 crisp, chronological method steps with exact heat levels, visual/aroma/sound cues, and accurate minutes (or null if instantaneous).",
    "- Write 1 to 3 genuinely helpful chef tips.",
    "- Default to metric (g, ml) plus tsp/tbsp/counts unless Kitchen Profile specifies US units.",
    "- If the prompt or photo is not about food or drink, reply ONLY with {\"error\": \"short, friendly culinary redirect\"}.",
    modeNote,
    profileBlock
  ].filter(Boolean).join("\n\n");

  const lines = [];
  if (selectedOption && selectedOption.title) {
    lines.push(`Selected dish to write in full: ${selectedOption.title}`);
    if (selectedOption.tagline) lines.push(`Concept: ${selectedOption.tagline}`);
    if (selectedOption.cuisine) lines.push(`Cuisine: ${selectedOption.cuisine}`);
    if (Array.isArray(selectedOption.uses) && selectedOption.uses.length) {
      lines.push(`Core ingredients to use: ${selectedOption.uses.join(", ")}`);
    }
    if (Array.isArray(selectedOption.extras_needed) && selectedOption.extras_needed.length) {
      lines.push(`Additional ingredients planned for this option: ${selectedOption.extras_needed.join(", ")}`);
    }
  }
  if (ingList.length) {
    lines.push(`User's listed ingredients: ${ingList.join(", ")}`);
  }
  const trimmed = String(query || "").trim();
  if (hasImages) {
    lines.push(
      trimmed
        ? `Examine the attached food/fridge photo(s) closely and fulfill this request: ${trimmed}`
        : "Examine the attached food/fridge photo(s) closely and create the best recipe based on what you see."
    );
  } else if (trimmed) {
    lines.push(`Request: ${trimmed}`);
  } else if (!lines.length) {
    lines.push("Request: Create an inspired seasonal dish.");
  }

  return { system, userText: lines.join("\n") };
}

export function buildRevisePrompt({ recipe, instruction, profile = {} } = {}) {
  const profileBlock = formatKitchenProfile(profile);
  const system = [
    "You are Mise, a world-class chef revising an existing recipe.",
    "Reply with ONLY one valid JSON object — no markdown fences, no commentary.",
    `Return the full updated recipe in this exact shape plus "change_summary":\n${RECIPE_SCHEMA_DESC}\nAnd include top-level "change_summary": string (one crisp sentence describing what changed).`,
    "Rules:",
    "- Keep unchanged ingredients and steps verbatim whenever possible so the user sees exact diffs.",
    "- When changing an ingredient or constraint, update EVERY downstream step, timing, heat level, and tip affected by the change.",
    "- If the revision request makes no culinary sense or is off-topic, return {\"error\": \"short, friendly reason\"}.",
    profileBlock
  ].filter(Boolean).join("\n\n");

  const userText = `Current recipe:\n${JSON.stringify(recipe)}\n\nRevision request: ${String(instruction || "").trim()}`;
  return { system, userText };
}

export function buildIngredientIntelPrompt({ recipe, ingredientIndex, question = "", profile = {} } = {}) {
  const ing = recipe?.ingredients?.[ingredientIndex];
  const profileBlock = formatKitchenProfile(profile);
  const system = [
    "You are Mise, a culinary scientist and test-kitchen chef explaining a single ingredient in context.",
    "Reply with ONLY one valid JSON object — no markdown fences, no commentary.",
    `Exact JSON shape:
{
  "role": string (1-2 crisp sentences on the flavor, texture, or chemical role in THIS specific dish),
  "prep_tip": string (1 practical sentence on selecting, prepping, or timing this ingredient),
  "swaps": [
    {
      "item": string,
      "amount": number | null,
      "unit": string,
      "note": string,
      "ratio_note": string (short explanation of flavor/timing adjustment)
    }
  ],
  "answer": string (direct 1-3 sentence answer if a custom question was asked, otherwise "")
}`,
    "Provide 2 to 3 genuinely viable swaps scaled to the recipe's current ingredient quantity, respecting any Kitchen Profile allergies strictly.",
    profileBlock
  ].filter(Boolean).join("\n\n");

  const q = String(question || "").trim();
  const userText = [
    `Recipe: ${recipe?.title || "Untitled"} — ${recipe?.tagline || ""}`,
    `All ingredients: ${JSON.stringify(recipe?.ingredients || [])}`,
    `Target ingredient (#${ingredientIndex + 1}): ${JSON.stringify(ing)}`,
    q ? `Specific question from the cook: ${q}` : "Provide culinary role, prep tip, and 2-3 smart substitutes."
  ].join("\n");

  return { system, userText };
}

export function buildApplySwapPrompt({ recipe, ingredientIndex, swap, profile = {} } = {}) {
  const target = recipe?.ingredients?.[ingredientIndex];
  const profileBlock = formatKitchenProfile(profile);
  const system = [
    "You are Mise, a test-kitchen chef cleanly substituting an ingredient in a recipe.",
    "Reply with ONLY one valid JSON object — no markdown fences, no commentary.",
    `Return the full updated recipe in this exact shape plus "change_summary":\n${RECIPE_SCHEMA_DESC}\nAnd include top-level "change_summary": string (one short sentence naming the swap and any technique adjustment).`,
    "Rules:",
    "- Replace the target ingredient with the substitute using accurate proportions.",
    "- Update every method step, cooking time, liquid/seasoning balance, and tip impacted by this swap while keeping unaffected items intact.",
    profileBlock
  ].filter(Boolean).join("\n\n");

  const userText = [
    `Current recipe:\n${JSON.stringify(recipe)}`,
    `Replace ingredient at index ${ingredientIndex} (${JSON.stringify(target)}) with: ${JSON.stringify(swap)}`
  ].join("\n\n");

  return { system, userText };
}

export function buildStepHelpPrompt({ recipe, stepIndex, question, profile = {} } = {}) {
  const step = recipe?.steps?.[stepIndex];
  const profileBlock = formatKitchenProfile(profile);
  const system = [
    "You are Mise, a calm, reassuring line chef coaching someone live at the stove.",
    "Reply with ONLY one valid JSON object — no markdown fences, no commentary.",
    `Exact JSON shape:
{
  "answer": string (concise, calm, actionable guidance in 2-4 sentences),
  "sensory_cue": string (1 short visual, aroma, sound, or texture check, or ""),
  "suggested_revision": string | null (short revision prompt if fixing this requires adapting later steps, otherwise null)
}`,
    profileBlock
  ].filter(Boolean).join("\n\n");

  const userText = [
    `Recipe: ${recipe?.title || "Untitled"}`,
    `Ingredients: ${JSON.stringify(recipe?.ingredients || [])}`,
    `Current step (#${stepIndex + 1} of ${recipe?.steps?.length || 0}): ${JSON.stringify(step)}`,
    `Remaining steps: ${JSON.stringify((recipe?.steps || []).slice(stepIndex + 1))}`,
    `Cook's question / issue right now: ${String(question || "").trim()}`
  ].join("\n");

  return { system, userText };
}

export function buildEnrichPrompt({ recipe, section, profile = {} } = {}) {
  const profileBlock = formatKitchenProfile(profile);
  const shapes = {
    nutrition: `{
  "per_serving": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number,
    "fiber_g": number,
    "sodium_mg": number
  },
  "dietary_tags": [string],
  "note": string (1 concise sentence noting key macro drivers and estimation caveats)
}`,
    flavor: `{
  "axes": {
    "salt": number (0-10),
    "acid": number (0-10),
    "fat": number (0-10),
    "heat": number (0-10),
    "sweet": number (0-10),
    "umami": number (0-10)
  },
  "summary": string (1-2 crisp sentences on flavor & texture balance),
  "finish_adjustments": [string (2-3 quick tasting-at-the-pass adjustments)]
}`,
    pairings: `{
  "wine": { "name": string, "why": string },
  "zero_proof": { "name": string, "why": string },
  "side": { "name": string, "why": string },
  "plating": string (1-2 sentences on vessel, temperature, and garnish)
}`,
    storage: `{
  "make_ahead": string,
  "fridge": string,
  "freezer": string,
  "reheat": string
}`
  };

  const shape = shapes[section];
  if (!shape) {
    const err = new Error(`Unsupported enrichment section: ${section}`);
    err.status = 400;
    throw err;
  }

  const system = [
    "You are Mise, a culinary director providing concise editorial reference notes for a finished recipe.",
    "Reply with ONLY one valid JSON object — no markdown fences, no commentary.",
    `Exact JSON shape:\n${shape}`,
    profileBlock
  ].filter(Boolean).join("\n\n");

  const userText = `Section requested: ${section}\nRecipe:\n${JSON.stringify(recipe)}`;
  return { system, userText };
}

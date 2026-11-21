import { convertAmount } from "./units.js";

export const DELIVERY_PREFS_KEY = "mise:delivery:v1";

export const GROCERY_PLATFORMS = [
  {
    id: "swiggy-im",
    mcpId: "swiggy",
    label: "Swiggy Instamart",
    shortLabel: "Instamart",
    capability: "oauth",
    badge: "OAuth MCP",
    description: "Official Swiggy Instamart MCP — search local inventory, manage carts & checkout.",
    permissions: [
      "View saved delivery addresses",
      "Search Instamart catalog & prices",
      "Add or update items in your Instamart cart",
      "Read order status (places real orders only on explicit confirmation)"
    ]
  },
  {
    id: "zepto",
    mcpId: "zepto",
    label: "Zepto",
    shortLabel: "Zepto",
    capability: "oauth",
    badge: "OAuth MCP",
    description: "Official Zepto Consumer MCP — 10-minute grocery search, cart & ordering via Phone OTP.",
    permissions: [
      "Search Zepto products & local availability",
      "Read & manage your Zepto shopping cart",
      "View saved locations & past orders",
      "Checkout & order management (places real orders only when confirmed)"
    ]
  },
  {
    id: "blinkit",
    mcpId: "blinkit",
    label: "Blinkit",
    shortLabel: "Blinkit",
    capability: "local-stdio",
    badge: "Unofficial MCP",
    description: "Community Playwright MCP (hereisSwapnil/blinkit-mcp) over local stdio/SSE + web search links.",
    permissions: [
      "Sign in with mobile + OTP via local Playwright session (~/.blinkit_mcp)",
      "Search products, read saved addresses & inspect cart",
      "Add/remove cart items (requires local Python uv setup; always confirms before pay)"
    ]
  }
];

export const FOOD_PLATFORMS = [
  {
    id: "swiggy-food",
    mcpId: "swiggy",
    label: "Swiggy Food",
    shortLabel: "Swiggy",
    capability: "oauth",
    badge: "OAuth MCP",
    description: "Official Swiggy Food MCP — browse open restaurants near you, menus, coupons & cart.",
    permissions: [
      "View saved delivery addresses",
      "Search open restaurants & dish menus",
      "Build restaurant carts & inspect valid coupons (₹1000 v1 cap)"
    ]
  },
  {
    id: "zomato",
    mcpId: "zomato",
    label: "Zomato",
    shortLabel: "Zomato",
    capability: "deeplink",
    badge: "Smart Deep-Link",
    description: "Opens Zomato directly to restaurants & dishes near your city.",
    permissions: [
      "Zomato MCP restricts OAuth callbacks to 6 approved clients (no localhost or third-party web apps)",
      "Smart Deep-Links open Zomato delivery search immediately without credentials"
    ]
  }
];

const PREP_PHRASE_RX =
  /\b(finely chopped|roughly chopped|coarsely chopped|thinly sliced|finely diced|finely minced|freshly grated|freshly ground|room temperature|for serving|plus more for serving|to taste|as needed|for garnish|optional|divided|softened|melted|chilled|warmed|peeled and deveined|trimmed and halved|rinsed and drained|chopped|minced|sliced|diced|cubed|grated|crushed|halved|quartered|torn|shredded|beaten|whisked)\b/gi;

const LEADING_QTY_RX =
  /^\s*(?:~|approx\.?\s*)?\d+(?:\s+\d+\/\d+|\s*[¼½¾⅓⅔⅛⅜⅝⅞]|\/\d+|\.\d+)?(?:\s*(?:–|-|to)\s*\d+(?:\.\d+)?)?\s*(?:cups?|tbsp|tablespoons?|tsp|teaspoons?|grams?|g|kg|ml|l|liters?|oz|ounces?|lbs?|pounds?|cloves?|cans?|bunches?|sprigs?|pinch(?:es)?|slices?|pieces?|heads?|stalks?|medium|large|small)?\b\s*(?:of\b\s*)?/i;

/**
 * Extracts a clean grocery search term from an ingredient object or string.
 */
export function cleanIngredientQuery(ingredient) {
  const raw =
    typeof ingredient === "string"
      ? ingredient
      : [ingredient?.item, ingredient?.note].filter(Boolean).join(" ");
  let text = String(raw || "").trim();
  if (!text) return "";

  // Use primary item field first when available to avoid prep notes Polluting queries
  if (ingredient && typeof ingredient === "object" && ingredient.item) {
    text = String(ingredient.item).trim();
  } else {
    text = text.replace(LEADING_QTY_RX, "");
  }

  text = text
    .replace(/\([^)]*\)/g, " ")
    .split(/,|;|\bor\b/i)[0]
    .replace(PREP_PHRASE_RX, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-–—,\s]+|[-–—,\s]+$/g, "")
    .trim();

  return text || String(ingredient?.item || raw || "").trim();
}

function normWord(word) {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function tokenizeFood(str) {
  return String(str || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normWord)
    .filter((t) => t.length >= 3);
}

/**
 * Splits a comma/newline Kitchen Profile pantry string into normalized items.
 */
export function parsePantryItems(pantryStr = "") {
  return String(pantryStr || "")
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesPantry(ingredientQuery, pantryEntries) {
  if (!ingredientQuery || !pantryEntries.length) return false;
  const ingClean = ingredientQuery.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const ingTokens = new Set(tokenizeFood(ingredientQuery));
  if (!ingTokens.size) return false;

  for (const entry of pantryEntries) {
    const pClean = entry.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!pClean) continue;
    if (ingClean === pClean) return true;
    const pTokens = tokenizeFood(pClean);
    if (!pTokens.length) continue;
    // Match when all meaningful tokens of the pantry staple appear in the ingredient (e.g. "miso" matches "white miso")
    // or all tokens of the ingredient appear in the pantry item
    const allPantryInIng = pTokens.every((tk) => ingTokens.has(tk));
    const allIngInPantry = Array.from(ingTokens).every((tk) => pTokens.includes(tk));
    if (allPantryInIng || allIngInPantry) return true;
  }
  return false;
}

/**
 * Computes needed vs checked/pantry ingredients for ordering from a recipe.
 */
export function extractMissingIngredients(
  recipe,
  checkedSet = new Set(),
  pantryStr = "",
  { autoMatchPantry = true, servings, unitSystem = "metric" } = {}
) {
  const list = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
  const checked = checkedSet instanceof Set ? checkedSet : new Set(checkedSet || []);
  const pantryEntries = parsePantryItems(pantryStr);
  const baseServings = Math.max(1, Number(recipe?.servings) || 2);
  const targetServings = Math.max(1, Number(servings) || baseServings);
  const scaleRatio = targetServings / baseServings;

  return list.map((ing, index) => {
    const isChecked = checked.has(index);
    const query = cleanIngredientQuery(ing);
    const pantryMatch = matchesPantry(query, pantryEntries);
    const needed = !isChecked && !(autoMatchPantry && pantryMatch);
    const displayAmount = convertAmount(ing, scaleRatio, unitSystem);
    return {
      index,
      item: ing?.item || "",
      note: ing?.note || "",
      displayAmount,
      query,
      checked: isChecked,
      pantryMatch,
      needed
    };
  });
}

/**
 * Builds direct search deep-links for Indian quick-commerce platforms.
 */
export function buildGroceryDeepLink(platformId, query = "") {
  const q = encodeURIComponent(String(query || "").trim());
  if (platformId === "zepto") {
    return q ? `https://www.zeptonow.com/search?query=${q}` : "https://www.zeptonow.com/";
  }
  if (platformId === "blinkit") {
    return q ? `https://blinkit.com/s/?q=${q}` : "https://blinkit.com/";
  }
  // Default: Swiggy Instamart
  return q
    ? `https://www.swiggy.com/instamart/search?custom_back=true&query=${q}`
    : "https://www.swiggy.com/instamart";
}

function slugifyCity(city = "") {
  return String(city || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds direct restaurant/dish search links for Swiggy Food & Zomato.
 */
export function buildRestaurantDeepLink(platformId, dishQuery = "", city = "") {
  const q = encodeURIComponent(String(dishQuery || "").trim());
  if (platformId === "zomato") {
    const slug = slugifyCity(city);
    if (slug) {
      return q ? `https://www.zomato.com/${slug}/delivery?q=${q}` : `https://www.zomato.com/${slug}/delivery`;
    }
    return q ? `https://www.zomato.com/search?q=${q}` : "https://www.zomato.com/";
  }
  return q ? `https://www.swiggy.com/search?query=${q}` : "https://www.swiggy.com/";
}

const FLAVOR_MODIFIER_RX =
  /\b(brown butter|crispy|charred|smoky|caramelized|seared|roasted|slow|weeknight|one-pan|homemade|classic|easy|spicy|sweet|tangy|herbed|garlicky|glazed)\b/gi;

/**
 * Generates concise search suggestions from an editorial dish title for restaurant ordering.
 */
export function simplifyDishName(title = "") {
  const clean = String(title || "").trim().replace(/\s+/g, " ");
  if (!clean) return [];
  const results = [clean];

  const stripped = clean
    .replace(FLAVOR_MODIFIER_RX, " ")
    .replace(/\b(with|in|on|over|and)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped.toLowerCase() !== clean.toLowerCase() && stripped.length >= 3) {
    results.push(stripped);
  }

  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const lastTwo = words.slice(-2).join(" ");
    if (!results.some((r) => r.toLowerCase() === lastTwo.toLowerCase())) {
      results.push(lastTwo);
    }
  }
  const lastWord = words[words.length - 1];
  if (lastWord && lastWord.length >= 4 && !results.some((r) => r.toLowerCase() === lastWord.toLowerCase())) {
    results.push(lastWord);
  }

  return results.slice(0, 3);
}

export function createDefaultDeliveryPrefs() {
  return {
    preferredGrocery: "swiggy-im",
    preferredFood: "swiggy-food",
    city: "",
    autoMatchPantry: true,
    companionUrl: ""
  };
}

function getDefaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadDeliveryPrefs(storage = getDefaultStorage()) {
  const defaults = createDefaultDeliveryPrefs();
  if (!storage) return defaults;
  try {
    const raw = JSON.parse(storage.getItem(DELIVERY_PREFS_KEY) || "null");
    if (!raw || typeof raw !== "object") return defaults;
    return {
      ...defaults,
      preferredGrocery: ["swiggy-im", "zepto", "blinkit"].includes(raw.preferredGrocery)
        ? raw.preferredGrocery
        : defaults.preferredGrocery,
      preferredFood: ["swiggy-food", "zomato"].includes(raw.preferredFood)
        ? raw.preferredFood
        : defaults.preferredFood,
      city: typeof raw.city === "string" ? raw.city : "",
      autoMatchPantry: raw.autoMatchPantry !== undefined ? Boolean(raw.autoMatchPantry) : true,
      companionUrl: typeof raw.companionUrl === "string" ? raw.companionUrl.trim().replace(/\/+$/, "") : ""
    };
  } catch {
    return defaults;
  }
}

export function saveDeliveryPrefs(prefs, storage = getDefaultStorage()) {
  const defaults = createDefaultDeliveryPrefs();
  const normalized = {
    ...defaults,
    ...(prefs || {}),
    preferredGrocery: ["swiggy-im", "zepto", "blinkit"].includes(prefs?.preferredGrocery)
      ? prefs.preferredGrocery
      : defaults.preferredGrocery,
    preferredFood: ["swiggy-food", "zomato"].includes(prefs?.preferredFood)
      ? prefs.preferredFood
      : defaults.preferredFood,
    city: String(prefs?.city || "").trim(),
    autoMatchPantry: prefs?.autoMatchPantry !== undefined ? Boolean(prefs.autoMatchPantry) : true,
    companionUrl: String(prefs?.companionUrl || "").trim().replace(/\/+$/, "")
  };
  if (storage) {
    try {
      storage.setItem(DELIVERY_PREFS_KEY, JSON.stringify(normalized));
    } catch {
      // Storage unavailable
    }
  }
  return normalized;
}

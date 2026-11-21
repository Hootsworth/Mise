import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERY_PREFS_KEY,
  cleanIngredientQuery,
  parsePantryItems,
  extractMissingIngredients,
  buildGroceryDeepLink,
  buildRestaurantDeepLink,
  simplifyDishName,
  loadDeliveryPrefs,
  saveDeliveryPrefs
} from "../public/js/delivery-links.js";
import { isSameOriginSafe, resolveCompanionOrigin } from "../public/js/mcp-client.js";

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

test("cleanIngredientQuery strips quantities, parentheticals, and prep instructions", () => {
  assert.equal(cleanIngredientQuery({ item: "yellow onion", note: "finely diced" }), "yellow onion");
  assert.equal(cleanIngredientQuery({ item: "white miso paste (divided)", note: "" }), "white miso paste");
  assert.equal(cleanIngredientQuery("2 tbsp extra virgin olive oil, plus more for serving"), "extra virgin olive oil");
  assert.equal(cleanIngredientQuery("1½ cups arborio rice, rinsed and drained"), "arborio rice");
  assert.equal(cleanIngredientQuery({ item: "unsalted butter, softened" }), "unsalted butter");
});

test("extractMissingIngredients excludes checked items and matches Kitchen Profile pantry staples", () => {
  const recipe = {
    servings: 2,
    ingredients: [
      { amount: 200, unit: "g", item: "rigatoni" },
      { amount: 2, unit: "tbsp", item: "white miso", note: "whisked" },
      { amount: 250, unit: "g", item: "cremini mushrooms", note: "sliced" },
      { amount: 1, unit: "tbsp", item: "sesame oil" }
    ]
  };

  const checked = new Set([0]);
  const pantry = "miso, kosher salt, black pepper";

  const rowsAuto = extractMissingIngredients(recipe, checked, pantry, {
    autoMatchPantry: true,
    servings: 4,
    unitSystem: "metric"
  });
  assert.equal(rowsAuto.length, 4);
  assert.equal(rowsAuto[0].checked, true);
  assert.equal(rowsAuto[0].needed, false);
  assert.equal(rowsAuto[1].pantryMatch, true);
  assert.equal(rowsAuto[1].needed, false);
  assert.equal(rowsAuto[2].pantryMatch, false);
  assert.equal(rowsAuto[2].needed, true);
  assert.equal(rowsAuto[2].displayAmount, "500 g");
  assert.equal(rowsAuto[3].needed, true);

  const rowsNoAuto = extractMissingIngredients(recipe, checked, pantry, {
    autoMatchPantry: false
  });
  assert.equal(rowsNoAuto[1].needed, true);
  assert.deepEqual(parsePantryItems("miso, rice\nsalt"), ["miso", "rice", "salt"]);
});

test("buildGroceryDeepLink and buildRestaurantDeepLink generate valid URLs", () => {
  assert.equal(
    buildGroceryDeepLink("zepto", "white miso"),
    "https://www.zeptonow.com/search?query=white%20miso"
  );
  assert.equal(
    buildGroceryDeepLink("blinkit", "cremini mushrooms"),
    "https://blinkit.com/s/?q=cremini%20mushrooms"
  );
  assert.equal(
    buildGroceryDeepLink("swiggy-im", "rigatoni"),
    "https://www.swiggy.com/instamart/search?custom_back=true&query=rigatoni"
  );

  assert.equal(
    buildRestaurantDeepLink("zomato", "Miso Rigatoni", "Bengaluru"),
    "https://www.zomato.com/bengaluru/delivery?q=Miso%20Rigatoni"
  );
  assert.equal(
    buildRestaurantDeepLink("zomato", "Miso Rigatoni", ""),
    "https://www.zomato.com/search?q=Miso%20Rigatoni"
  );
  assert.equal(
    buildRestaurantDeepLink("swiggy-food", "Miso Rigatoni", "Mumbai"),
    "https://www.swiggy.com/search?query=Miso%20Rigatoni"
  );
});

test("simplifyDishName produces concise restaurant query fallbacks", () => {
  const chips = simplifyDishName("Brown Butter Miso Rigatoni");
  assert.equal(chips[0], "Brown Butter Miso Rigatoni");
  assert.ok(chips.includes("Miso Rigatoni"));
});

test("delivery preferences normalize and round-trip cleanly in storage", () => {
  const storage = makeMemoryStorage();
  const initial = loadDeliveryPrefs(storage);
  assert.equal(initial.preferredGrocery, "swiggy-im");
  assert.equal(initial.preferredFood, "swiggy-food");
  assert.equal(initial.autoMatchPantry, true);

  saveDeliveryPrefs(
    {
      preferredGrocery: "zepto",
      preferredFood: "zomato",
      city: "  Bengaluru ",
      autoMatchPantry: false,
      companionUrl: "http://localhost:3456/"
    },
    storage
  );

  const loaded = loadDeliveryPrefs(storage);
  assert.ok(storage.getItem(DELIVERY_PREFS_KEY));
  assert.equal(loaded.preferredGrocery, "zepto");
  assert.equal(loaded.preferredFood, "zomato");
  assert.equal(loaded.city, "Bengaluru");
  assert.equal(loaded.autoMatchPantry, false);
  assert.equal(loaded.companionUrl, "http://localhost:3456");
});

test("isSameOriginSafe validates origins strictly and rejects null or spoofed hosts", () => {
  assert.equal(isSameOriginSafe("https://adityapdixit.me/Mise/", "https://adityapdixit.me"), true);
  assert.equal(isSameOriginSafe("http://localhost:3456/callback", "http://localhost:3456"), true);

  // Prefix/substring spoofing must fail
  assert.equal(isSameOriginSafe("https://adityapdixit.me.attacker.com", "https://adityapdixit.me"), false);
  // Protocol mismatch must fail
  assert.equal(isSameOriginSafe("http://adityapdixit.me", "https://adityapdixit.me"), false);
  // Opaque "null" origins must never validate against each other
  assert.equal(isSameOriginSafe("null", "null"), false);
  assert.equal(isSameOriginSafe("data:text/html,hi", "https://adityapdixit.me"), false);

  if (typeof MessageEvent !== "undefined") {
    const validMsg = new MessageEvent("message", { origin: "http://localhost:3456" });
    const opaqueMsg = new MessageEvent("message", { origin: "null" });
    assert.equal(isSameOriginSafe(validMsg, "http://localhost:3456"), true);
    assert.equal(isSameOriginSafe(opaqueMsg, "http://localhost:3456"), false);
    assert.equal(isSameOriginSafe(opaqueMsg, "null"), false);
  }
});

test("resolveCompanionOrigin returns empty string on static HTTPS pages unless configured", () => {
  assert.equal(
    resolveCompanionOrigin({ companionUrl: "" }, { hostname: "adityapdixit.me", origin: "https://adityapdixit.me" }),
    ""
  );
  assert.equal(
    resolveCompanionOrigin({ companionUrl: "" }, { hostname: "localhost", origin: "http://localhost:3456" }),
    "http://localhost:3456"
  );
  assert.equal(
    resolveCompanionOrigin(
      { companionUrl: "http://localhost:3456/" },
      { hostname: "adityapdixit.me", origin: "https://adityapdixit.me" }
    ),
    "http://localhost:3456"
  );
});

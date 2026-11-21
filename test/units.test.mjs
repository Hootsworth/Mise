import test from "node:test";
import assert from "node:assert/strict";
import {
  formatFraction,
  convertAmount,
  convertStepTemperatures,
  extractTimersFromStep,
  matchStepIngredients,
  diffRecipes,
  isExploratoryPrompt
} from "../public/js/units.js";

test("formatFraction formats culinary fractions accurately", () => {
  assert.equal(formatFraction(null), "");
  assert.equal(formatFraction(0), "");
  assert.equal(formatFraction(0.25), "¼");
  assert.equal(formatFraction(0.33), "⅓");
  assert.equal(formatFraction(0.5), "½");
  assert.equal(formatFraction(0.67), "⅔");
  assert.equal(formatFraction(0.75), "¾");
  assert.equal(formatFraction(1.5), "1½");
  assert.equal(formatFraction(2.125), "2⅛");
});

test("convertAmount scales and promotes g -> kg and ml -> L cleanly", () => {
  assert.equal(convertAmount({ item: "flour", amount: 500, unit: "g" }, 2, "metric"), "1 kg");
  assert.equal(convertAmount({ item: "flour", amount: 600, unit: "g" }, 2, "metric"), "1.2 kg");
  assert.equal(convertAmount({ item: "stock", amount: 500, unit: "ml" }, 3, "metric"), "1.5 L");
  assert.equal(convertAmount({ item: "butter", amount: 45, unit: "g" }, 2, "metric"), "90 g");
  assert.equal(convertAmount({ item: "sugar", amount: 1, unit: "tbsp" }, 1.5, "metric"), "1½ tbsp");
});

test("convertAmount converts between metric and US units cleanly", () => {
  assert.equal(convertAmount({ item: "pasta", amount: 225, unit: "g" }, 1, "us"), "8 oz");
  assert.equal(convertAmount({ item: "roast", amount: 907, unit: "g" }, 1, "us"), "2 lb");
  assert.equal(convertAmount({ item: "broth", amount: 240, unit: "ml" }, 1, "us"), "1 cup");
  assert.equal(convertAmount({ item: "oil", amount: 30, unit: "ml" }, 1, "us"), "2 tbsp");
  assert.equal(convertAmount({ item: "butter", amount: 4, unit: "oz" }, 1, "metric"), "115 g");
  assert.equal(convertAmount({ item: "milk", amount: 1, unit: "cup" }, 1, "metric"), "240 ml");
});

test("convertStepTemperatures converts °C and °F inside method text", () => {
  assert.equal(
    convertStepTemperatures("Preheat oven to 200°C and bake until 95 °C internal.", "us"),
    "Preheat oven to 390°F and bake until 205°F internal."
  );
  assert.equal(
    convertStepTemperatures("Roast at 400°F for 20 minutes.", "metric"),
    "Roast at 205°C for 20 minutes."
  );
});

test("extractTimersFromStep extracts explicit minutes and inline duration ranges without duplicates", () => {
  const timers = extractTimersFromStep({
    title: "Simmer",
    text: "Simmer covered for 8–10 minutes, then rest 45 seconds before serving.",
    minutes: 10
  });
  assert.deepEqual(timers, [
    { label: "10 min", seconds: 600 },
    { label: "45 sec", seconds: 45 }
  ]);

  const hourTimer = extractTimersFromStep({
    title: "Braise",
    text: "Braise gently for 1.5 hours until tender.",
    minutes: null
  });
  assert.deepEqual(hourTimer, [{ label: "1.5 hr", seconds: 5400 }]);
});

test("matchStepIngredients identifies ingredients mentioned in a step", () => {
  const ingredients = [
    { item: "mixed mushrooms", amount: 280, unit: "g" },
    { item: "unsalted butter", amount: 45, unit: "g" },
    { item: "white miso paste", amount: 1.5, unit: "tbsp" },
    { item: "chives", amount: 2, unit: "tbsp" }
  ];
  const matched = matchStepIngredients(
    "Add the butter to the skillet over medium heat, then sear each mushroom until golden.",
    ingredients
  );
  assert.deepEqual(matched, [0, 1]);
});

test("diffRecipes marks only changed or added ingredients and steps", () => {
  const v1 = {
    title: "Miso Pasta",
    time_minutes: 20,
    difficulty: "Easy",
    ingredients: [
      { item: "pasta", amount: 200, unit: "g", note: "" },
      { item: "butter", amount: 40, unit: "g", note: "" }
    ],
    steps: [
      { title: "Boil", text: "Boil pasta.", minutes: 8 },
      { title: "Finish", text: "Toss with butter.", minutes: 2 }
    ]
  };
  const v2 = {
    title: "Vegan Miso Pasta",
    time_minutes: 20,
    difficulty: "Easy",
    ingredients: [
      { item: "pasta", amount: 200, unit: "g", note: "" },
      { item: "olive oil", amount: 3, unit: "tbsp", note: "extra-virgin" }
    ],
    steps: [
      { title: "Boil", text: "Boil pasta.", minutes: 8 },
      { title: "Finish", text: "Toss with olive oil.", minutes: 2 }
    ]
  };
  const diff = diffRecipes(v1, v2);
  assert.equal(diff.metaChanged, true);
  assert.deepEqual([...diff.changedIngredientIdx], [1]);
  assert.deepEqual([...diff.changedStepIdx], [1]);
});

test("isExploratoryPrompt routes fridge/craving/multi-ingredient prompts to the options grid", () => {
  assert.equal(isExploratoryPrompt("miso pasta", "fridge", false, []), true);
  assert.equal(isExploratoryPrompt("tahini", "craving", false, []), true);
  assert.equal(isExploratoryPrompt("", "any", false, ["egg", "rice"]), true);
  assert.equal(isExploratoryPrompt("", "any", true, []), true);
  assert.equal(isExploratoryPrompt("", "recreate", true, []), false);
  assert.equal(isExploratoryPrompt("Something with miso and mushrooms", "any", false, []), true);
  assert.equal(isExploratoryPrompt("chicken, lemon, garlic", "any", false, []), true);
  assert.equal(isExploratoryPrompt("Classic Carbonara", "any", false, []), false);
});

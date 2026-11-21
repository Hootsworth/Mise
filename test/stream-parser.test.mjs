import test from "node:test";
import assert from "node:assert/strict";
import { extractPartialRecipe } from "../public/js/stream-parser.js";

test("extractPartialRecipe streams title, ingredients, and partial step text incrementally", () => {
  const chunk1 = '{"title":"Charred Cabbage","tagline":"Crisp edges and miso butter.","time_minutes":20,"ingredients":[{"item":"green cabbage","amount":500,"unit":"g"}';
  const r1 = extractPartialRecipe(chunk1);
  assert.equal(r1.isComplete, false);
  assert.equal(r1.phase, "ingredients");
  assert.equal(r1.recipe.title, "Charred Cabbage");
  assert.equal(r1.recipe.time_minutes, 20);
  assert.equal(r1.recipe.ingredients.length, 1);
  assert.equal(r1.recipe.ingredients[0].item, "green cabbage");

  const chunk2 = `${chunk1},{"item":"miso","amount":2,"unit":"tbsp"}],"steps":[{"title":"Sear wedges","text":"Heat a heavy skillet until smoking and lay`;
  const r2 = extractPartialRecipe(chunk2);
  assert.equal(r2.isComplete, false);
  assert.equal(r2.phase, "steps");
  assert.equal(r2.recipe.ingredients.length, 2);
  assert.equal(r2.recipe.steps.length, 1);
  assert.equal(r2.recipe.steps[0].title, "Sear wedges");
  assert.match(r2.recipe.steps[0].text, /Heat a heavy skillet/);
});

test("extractPartialRecipe handles escaped quotes, markdown fences, and complete JSON", () => {
  const fenced = '```json\n{"title":"Chef \\"No-Fuss\\" Tofu","tagline":"Crisp.","ingredients":[{"item":"tofu","amount":300,"unit":"g"}],"steps":[{"title":"Press","text":"Press tofu.","minutes":5}],"tips":["Dry well."]}\n```';
  const res = extractPartialRecipe(fenced);
  assert.equal(res.isComplete, true);
  assert.equal(res.phase, "done");
  assert.equal(res.recipe.title, 'Chef "No-Fuss" Tofu');
  assert.deepEqual(res.recipe.tips, ["Dry well."]);
});

test("extractPartialRecipe handles non-JSON preamble gracefully", () => {
  const res = extractPartialRecipe("Here is your recipe:\n{");
  assert.equal(res.isComplete, false);
  assert.equal(res.recipe, null);
});

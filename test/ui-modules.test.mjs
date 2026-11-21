import test from "node:test";
import assert from "node:assert/strict";

import { COOKING_PHASES, renderPotSvg, renderCookingLoader } from "../public/js/cooking-loader.js";
import {
  ONBOARDING_STORAGE_KEY,
  hasCompletedOnboarding,
  markOnboardingComplete,
  resetOnboarding
} from "../public/js/onboarding.js";

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

test("renderCookingLoader renders monochrome Dutch-oven pot SVG in card and compact modes with XSS escaping", () => {
  assert.equal(COOKING_PHASES.length, 4);

  const svg = renderPotSvg();
  assert.match(svg, /pot-lid/);
  assert.match(svg, /pot-steam-1/);
  assert.match(svg, /pot-steam-2/);
  assert.match(svg, /pot-steam-3/);
  assert.match(svg, /pot-heat/);

  const card = renderCookingLoader({
    label: "Simmering <Broth>…",
    detail: "Balancing salt & umami"
  });
  assert.match(card, /class="cook-loader-card"/);
  assert.match(card, /role="status"/);
  assert.match(card, /Simmering &lt;Broth&gt;…/);
  assert.match(card, /Balancing salt &amp; umami/);

  const compact = renderCookingLoader({
    compact: true,
    label: "Tasting…"
  });
  assert.match(compact, /cook-loader is-compact/);
  assert.match(compact, /Tasting…/);
  assert.doesNotMatch(compact, /cook-loader-card/);
});

test("onboarding state helpers track completion, skip status, and reset cleanly", () => {
  const storage = makeMemoryStorage();
  assert.equal(hasCompletedOnboarding(storage), false);

  markOnboardingComplete("done", storage);
  assert.equal(storage.getItem(ONBOARDING_STORAGE_KEY), "done");
  assert.equal(hasCompletedOnboarding(storage), true);

  resetOnboarding(storage);
  assert.equal(hasCompletedOnboarding(storage), false);

  markOnboardingComplete("skipped", storage);
  assert.equal(hasCompletedOnboarding(storage), true);
  assert.equal(storage.getItem(ONBOARDING_STORAGE_KEY), "skipped");
});

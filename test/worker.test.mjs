import test from "node:test";
import assert from "node:assert/strict";

import { handleWorkerRequest } from "../worker/index.mjs";

function makeSseStream(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

const VALID_RECIPE = {
  title: "Smoky Miso Eggplant",
  tagline: "Silky glazed slices",
  cuisine: "Japanese",
  servings: 2,
  prep_minutes: 10,
  cook_minutes: 15,
  time_minutes: 25,
  difficulty: "Easy",
  visual_prompt: "Charred miso eggplant on dark stoneware.",
  ingredients: [{ item: "Eggplant", amount: 2, unit: "", note: "" }],
  steps: [{ title: "Roast", text: "Roast until tender.", minutes: 15 }],
  tips: ["Score in diamonds before searing."]
};

test("worker enforces CORS allowlist for GitHub Pages & custom domain origins", async () => {
  for (const allowedOrigin of ["https://adityapdixit.me", "https://hootsworth.github.io"]) {
    const preflight = await handleWorkerRequest(
      new Request("https://mise-api.workers.dev/api/health", {
        method: "OPTIONS",
        headers: { Origin: allowedOrigin }
      }),
      { GEMINI_API_KEY: "gk" }
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
    assert.match(preflight.headers.get("Access-Control-Allow-Methods"), /POST/);
  }

  const blocked = await handleWorkerRequest(
    new Request("https://mise-api.workers.dev/api/health", {
      method: "GET",
      headers: { Origin: "https://untrusted.example" }
    }),
    { GEMINI_API_KEY: "gk" }
  );
  assert.equal(blocked.status, 403);
});

test("worker GET /api/health reports public catalog without leaking secrets", async () => {
  const res = await handleWorkerRequest(
    new Request("https://mise-api.workers.dev/api/health", {
      method: "GET",
      headers: { Origin: "https://adityapdixit.me" }
    }),
    { MODEL_API_KEY: "LLM_secret", OPENAI_API_KEY: "sk_secret" }
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://adityapdixit.me");

  const body = await res.json();
  const raw = JSON.stringify(body);
  assert.equal(raw.includes("LLM_secret"), false);
  assert.equal(raw.includes("sk_secret"), false);
  assert.equal(body.ok, true);
  assert.equal(body.imageGenerationAvailable, true);
  assert.equal(body.aiImageGenerationAvailable, true);
  assert.equal(body.providers.find((p) => p.id === "meta")?.configured, true);
  assert.equal(body.providers.find((p) => p.id === "openai")?.configured, true);
});

test("worker POST /api/ideas normalizes dish options", async () => {
  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                options: [
                  {
                    title: "Charred Miso Cabbage",
                    tagline: "Savory wedge",
                    cuisine: "Japanese",
                    totalTime: "20m",
                    difficulty: "Easy",
                    matchNote: "Uses cabbage + miso",
                    keyIngredients: ["cabbage", "miso"]
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const res = await handleWorkerRequest(
    new Request("https://mise-api.workers.dev/api/ideas", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hootsworth.github.io" },
      body: JSON.stringify({ provider: "openai", ingredients: ["cabbage", "miso"], mode: "fridge" })
    }),
    { OPENAI_API_KEY: "sk-test" },
    { fetchImpl: mockFetch, imageCache: new Map() }
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.options.length, 1);
  assert.equal(json.options[0].title, "Charred Miso Cabbage");
});

test("worker POST /api/dish-image uses open endpoints by default and separates open vs AI caches", async () => {
  const imageCache = new Map();
  let openverseCalls = 0;
  let aiImageCalls = 0;

  const mockFetch = async (url) => {
    if (String(url).startsWith("https://api.openverse.org/")) {
      openverseCalls += 1;
      return new Response(
        JSON.stringify({
          results: [{ thumbnail: "https://cdn.openverse.org/eggplant.jpg", width: 900, creator: "Open Chef" }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (String(url).startsWith("https://api.openai.com/v1/images/generations")) {
      aiImageCalls += 1;
      return new Response(
        JSON.stringify({ data: [{ b64_json: "QUJD" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 404 });
  };

  // 1. Default (useAi omitted -> false) uses Openverse and leaves OpenAI image endpoint untouched
  const openRes = await handleWorkerRequest(
    new Request("https://mise-api.workers.dev/api/dish-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://adityapdixit.me" },
      body: JSON.stringify({
        provider: "openai",
        title: "Smoky Miso Eggplant",
        visualPrompt: "Charred miso eggplant on stone."
      })
    }),
    { OPENAI_API_KEY: "sk-test" },
    { fetchImpl: mockFetch, imageCache }
  );
  const openData = await openRes.json();
  assert.equal(openData.source, "openverse");
  assert.equal(openData.imageUrl, "https://cdn.openverse.org/eggplant.jpg");
  assert.equal(openverseCalls, 1);
  assert.equal(aiImageCalls, 0);

  // 2. Explicit opt-in (useAi: true) misses open cache and generates with OpenAI
  const aiRes = await handleWorkerRequest(
    new Request("https://mise-api.workers.dev/api/dish-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://adityapdixit.me" },
      body: JSON.stringify({
        provider: "openai",
        title: "Smoky Miso Eggplant",
        visualPrompt: "Charred miso eggplant on stone.",
        useAi: true
      })
    }),
    { OPENAI_API_KEY: "sk-test" },
    { fetchImpl: mockFetch, imageCache }
  );
  const aiData = await aiRes.json();
  assert.equal(aiData.source, "openai");
  assert.equal(aiData.imageUrl, "data:image/png;base64,QUJD");
  assert.equal(aiImageCalls, 1);

  // 3. Repeat default open call hits the open cache entry, not AI cache
  const openCachedRes = await handleWorkerRequest(
    new Request("https://mise-api.workers.dev/api/dish-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://adityapdixit.me" },
      body: JSON.stringify({
        provider: "openai",
        title: "Smoky Miso Eggplant",
        visualPrompt: "Charred miso eggplant on stone."
      })
    }),
    { OPENAI_API_KEY: "sk-test" },
    { fetchImpl: mockFetch, imageCache }
  );
  const openCachedData = await openCachedRes.json();
  assert.equal(openCachedData.cached, true);
  assert.equal(openCachedData.source, "openverse");
});

test("worker POST /api/generate streams SSE delta and done events", async () => {
  const recipeText = JSON.stringify(VALID_RECIPE);
  const mid = Math.floor(recipeText.length / 2);
  const mockFetch = async () =>
    makeSseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: recipeText.slice(0, mid) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: recipeText.slice(mid) } }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);

  const res = await handleWorkerRequest(
    new Request("https://mise-api.workers.dev/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://adityapdixit.me" },
      body: JSON.stringify({ provider: "openai", query: "miso eggplant" })
    }),
    { OPENAI_API_KEY: "sk-test" },
    { fetchImpl: mockFetch, imageCache: new Map() }
  );
  assert.equal(res.status, 200);
  const sseText = await res.text();
  assert.match(sseText, /event: delta/);
  assert.match(sseText, /event: done/);
  const match = /event: done\ndata: (.+)\n/.exec(sseText);
  assert.equal(JSON.parse(match[1]).recipe.title, "Smoky Miso Eggplant");
});

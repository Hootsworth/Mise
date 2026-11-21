import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";

const MOCK_RECIPE = {
  title: "Smoky Miso Eggplant",
  tagline: "Silky blistered eggplant glazed with sweet-savory white miso.",
  prep_minutes: 5,
  cook_minutes: 15,
  time_minutes: 20,
  difficulty: "Easy",
  servings: 2,
  cuisine: "Japanese",
  visual_prompt: "Blistered miso eggplant halves on dark stoneware.",
  ingredients: [
    { item: "eggplant", amount: 400, unit: "g", note: "halved lengthwise" },
    { item: "white miso", amount: 2, unit: "tbsp", note: "" }
  ],
  steps: [
    { title: "Score and sear", text: "Sear cut-side down 6 minutes until charred.", minutes: 6 },
    { title: "Glaze and broil", text: "Brush with miso and broil 3 minutes.", minutes: 3 }
  ],
  tips: ["Score in a tight diamond pattern so steam escapes evenly."]
};

const TEST_ENV = {
  DEFAULT_PROVIDER: "openai",
  OPENAI_API_KEY: "server-openai-secret",
  OPENAI_MODEL: "gpt-4.1-mini",
  OPENAI_IMAGE_MODEL: "gpt-image-1"
};

function makeSseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

async function startTestServer(fetchImpl, env = TEST_ENV) {
  const server = createServer({ fetchImpl, env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("GET /api/health returns public provider catalog without secrets and blocks path traversal", async () => {
  const srv = await startTestServer(async () => new Response("{}"));
  try {
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.defaultProvider, "openai");
    assert.equal(health.providers.find((p) => p.id === "openai").configured, true);
    assert.equal(JSON.stringify(health).includes("server-openai-secret"), false);
    assert.equal(JSON.stringify(health).includes("gpt-4.1-mini"), false);

    const htmlRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Mise — a recipe for anything/);

    const imgRes = await fetch(`${srv.baseUrl}/images/miso-rigatoni.jpg`);
    assert.equal(imgRes.status, 200);

    const travRes = await fetch(`${srv.baseUrl}/../package.json`);
    assert.ok(travRes.status === 403 || travRes.status === 404);
  } finally {
    await srv.close();
  }
});

test("POST /api/ideas returns curated options grid and POST /api/dish-image uses open-first default and caches open vs AI separately", async () => {
  let imageCalls = 0;
  let openCalls = 0;
  const mockFetch = async (url) => {
    if (String(url).startsWith("https://api.openverse.org/")) {
      openCalls++;
      return new Response(
        JSON.stringify({
          results: [{ thumbnail: "https://cdn.openverse.org/eggplant.jpg", width: 900, creator: "Open Chef" }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (String(url).includes("/images/generations")) {
      imageCalls++;
      return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                prompt_summary: "Dishes with eggplant and miso",
                options: [
                  {
                    id: "opt-1",
                    title: "Smoky Miso Eggplant",
                    tagline: "Blistered sweet-savory halves.",
                    time_minutes: 20,
                    difficulty: "Easy",
                    cuisine: "Japanese",
                    vibe: "Silky & Charred",
                    uses: ["eggplant", "miso"],
                    extras_needed: [],
                    pantry_only: true,
                    visual_prompt: "Blistered eggplant on stone."
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const srv = await startTestServer(mockFetch);
  try {
    const ideasRes = await fetch(`${srv.baseUrl}/api/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        ingredients: ["eggplant", "miso"],
        mode: "fridge"
      })
    });
    assert.equal(ideasRes.status, 200);
    const ideas = await ideasRes.json();
    assert.equal(ideas.options.length, 1);
    assert.equal(ideas.options[0].title, "Smoky Miso Eggplant");

    const openImgRes = await fetch(`${srv.baseUrl}/api/dish-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        title: "Smoky Miso Eggplant",
        visualPrompt: "Blistered eggplant on stone."
      })
    });
    const dOpen = await openImgRes.json();
    assert.equal(dOpen.source, "openverse");
    assert.equal(dOpen.imageUrl, "https://cdn.openverse.org/eggplant.jpg");
    assert.equal(openCalls, 1);
    assert.equal(imageCalls, 0);

    const img1 = await fetch(`${srv.baseUrl}/api/dish-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        title: "Smoky Miso Eggplant",
        visualPrompt: "Blistered eggplant on stone.",
        useAi: true
      })
    });
    const d1 = await img1.json();
    assert.equal(d1.imageUrl, "data:image/png;base64,QUJD");
    assert.equal(d1.source, "openai");
    assert.equal(imageCalls, 1);

    const img2 = await fetch(`${srv.baseUrl}/api/dish-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        title: "Smoky Miso Eggplant",
        visualPrompt: "Blistered eggplant on stone.",
        useAi: true
      })
    });
    const d2 = await img2.json();
    assert.equal(d2.cached, true);
    assert.equal(d2.source, "openai");
    assert.equal(imageCalls, 1);

    const openCachedRes = await fetch(`${srv.baseUrl}/api/dish-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        title: "Smoky Miso Eggplant",
        visualPrompt: "Blistered eggplant on stone."
      })
    });
    const dOpenCached = await openCachedRes.json();
    assert.equal(dOpenCached.cached, true);
    assert.equal(dOpenCached.source, "openverse");
    assert.equal(openCalls, 1);
  } finally {
    await srv.close();
  }
});

test("POST /api/generate streams SSE delta and done events using server env keys", async () => {
  const jsonText = JSON.stringify(MOCK_RECIPE);
  const half = Math.floor(jsonText.length / 2);
  let seenAuth = "";
  const mockFetch = async (_url, init) => {
    seenAuth = init.headers.Authorization;
    return makeSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: jsonText.slice(0, half) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: jsonText.slice(half) } }] })}\n\n`,
      `data: [DONE]\n\n`
    ]);
  };

  const srv = await startTestServer(mockFetch);
  try {
    const res = await fetch(`${srv.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        apiKey: "ignored-client-key",
        query: "miso eggplant"
      })
    });
    assert.equal(res.status, 200);
    assert.equal(seenAuth, "Bearer server-openai-secret");
    const text = await res.text();
    assert.match(text, /event: delta/);
    assert.match(text, /event: done/);
    const doneMatch = /event: done\ndata: (.+)\n/.exec(text);
    const doneData = JSON.parse(doneMatch[1]);
    assert.equal(doneData.recipe.title, "Smoky Miso Eggplant");
  } finally {
    await srv.close();
  }
});

test("POST /api/revise, /api/ingredient-intel, /api/step-help, and /api/enrich work end-to-end", async () => {
  const mockFetch = async (_url, init) => {
    const reqBody = JSON.parse(init.body);
    const userMsg = reqBody.messages?.[1]?.content || "";
    if (userMsg.includes("Revision request")) {
      const revised = { ...MOCK_RECIPE, title: "Spicy Smoky Miso Eggplant", change_summary: "Added chili crisp." };
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(revised) } }] })}\n\n`,
        `data: [DONE]\n\n`
      ]);
    }
    if (userMsg.includes("Target ingredient")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  role: "Brings deep fermented umami.",
                  prep_tip: "Whisk smooth before brushing.",
                  swaps: [{ item: "red miso", amount: 1.5, unit: "tbsp", note: "", ratio_note: "More intense salt" }],
                  answer: ""
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (userMsg.includes("Current step")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "Lower heat slightly and brush with a drop of oil.",
                  sensory_cue: "Flesh yields to a paring knife.",
                  suggested_revision: null
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (userMsg.includes("Section requested: nutrition")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  per_serving: { calories: 210, protein_g: 5, carbs_g: 18, fat_g: 12, fiber_g: 6, sodium_mg: 620 },
                  dietary_tags: ["Vegan"],
                  note: "Estimate only."
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error("Unexpected mock call");
  };

  const srv = await startTestServer(mockFetch);
  try {
    const revRes = await fetch(`${srv.baseUrl}/api/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        recipe: MOCK_RECIPE,
        instruction: "Make it spicy"
      })
    });
    assert.equal(revRes.status, 200);
    const revText = await revRes.text();
    assert.match(revText, /Spicy Smoky Miso Eggplant/);

    const ingRes = await fetch(`${srv.baseUrl}/api/ingredient-intel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        recipe: MOCK_RECIPE,
        ingredientIndex: 1
      })
    });
    assert.equal(ingRes.status, 200);
    const ingData = await ingRes.json();
    assert.equal(ingData.swaps[0].item, "red miso");

    const stepRes = await fetch(`${srv.baseUrl}/api/step-help`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        recipe: MOCK_RECIPE,
        stepIndex: 0,
        question: "Is it burning?"
      })
    });
    assert.equal(stepRes.status, 200);
    const stepData = await stepRes.json();
    assert.match(stepData.answer, /Lower heat/);

    const enrRes = await fetch(`${srv.baseUrl}/api/enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        recipe: MOCK_RECIPE,
        section: "nutrition"
      })
    });
    assert.equal(enrRes.status, 200);
    const enrData = await enrRes.json();
    assert.equal(enrData.per_serving.calories, 210);
  } finally {
    await srv.close();
  }
});

test("POST /api/generate rejects unconfigured server providers with HTTP 400 JSON", async () => {
  const srv = await startTestServer(async () => new Response("{}"), {});
  try {
    const res = await fetch(`${srv.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        apiKey: "ignored-client-key",
        query: "soup"
      })
    });
    assert.equal(res.status, 400);
    const err = await res.json();
    assert.match(err.error, /not configured on this server/i);
  } finally {
    await srv.close();
  }
});

test("Meta AI provider routes /api/health, /api/generate, and /api/dish-image via https://api.meta.ai/v1", async () => {
  const calls = [];
  const jsonText = JSON.stringify(MOCK_RECIPE);
  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization, body: JSON.parse(init.body) });
    if (String(url).endsWith("/images/generations")) {
      return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return makeSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: jsonText } }] })}\n\n`,
      `data: [DONE]\n\n`
    ]);
  };

  const srv = await startTestServer(mockFetch, {
    DEFAULT_PROVIDER: "meta",
    MODEL_API_KEY: "LLM_test_meta_key"
  });
  try {
    const health = await (await fetch(`${srv.baseUrl}/api/health`)).json();
    assert.equal(health.defaultProvider, "meta");
    assert.equal(health.providers.find((p) => p.id === "meta").configured, true);

    const genRes = await fetch(`${srv.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "meta", query: "miso eggplant" })
    });
    assert.equal(genRes.status, 200);
    const sse = await genRes.text();
    assert.match(sse, /event: done/);
    assert.equal(calls[0].url, "https://api.meta.ai/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer LLM_test_meta_key");
    assert.equal(calls[0].body.model, "muse-spark-1.3");
    assert.equal(calls[0].body.messages[0].role, "developer");

    const imgRes = await fetch(`${srv.baseUrl}/api/dish-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "meta", title: "Smoky Miso Eggplant", useAi: true })
    });
    const imgJson = await imgRes.json();
    assert.equal(imgJson.source, "meta");
    assert.equal(imgJson.imageUrl, "data:image/png;base64,QUJD");
    assert.equal(calls[1].url, "https://api.meta.ai/v1/images/generations");
    assert.equal(calls[1].body.model, "muse-image-1.0");
  } finally {
    await srv.close();
  }
});

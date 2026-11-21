import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_SETTINGS_STORAGE_KEY,
  PROVIDERS,
  PROVIDER_ORDER,
  createDefaultAiSettings,
  loadAiSettings,
  saveAiSettings,
  clearAllApiKeys,
  isProviderReady,
  hasAnyReadyProvider,
  canGenerateAiImage,
  formatActiveProviderBadge,
  buildProviderRequest,
  buildImageRequest,
  parseImageResponse,
  parseProviderChunk,
  extractJsonObject,
  fetchProviderModels,
  streamCompletionDirect,
  completeJsonDirect,
  testProviderConnection,
  generateDishImageDirect
} from "../public/js/ai-client.js";
import { postJson, fetchDishImage, streamRecipeEndpoint } from "../public/js/api.js";

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

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

test("loadAiSettings, saveAiSettings, clearAllApiKeys, and status helpers work cleanly", () => {
  const storage = makeMemoryStorage();
  const initial = loadAiSettings(storage);
  assert.deepEqual(PROVIDER_ORDER, ["gemini", "openai", "claude", "openrouter", "meta", "ollama", "custom"]);
  assert.equal(initial.activeProvider, "gemini");
  assert.equal(initial.imageMode, "open");
  assert.equal(hasAnyReadyProvider(initial), false);
  assert.equal(formatActiveProviderBadge(initial), "Set up AI");

  const updated = structuredClone(initial);
  updated.activeProvider = "openrouter";
  updated.temperature = 0.4;
  updated.providers.openrouter.apiKey = "sk-or-secret";
  updated.providers.openrouter.model = "anthropic/claude-sonnet-4";
  saveAiSettings(updated, storage);

  const reloaded = loadAiSettings(storage);
  assert.ok(storage.getItem(AI_SETTINGS_STORAGE_KEY));
  assert.equal(reloaded.activeProvider, "openrouter");
  assert.equal(reloaded.temperature, 0.4);
  assert.equal(isProviderReady(reloaded, "openrouter"), true);
  assert.equal(hasAnyReadyProvider(reloaded), true);
  assert.equal(canGenerateAiImage(reloaded), true);
  assert.equal(formatActiveProviderBadge(reloaded), "OpenRouter · claude-sonnet-4");

  const cleared = clearAllApiKeys(reloaded, storage);
  assert.equal(cleared.providers.openrouter.apiKey, "");
  assert.equal(cleared.providers.openrouter.model, "anthropic/claude-sonnet-4");
  assert.equal(hasAnyReadyProvider(cleared), false);

  // Local Ollama requires no API key when selected as active provider
  cleared.activeProvider = "ollama";
  assert.equal(isProviderReady(cleared, "ollama"), true);
  assert.equal(hasAnyReadyProvider(cleared), true);
  assert.equal(formatActiveProviderBadge(cleared), "Ollama · llama3.2");
});

test("buildProviderRequest covers all 7 providers including browser Claude header, reasoning temperature, and custom endpoint", () => {
  const tinyImg = [{ mimeType: "image/jpeg", data: "QUJD" }];

  const gem = buildProviderRequest({
    provider: "gemini",
    apiKey: "gk",
    model: "gemini-2.5-flash",
    temperature: 0.5,
    system: "Chef",
    userText: "Pasta",
    images: tinyImg,
    stream: true
  });
  assert.equal(
    gem.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
  );
  assert.equal(gem.headers["x-goog-api-key"], "gk");
  assert.equal(gem.body.generationConfig.temperature, 0.5);
  assert.equal(gem.body.contents[0].parts[0].inlineData.data, "QUJD");

  const claude = buildProviderRequest({
    provider: "claude",
    apiKey: "ak",
    model: "claude-sonnet-4-20250514",
    temperature: 0.8,
    system: "Chef",
    userText: "Ramen",
    images: tinyImg,
    stream: true
  });
  assert.equal(claude.url, "https://api.anthropic.com/v1/messages");
  assert.equal(claude.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(claude.headers["x-api-key"], "ak");
  assert.equal(claude.body.temperature, 0.8);

  const oaiReasoning = buildProviderRequest({
    provider: "openai",
    apiKey: "ok",
    model: "o4-mini",
    temperature: 0.9,
    system: "Chef",
    userText: "Soup"
  });
  assert.equal("temperature" in oaiReasoning.body, false);

  const meta = buildProviderRequest({
    provider: "meta",
    apiKey: "mk",
    model: "muse-spark-1.3",
    baseUrl: "https://api.meta.ai/v1/",
    system: "Chef",
    userText: "Tacos"
  });
  assert.equal(meta.url, "https://api.meta.ai/v1/chat/completions");
  assert.equal(meta.body.messages[0].role, "developer");

  const openrouter = buildProviderRequest({
    provider: "openrouter",
    apiKey: "ork",
    model: "google/gemini-2.5-flash",
    system: "Chef",
    userText: "Dal"
  });
  assert.equal(openrouter.headers["X-Title"], "Mise");
  assert.ok(openrouter.headers["HTTP-Referer"]);

  const ollama = buildProviderRequest({
    provider: "ollama",
    model: "qwen2.5",
    baseUrl: "http://127.0.0.1:11434",
    temperature: 0.3,
    system: "Chef",
    userText: "Curry"
  });
  assert.equal(ollama.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(ollama.body.options.temperature, 0.3);
  assert.equal(ollama.body.format, "json");

  const customNoKey = buildProviderRequest({
    provider: "custom",
    apiKey: "",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1/",
    system: "Chef",
    userText: "Bread"
  });
  assert.equal(customNoKey.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(customNoKey.headers.Authorization, undefined);

  const customWithKey = buildProviderRequest({
    provider: "custom",
    apiKey: "gsk_123",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    system: "Chef",
    userText: "Bread"
  });
  assert.equal(customWithKey.headers.Authorization, "Bearer gsk_123");
});

test("buildImageRequest and parseImageResponse handle image providers cleanly", () => {
  const gemReq = buildImageRequest({
    provider: "gemini",
    apiKey: "gk",
    model: "gemini-2.5-flash-image",
    prompt: "Charred cabbage"
  });
  assert.deepEqual(gemReq.body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.equal(
    parseImageResponse("gemini", {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }] } }]
    }),
    "data:image/jpeg;base64,QUJD"
  );

  const customImg = buildImageRequest({
    provider: "custom",
    apiKey: "ck",
    model: "flux-1",
    baseUrl: "https://img.example/v1",
    prompt: "Pasta"
  });
  assert.equal(customImg.url, "https://img.example/v1/images/generations");
  assert.equal(
    parseImageResponse("custom", { data: [{ b64_json: "QUJD", media_type: "image/webp" }] }),
    "data:image/webp;base64,QUJD"
  );
});

test("parseProviderChunk and extractJsonObject handle streaming and fenced JSON", () => {
  assert.equal(
    parseProviderChunk("claude", 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"salt"}}').text,
    "salt"
  );
  assert.equal(
    parseProviderChunk("ollama", '{"message":{"content":"miso"},"done":true}').done,
    true
  );
  assert.deepEqual(extractJsonObject('Here is your recipe:\n```json\n{"title":"Miso Udon"}\n```'), {
    title: "Miso Udon"
  });
});

test("fetchProviderModels queries Gemini, Claude, Ollama, and OpenAI-compatible endpoints", async () => {
  const gemModels = await fetchProviderModels(
    "gemini",
    { apiKey: "gk" },
    {
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models");
        assert.equal(init.headers["x-goog-api-key"], "gk");
        return new Response(
          JSON.stringify({
            models: [
              { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
              { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }
            ]
          })
        );
      }
    }
  );
  assert.deepEqual(gemModels, ["gemini-2.5-flash"]);

  const claudeModels = await fetchProviderModels(
    "claude",
    { apiKey: "ak" },
    {
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://api.anthropic.com/v1/models");
        assert.equal(init.headers["anthropic-dangerous-direct-browser-access"], "true");
        return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-20250514" }] }));
      }
    }
  );
  assert.deepEqual(claudeModels, ["claude-sonnet-4-20250514"]);

  const ollamaModels = await fetchProviderModels(
    "ollama",
    { baseUrl: "http://127.0.0.1:11434/" },
    {
      fetchImpl: async (url) => {
        assert.equal(url, "http://127.0.0.1:11434/api/tags");
        return new Response(JSON.stringify({ models: [{ name: "llama3.2" }, { name: "qwen2.5" }] }));
      }
    }
  );
  assert.deepEqual(ollamaModels, ["llama3.2", "qwen2.5"]);
});

test("streamCompletionDirect, completeJsonDirect, and testProviderConnection stream and validate end-to-end", async () => {
  const settings = createDefaultAiSettings();
  settings.activeProvider = "custom";
  settings.providers.custom.baseUrl = "https://api.groq.com/openai/v1";
  settings.providers.custom.apiKey = "gsk_test";
  settings.providers.custom.model = "llama-3.3-70b-versatile";

  const deltas = [];
  const full = await streamCompletionDirect(
    {
      settings,
      system: "Chef",
      userText: "Soup",
      fetchImpl: async () =>
        makeSseStream([
          'data: {"choices":[{"delta":{"content":"{\\"title\\":\\""}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Miso Broth\\"}"}}]}\n\n',
          "data: [DONE]\n\n"
        ])
    },
    (d) => deltas.push(d)
  );
  assert.equal(full, '{"title":"Miso Broth"}');
  assert.deepEqual(deltas, ['{"title":"', 'Miso Broth"}']);

  const ping = await testProviderConnection(settings, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  });
  assert.equal(ping.ok, true);
  assert.equal(ping.provider, PROVIDERS.custom.label);
  assert.equal(ping.model, "llama-3.3-70b-versatile");

  const parsed = await completeJsonDirect({
    settings,
    system: "Chef",
    userText: "Test",
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Ok"}' } }] }))
  });
  assert.deepEqual(parsed, { title: "Ok" });
});

test("generateDishImageDirect defaults to open images and supports opt-in AI with graceful fallback", async () => {
  const settings = createDefaultAiSettings();
  settings.activeProvider = "openai";
  settings.providers.openai.apiKey = "sk-test";

  let aiCalls = 0;
  let openCalls = 0;
  const mockFetch = async (url) => {
    if (String(url).includes("/images/generations")) {
      aiCalls++;
      return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }));
    }
    if (String(url).startsWith("https://api.openverse.org/")) {
      openCalls++;
      return new Response(
        JSON.stringify({ results: [{ thumbnail: "https://cdn.openverse.org/soup.jpg", width: 900 }] })
      );
    }
    return new Response("{}", { status: 404 });
  };

  const openRes = await generateDishImageDirect({
    settings,
    title: "Miso Soup",
    useAi: false,
    fetchImpl: mockFetch
  });
  assert.equal(openRes.source, "openverse");
  assert.equal(openRes.isAi, false);
  assert.equal(aiCalls, 0);
  assert.equal(openCalls, 1);

  const aiRes = await generateDishImageDirect({
    settings,
    title: "Miso Soup",
    useAi: true,
    fetchImpl: mockFetch
  });
  assert.equal(aiRes.source, "openai");
  assert.equal(aiRes.isAi, true);
  assert.equal(aiRes.imageUrl, "data:image/png;base64,QUJD");
  assert.equal(aiCalls, 1);
});

test("api.js postJson, streamRecipeEndpoint, and fetchDishImage surface clean BYOK config validation and caching", async () => {
  const unconfigured = createDefaultAiSettings();
  await assert.rejects(
    () => postJson("/api/ideas", { settings: unconfigured, query: "pasta" }),
    /API key in Settings/
  );
  await assert.rejects(
    () => streamRecipeEndpoint("/api/generate", { settings: unconfigured, query: "pasta" }),
    /API key in Settings/
  );

  // Caches empty/none results cleanly without throwing
  const emptyImg = await fetchDishImage({ settings: unconfigured, title: "" });
  assert.equal(emptyImg.imageUrl, null);
  assert.equal(emptyImg.source, "none");
});

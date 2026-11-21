import test from "node:test";
import assert from "node:assert/strict";
import { getPublicProviderCatalog } from "../server/env.mjs";
import {
  validateOllamaHost,
  buildProviderRequest,
  buildImageRequest,
  parseImageResponse,
  resolveImageProvider,
  fetchWikimediaDishPhoto,
  parseProviderChunk,
  extractJsonObject,
  resolveCredentials
} from "../server/providers.mjs";

const SAMPLE_IMG = [{ mimeType: "image/jpeg", data: "data:image/jpeg;base64,QUJD" }];

test("validateOllamaHost allows loopback hosts and blocks external SSRF hosts", () => {
  assert.equal(validateOllamaHost("http://127.0.0.1:11434/", {}), "http://127.0.0.1:11434");
  assert.equal(validateOllamaHost("http://localhost:11434", {}), "http://localhost:11434");
  assert.equal(validateOllamaHost("http://[::1]:11434", {}), "http://[::1]:11434");
  assert.throws(() => validateOllamaHost("http://169.254.169.254/latest", {}), /localhost|loopback|security/i);
  assert.throws(() => validateOllamaHost("file:///etc/passwd", {}), /http/i);
});

test("resolveCredentials reads strictly from server env and ignores client overrides", () => {
  const fakeEnv = {
    OPENAI_API_KEY: "server-secret-key",
    OPENAI_MODEL: "gpt-4.1",
    DEFAULT_PROVIDER: "openai"
  };
  const creds = resolveCredentials(
    { provider: "openai", apiKey: "malicious-client-key", model: "evil-model" },
    fakeEnv
  );
  assert.equal(creds.apiKey, "server-secret-key");
  assert.equal(creds.model, "gpt-4.1");

  assert.throws(
    () => resolveCredentials({ provider: "claude" }, fakeEnv),
    /not configured on this server/i
  );
});

test("getPublicProviderCatalog never exposes keys, models, or private hosts", () => {
  const catalog = getPublicProviderCatalog({
    GEMINI_API_KEY: "AIza-super-secret",
    GEMINI_MODEL: "gemini-2.5-pro",
    OLLAMA_HOST: "http://127.0.0.1:11434"
  });
  const json = JSON.stringify(catalog);
  assert.equal(json.includes("AIza-super-secret"), false);
  assert.equal(json.includes("gemini-2.5-pro"), false);
  assert.equal(json.includes("127.0.0.1"), false);
  assert.equal(catalog.defaultProvider, "gemini");
  assert.equal(catalog.providers.find((p) => p.id === "gemini").configured, true);
  assert.equal(catalog.providers.find((p) => p.id === "openai").configured, false);
  assert.equal(catalog.providers.find((p) => p.id === "ollama").configured, true);
});

test("buildProviderRequest constructs valid multimodal requests for all 5 providers", () => {
  const gem = buildProviderRequest({
    provider: "gemini",
    apiKey: "g-key",
    model: "gemini-2.5-flash",
    system: "SYS",
    userText: "Cook",
    images: SAMPLE_IMG,
    stream: true,
    jsonMode: true
  });
  assert.match(gem.url, /streamGenerateContent\?alt=sse$/);
  assert.equal(gem.headers["x-goog-api-key"], "g-key");
  assert.equal(gem.body.contents[0].parts[0].inlineData.data, "QUJD");

  const oai = buildProviderRequest({
    provider: "openai",
    apiKey: "o-key",
    model: "o4-mini",
    system: "SYS",
    userText: "Cook",
    images: SAMPLE_IMG,
    stream: true,
    jsonMode: true
  });
  assert.equal(oai.url, "https://api.openai.com/v1/chat/completions");
  assert.equal("temperature" in oai.body, false);
  assert.equal(oai.body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,QUJD");

  const claude = buildProviderRequest({
    provider: "claude",
    apiKey: "c-key",
    model: "claude-sonnet-4-20250514",
    system: "SYS",
    userText: "Cook",
    images: SAMPLE_IMG,
    stream: true,
    jsonMode: true
  });
  assert.equal(claude.headers["x-api-key"], "c-key");
  assert.equal(claude.body.messages[0].content[0].source.data, "QUJD");

  const or = buildProviderRequest({
    provider: "openrouter",
    apiKey: "or-key",
    model: "google/gemini-2.5-flash",
    system: "SYS",
    userText: "Cook",
    images: [],
    stream: true,
    jsonMode: true
  });
  assert.equal(or.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(or.body.response_format.type, "json_object");

  const ol = buildProviderRequest({
    provider: "ollama",
    apiKey: "",
    model: "llama3.2",
    ollamaHost: "http://127.0.0.1:11434",
    system: "SYS",
    userText: "Cook",
    images: SAMPLE_IMG,
    stream: true,
    jsonMode: true
  });
  assert.equal(ol.url, "http://127.0.0.1:11434/api/chat");
  assert.deepEqual(ol.body.messages[1].images, ["QUJD"]);
  assert.equal(ol.body.format, "json");
});

test("resolveImageProvider, buildImageRequest, and parseImageResponse handle Gemini, OpenAI, and OpenRouter", () => {
  const defaultOpen = resolveImageProvider("claude", { GEMINI_API_KEY: "gk", ANTHROPIC_API_KEY: "ck" });
  assert.notEqual(defaultOpen.provider, "gemini");

  const autoGem = resolveImageProvider(
    "claude",
    { GEMINI_API_KEY: "gk", ANTHROPIC_API_KEY: "ck" },
    { useAi: true }
  );
  assert.equal(autoGem.provider, "gemini");
  assert.equal(autoGem.model, "gemini-2.5-flash-image");

  const autoOpen = resolveImageProvider("claude", { ANTHROPIC_API_KEY: "ck" }, { useAi: true });
  assert.equal(autoOpen.provider, "open");

  assert.equal(
    resolveImageProvider("gemini", { IMAGE_PROVIDER: "off", GEMINI_API_KEY: "gk" }, { useAi: true }),
    null
  );

  const gemImgReq = buildImageRequest({
    provider: "gemini",
    apiKey: "gk",
    model: "gemini-2.5-flash-image",
    prompt: "Rigatoni"
  });
  assert.deepEqual(gemImgReq.body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.equal(
    parseImageResponse("gemini", {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }] } }]
    }),
    "data:image/jpeg;base64,QUJD"
  );

  const oaiImgReq = buildImageRequest({
    provider: "openai",
    apiKey: "ok",
    model: "gpt-image-1",
    prompt: "Rigatoni"
  });
  assert.equal(oaiImgReq.url, "https://api.openai.com/v1/images/generations");
  assert.equal(
    parseImageResponse("openai", { data: [{ b64_json: "QUJD" }] }),
    "data:image/png;base64,QUJD"
  );

  const orImgReq = buildImageRequest({
    provider: "openrouter",
    apiKey: "ork",
    model: "bytedance-seed/seedream-4.5",
    prompt: "Rigatoni"
  });
  assert.equal(orImgReq.url, "https://openrouter.ai/api/v1/images");
  assert.equal(
    parseImageResponse("openrouter", { data: [{ b64_json: "QUJD", media_type: "image/webp" }] }),
    "data:image/webp;base64,QUJD"
  );
});

test("fetchWikimediaDishPhoto parses safe Wikimedia thumbnail URLs", async () => {
  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: {
            1: { index: 0, thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/pasta.jpg" } }
          }
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const url = await fetchWikimediaDishPhoto("Rigatoni", mockFetch);
  assert.equal(url, "https://upload.wikimedia.org/wikipedia/commons/pasta.jpg");
});

test("parseProviderChunk parses SSE and NDJSON frames across providers", () => {
  assert.equal(
    parseProviderChunk("gemini", 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}').text,
    "Hello"
  );
  assert.equal(
    parseProviderChunk("openai", 'data: {"choices":[{"delta":{"content":"World"}}]}').text,
    "World"
  );
  assert.equal(
    parseProviderChunk("claude", 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Chef"}}').text,
    "Chef"
  );
  assert.equal(parseProviderChunk("openrouter", "data: [DONE]").done, true);
  assert.deepEqual(
    parseProviderChunk("ollama", '{"message":{"content":"Soup"},"done":false}'),
    { text: "Soup", done: false }
  );
});

test("extractJsonObject extracts JSON cleanly from fenced or prose-wrapped output", () => {
  const parsed = extractJsonObject('Sure!\n```json\n{"title":"Miso Soup","ok":true}\n```');
  assert.deepEqual(parsed, { title: "Miso Soup", ok: true });

  const balanced = extractJsonObject('Note {"a":{"b":"}"},"title":"Test"} trailing');
  assert.deepEqual(balanced, { a: { b: "}" }, title: "Test" });
});

test("Meta Model API supports META_API_KEY / MODEL_API_KEY, developer role, vision, streaming, and muse-image-1.0", () => {
  const catalog = getPublicProviderCatalog({
    MODEL_API_KEY: "LLM_meta_secret",
    META_MODEL: "muse-wonder-1.0"
  });
  assert.equal(catalog.defaultProvider, "meta");
  const metaPub = catalog.providers.find((p) => p.id === "meta");
  assert.equal(metaPub.configured, true);
  assert.equal(metaPub.supportsImages, true);
  assert.equal(JSON.stringify(catalog).includes("LLM_meta_secret"), false);
  assert.equal(JSON.stringify(catalog).includes("muse-wonder-1.0"), false);

  const creds = resolveCredentials(
    { provider: "meta" },
    { MODEL_API_KEY: "LLM_meta_secret", META_MODEL: "muse-wonder-1.0" }
  );
  assert.equal(creds.apiKey, "LLM_meta_secret");
  assert.equal(creds.model, "muse-wonder-1.0");
  assert.equal(creds.baseUrl, "https://api.meta.ai/v1");

  const req = buildProviderRequest({
    ...creds,
    system: "SYS",
    userText: "Cook",
    images: SAMPLE_IMG,
    stream: true,
    jsonMode: true
  });
  assert.equal(req.url, "https://api.meta.ai/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer LLM_meta_secret");
  assert.equal(req.body.messages[0].role, "developer");
  assert.equal(req.body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,QUJD");
  assert.equal(req.body.response_format.type, "json_object");

  assert.equal(
    parseProviderChunk("meta", 'data: {"choices":[{"delta":{"content":"Miso"}}]}').text,
    "Miso"
  );
  assert.equal(parseProviderChunk("meta", "data: [DONE]").done, true);

  const imgDefault = resolveImageProvider("meta", { MODEL_API_KEY: "LLM_meta_secret" });
  assert.equal(imgDefault.provider, "open");

  const imgTarget = resolveImageProvider("meta", { MODEL_API_KEY: "LLM_meta_secret" }, { useAi: true });
  assert.equal(imgTarget.provider, "meta");
  assert.equal(imgTarget.model, "muse-image-1.0");

  const imgReq = buildImageRequest({
    ...imgTarget,
    prompt: "Charred cabbage"
  });
  assert.equal(imgReq.url, "https://api.meta.ai/v1/images/generations");
  assert.equal(imgReq.body.model, "muse-image-1.0");
  assert.equal(imgReq.body.size, "1792x1024");
  assert.equal(imgReq.body.response_format, "b64_json");
  assert.equal(
    parseImageResponse("meta", { data: [{ b64_json: "QUJD" }] }),
    "data:image/png;base64,QUJD"
  );
});

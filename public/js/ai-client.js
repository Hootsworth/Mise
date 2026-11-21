import { buildDishImagePrompt } from "./prompts.js";
import { fetchOpenDishPhoto } from "./open-images.js";

export const AI_SETTINGS_STORAGE_KEY = "mise:byok:v1";

export const PROVIDER_ORDER = ["gemini", "openai", "claude", "openrouter", "meta", "ollama", "custom"];

export const PROVIDERS = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    shortLabel: "Gemini",
    defaultModel: "gemini-2.5-flash",
    presets: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
    supportsImages: true,
    defaultImageModel: "gemini-2.5-flash-image",
    imageModels: ["gemini-2.5-flash-image", "gemini-2.0-flash-preview-image-generation"],
    keyRequired: true,
    keyPlaceholder: "AIza...",
    editableBaseUrl: false,
    helpText: "Direct call to Google Gemini API. Key stays in your browser."
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    shortLabel: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    presets: ["gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "o4-mini"],
    supportsImages: true,
    defaultImageModel: "gpt-image-1",
    imageModels: ["gpt-image-1", "dall-e-3"],
    keyRequired: true,
    keyPlaceholder: "sk-...",
    editableBaseUrl: false,
    helpText: "Uses OpenAI chat completions. Note: direct browser CORS depends on browser/extension environment; OpenRouter & Claude natively support browser CORS."
  },
  claude: {
    id: "claude",
    label: "Anthropic Claude",
    shortLabel: "Claude",
    defaultModel: "claude-sonnet-4-20250514",
    presets: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-haiku-20241022"
    ],
    supportsImages: false,
    defaultImageModel: "",
    imageModels: [],
    keyRequired: true,
    keyPlaceholder: "sk-ant-...",
    editableBaseUrl: false,
    helpText: "Sends `anthropic-dangerous-direct-browser-access: true` for direct browser BYOK requests."
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    shortLabel: "OpenRouter",
    defaultModel: "google/gemini-2.5-flash",
    presets: [
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1-mini",
      "meta-llama/llama-4-maverick",
      "deepseek/deepseek-chat-v3-0324"
    ],
    supportsImages: true,
    defaultImageModel: "bytedance-seed/seedream-4.5",
    imageModels: ["bytedance-seed/seedream-4.5", "openai/gpt-image-1"],
    keyRequired: true,
    keyPlaceholder: "sk-or-...",
    editableBaseUrl: false,
    helpText: "Recommended for static browser BYOK: full browser CORS support across Gemini, Claude, OpenAI, Llama, and DeepSeek models."
  },
  meta: {
    id: "meta",
    label: "Meta AI",
    shortLabel: "Meta AI",
    defaultModel: "muse-spark-1.3",
    defaultBaseUrl: "https://api.meta.ai/v1",
    editableBaseUrl: true,
    presets: [
      "muse-spark-1.3",
      "Llama-4-Maverick-17B-128E-Instruct-FP8",
      "Llama-4-Scout-17B-16E-Instruct-FP8"
    ],
    supportsImages: true,
    defaultImageModel: "muse-image-1.0",
    imageModels: ["muse-image-1.0"],
    keyRequired: true,
    keyPlaceholder: "LLM|...",
    helpText: "Connects to Meta Model API (`https://api.meta.ai/v1`) or an OpenAI-compatible Meta base URL."
  },
  ollama: {
    id: "ollama",
    label: "Local Ollama",
    shortLabel: "Ollama",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://127.0.0.1:11434",
    editableBaseUrl: true,
    presets: ["llama3.2", "qwen2.5", "gemma3", "mistral"],
    supportsImages: false,
    defaultImageModel: "",
    imageModels: [],
    keyRequired: false,
    keyPlaceholder: "",
    helpText: "Runs 100% locally with no API key. If calling from a hosted Vercel domain, start Ollama with `OLLAMA_ORIGINS=\"*\"`."
  },
  custom: {
    id: "custom",
    label: "Custom API",
    shortLabel: "Custom",
    defaultModel: "",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    editableBaseUrl: true,
    presets: ["llama-3.3-70b-versatile", "deepseek-chat", "mistral-large-latest"],
    supportsImages: true,
    defaultImageModel: "",
    imageModels: [],
    keyRequired: false,
    keyPlaceholder: "Optional Bearer token",
    helpText: "Any OpenAI-compatible `/v1` API (Groq, Together, Fireworks, LM Studio, vLLM, or self-hosted gateway)."
  }
};

function makeHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function getDefaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function createDefaultAiSettings() {
  const providers = {};
  for (const id of PROVIDER_ORDER) {
    const meta = PROVIDERS[id];
    providers[id] = {
      apiKey: "",
      model: meta.defaultModel || "",
      baseUrl: meta.defaultBaseUrl || "",
      imageModel: meta.defaultImageModel || ""
    };
  }
  return {
    activeProvider: "gemini",
    temperature: 0.7,
    imageMode: "open",
    imageProvider: "auto",
    providers
  };
}

function sanitizeSettings(raw) {
  const defaults = createDefaultAiSettings();
  if (!raw || typeof raw !== "object") return defaults;

  const activeProvider = PROVIDER_ORDER.includes(raw.activeProvider) ? raw.activeProvider : defaults.activeProvider;
  const tempNum = Number(raw.temperature);
  const temperature = Number.isFinite(tempNum) ? Math.min(1.2, Math.max(0, Math.round(tempNum * 10) / 10)) : 0.7;
  const imageMode = raw.imageMode === "ai" ? "ai" : "open";
  const rawImgProv = String(raw.imageProvider || "auto");
  const imageProvider =
    rawImgProv === "auto" || (PROVIDERS[rawImgProv] && PROVIDERS[rawImgProv].supportsImages) ? rawImgProv : "auto";

  const providers = {};
  for (const id of PROVIDER_ORDER) {
    const def = defaults.providers[id];
    const src = raw.providers?.[id] && typeof raw.providers[id] === "object" ? raw.providers[id] : {};
    providers[id] = {
      apiKey: typeof src.apiKey === "string" ? src.apiKey.trim() : "",
      model: typeof src.model === "string" ? src.model.trim() : def.model,
      baseUrl:
        typeof src.baseUrl === "string" && src.baseUrl.trim()
          ? src.baseUrl.trim().replace(/\/+$/, "")
          : def.baseUrl,
      imageModel: typeof src.imageModel === "string" ? src.imageModel.trim() : def.imageModel
    };
  }

  return { activeProvider, temperature, imageMode, imageProvider, providers };
}

export function loadAiSettings(storage = getDefaultStorage()) {
  if (!storage) return createDefaultAiSettings();
  try {
    const raw = storage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return createDefaultAiSettings();
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return createDefaultAiSettings();
  }
}

export function saveAiSettings(settings, storage = getDefaultStorage()) {
  const clean = sanitizeSettings(settings);
  if (storage) {
    try {
      storage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Storage quota exceeded or unavailable
    }
  }
  return clean;
}

export function clearAllApiKeys(settings, storage = getDefaultStorage()) {
  const current = sanitizeSettings(settings);
  for (const id of PROVIDER_ORDER) {
    current.providers[id].apiKey = "";
  }
  return saveAiSettings(current, storage);
}

export function getProviderConfig(settings, providerId) {
  const clean = sanitizeSettings(settings);
  const id = PROVIDER_ORDER.includes(providerId) ? providerId : clean.activeProvider;
  const meta = PROVIDERS[id];
  const entry = clean.providers[id] || {};
  return {
    ...meta,
    id,
    apiKey: String(entry.apiKey || "").trim(),
    model: String(entry.model ?? meta.defaultModel ?? "").trim(),
    baseUrl: String(entry.baseUrl || meta.defaultBaseUrl || "").trim().replace(/\/+$/, ""),
    imageModel: String(entry.imageModel ?? meta.defaultImageModel ?? "").trim()
  };
}

export function isProviderReady(settings, providerId) {
  const cfg = getProviderConfig(settings, providerId);
  if (!cfg.model) return false;
  if (cfg.keyRequired && !cfg.apiKey) return false;
  if (cfg.editableBaseUrl && !cfg.baseUrl) return false;
  return true;
}

export function hasAnyReadyProvider(settings) {
  const clean = sanitizeSettings(settings);
  if (PROVIDER_ORDER.some((id) => PROVIDERS[id].keyRequired && isProviderReady(clean, id))) {
    return true;
  }
  if ((clean.activeProvider === "ollama" || clean.activeProvider === "custom") && isProviderReady(clean, clean.activeProvider)) {
    return true;
  }
  const customCfg = getProviderConfig(clean, "custom");
  return Boolean(customCfg.apiKey && isProviderReady(clean, "custom"));
}

function getEffectiveImageTarget(settings) {
  const clean = sanitizeSettings(settings);
  const preferred = clean.imageProvider && clean.imageProvider !== "auto" ? clean.imageProvider : clean.activeProvider;
  const order = [];
  if (PROVIDERS[preferred]?.supportsImages) order.push(preferred);
  for (const id of ["gemini", "openai", "openrouter", "meta"]) {
    if (!order.includes(id)) order.push(id);
  }
  for (const id of order) {
    const cfg = getProviderConfig(clean, id);
    if (!cfg.supportsImages || !cfg.imageModel) continue;
    if (cfg.keyRequired && !cfg.apiKey) continue;
    if (cfg.editableBaseUrl && !cfg.baseUrl) continue;
    return cfg;
  }
  return null;
}

export function canGenerateAiImage(settings) {
  return Boolean(getEffectiveImageTarget(settings));
}

export function formatActiveProviderBadge(settings) {
  const clean = sanitizeSettings(settings);
  const cfg = getProviderConfig(clean, clean.activeProvider);
  if (!isProviderReady(clean, cfg.id)) {
    return "Set up AI";
  }
  const shortModel = cfg.model.includes("/") ? cfg.model.split("/").pop() : cfg.model;
  const trimmedModel = shortModel.length > 24 ? `${shortModel.slice(0, 22)}…` : shortModel;
  return trimmedModel ? `${cfg.shortLabel} · ${trimmedModel}` : cfg.shortLabel;
}

export function normalizeImages(images = []) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const item of images.slice(0, 4)) {
    if (!item) continue;
    if (typeof item === "string" && item.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(item);
      if (m) {
        out.push({ mimeType: m[1], base64: m[2], dataUrl: item });
      }
      continue;
    }
    if (typeof item === "object" && typeof item.data === "string") {
      const mimeType = String(item.mimeType || "image/jpeg");
      const raw = item.data.startsWith("data:")
        ? item.data.replace(/^data:[^;]+;base64,/, "")
        : item.data;
      out.push({
        mimeType,
        base64: raw,
        dataUrl: `data:${mimeType};base64,${raw}`
      });
    }
  }
  return out;
}

function getHttpReferer() {
  try {
    return typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost";
  } catch {
    return "http://localhost";
  }
}

/**
 * Builds direct client-side HTTP request descriptor `{ url, headers, body }` for all 7 providers.
 */
export function buildProviderRequest({
  provider,
  apiKey = "",
  model,
  baseUrl = "",
  temperature = 0.7,
  system,
  userText,
  images = [],
  stream = true,
  jsonMode = true
}) {
  const imgs = normalizeImages(images);
  const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7;

  if (provider === "gemini") {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}`;
    const parts = [];
    for (const img of imgs) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
    parts.push({ text: userText });

    const generationConfig = { temperature: temp };
    if (jsonMode) generationConfig.responseMimeType = "application/json";

    return {
      url,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig
      }
    };
  }

  if (provider === "claude") {
    const userContent = imgs.length
      ? [
          ...imgs.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mimeType, data: img.base64 }
          })),
          { type: "text", text: userText }
        ]
      : userText;

    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: {
        model,
        max_tokens: 4096,
        temperature: temp,
        system,
        stream: Boolean(stream),
        messages: [{ role: "user", content: userContent }]
      }
    };
  }

  if (provider === "openai") {
    const isReasoning = /^o\d/i.test(model);
    const userContent = imgs.length
      ? [
          { type: "text", text: userText },
          ...imgs.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }))
        ]
      : userText;

    const body = {
      model,
      stream: Boolean(stream),
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent }
      ]
    };
    if (!isReasoning) body.temperature = temp;
    if (jsonMode) body.response_format = { type: "json_object" };

    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body
    };
  }

  if (provider === "openrouter") {
    const userContent = imgs.length
      ? [
          { type: "text", text: userText },
          ...imgs.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }))
        ]
      : userText;

    const body = {
      model,
      stream: Boolean(stream),
      temperature: temp,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent }
      ]
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": getHttpReferer(),
        "X-Title": "Mise"
      },
      body
    };
  }

  if (provider === "meta") {
    const endpoint = `${(baseUrl || PROVIDERS.meta.defaultBaseUrl).replace(/\/+$/, "")}/chat/completions`;
    const userContent = imgs.length
      ? [
          { type: "text", text: userText },
          ...imgs.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }))
        ]
      : userText;

    const body = {
      model,
      stream: Boolean(stream),
      temperature: temp,
      messages: [
        { role: "developer", content: system },
        { role: "user", content: userContent }
      ]
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    return {
      url: endpoint,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body
    };
  }

  if (provider === "ollama") {
    const host = (baseUrl || PROVIDERS.ollama.defaultBaseUrl).replace(/\/+$/, "");
    const userMsg = { role: "user", content: userText };
    if (imgs.length) userMsg.images = imgs.map((img) => img.base64);

    const body = {
      model,
      stream: Boolean(stream),
      options: { temperature: temp },
      messages: [
        { role: "system", content: system },
        userMsg
      ]
    };
    if (jsonMode) body.format = "json";

    return {
      url: `${host}/api/chat`,
      headers: { "Content-Type": "application/json" },
      body
    };
  }

  if (provider === "custom") {
    const endpoint = `${(baseUrl || PROVIDERS.custom.defaultBaseUrl).replace(/\/+$/, "")}/chat/completions`;
    const userContent = imgs.length
      ? [
          { type: "text", text: userText },
          ...imgs.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }))
        ]
      : userText;

    const body = {
      model,
      stream: Boolean(stream),
      temperature: temp,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent }
      ]
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    return { url: endpoint, headers, body };
  }

  throw makeHttpError(400, `Unsupported provider: ${provider}`);
}

/**
 * Builds direct client-side image generation requests (`gemini`, `openai`, `openrouter`, `meta`, `custom`).
 */
export function buildImageRequest({ provider, apiKey = "", model, baseUrl = "", prompt }) {
  if (provider === "gemini") {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      }
    };
  }

  if (provider === "meta") {
    const root = (baseUrl || PROVIDERS.meta.defaultBaseUrl).replace(/\/+$/, "");
    return {
      url: `${root}/images/generations`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: {
        model,
        prompt,
        n: 1,
        size: "1792x1024",
        response_format: "b64_json"
      }
    };
  }

  if (provider === "openai") {
    const body = { model, prompt, size: "1024x1024" };
    if (/^dall-e/i.test(model)) body.response_format = "b64_json";
    return {
      url: "https://api.openai.com/v1/images/generations",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body
    };
  }

  if (provider === "openrouter") {
    return {
      url: "https://openrouter.ai/api/v1/images",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": getHttpReferer(),
        "X-Title": "Mise"
      },
      body: {
        model,
        prompt,
        aspect_ratio: "16:9",
        response_format: "b64_json"
      }
    };
  }

  if (provider === "custom") {
    const root = (baseUrl || PROVIDERS.custom.defaultBaseUrl).replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return {
      url: `${root}/images/generations`,
      headers,
      body: {
        model,
        prompt,
        n: 1,
        response_format: "b64_json"
      }
    };
  }

  throw makeHttpError(400, `Image generation is not supported for ${provider}.`);
}

export function parseImageResponse(provider, data) {
  if (!data || typeof data !== "object") return null;

  if (provider === "gemini") {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      const inline = part?.inlineData;
      if (inline?.data) {
        const mime = inline.mimeType || "image/png";
        return `data:${mime};base64,${inline.data}`;
      }
    }
    return null;
  }

  if (provider === "openai" || provider === "openrouter" || provider === "meta" || provider === "custom") {
    const entry = data?.data?.[0];
    if (!entry) return null;
    if (entry.b64_json) {
      const mime = entry.media_type || "image/png";
      return `data:${mime};base64,${entry.b64_json}`;
    }
    if (entry.url && /^https?:\/\//i.test(entry.url)) {
      return entry.url;
    }
  }

  return null;
}

export function parseProviderChunk(provider, rawLine) {
  const line = String(rawLine || "").trim();
  if (!line || line.startsWith(":") || line.startsWith("event:")) {
    return { text: "", done: false };
  }

  let payloadStr = line;
  if (line.startsWith("data:")) {
    payloadStr = line.slice(5).trim();
  }
  if (!payloadStr || payloadStr === "[DONE]") {
    return { text: "", done: payloadStr === "[DONE]" };
  }

  let data;
  try {
    data = JSON.parse(payloadStr);
  } catch {
    return { text: "", done: false };
  }

  if (data?.error) {
    const msg =
      typeof data.error === "string"
        ? data.error
        : data.error.message || JSON.stringify(data.error);
    throw makeHttpError(502, msg);
  }

  if (provider === "gemini") {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p?.text || "").join("");
    return { text, done: false };
  }

  if (provider === "openai" || provider === "openrouter" || provider === "meta" || provider === "custom") {
    const delta = data?.choices?.[0]?.delta?.content;
    const msg = data?.choices?.[0]?.message?.content;
    return { text: delta ?? msg ?? "", done: false };
  }

  if (provider === "claude") {
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      return { text: data.delta.text || "", done: false };
    }
    if (data.type === "message_stop") {
      return { text: "", done: true };
    }
    if (Array.isArray(data.content)) {
      const text = data.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return { text, done: true };
    }
    return { text: "", done: false };
  }

  if (provider === "ollama") {
    const text = data?.message?.content ?? data?.response ?? "";
    return { text, done: Boolean(data?.done) };
  }

  return { text: "", done: false };
}

export function extractJsonObject(rawText) {
  let s = String(rawText || "").trim();
  if (!s) {
    throw makeHttpError(502, "The AI returned an empty response. Try again.");
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) {
    s = fenced[1].trim();
  }

  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to balanced-brace extraction
  }

  const start = s.indexOf("{");
  if (start === -1) {
    throw makeHttpError(502, "The AI response was not valid JSON. Try again.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (err) {
          throw makeHttpError(502, `Could not parse recipe JSON: ${err.message}`);
        }
      }
    }
  }

  throw makeHttpError(502, "The AI response was cut off before finishing. Try again.");
}

async function formatUpstreamError(cfg, res) {
  let detail = "";
  try {
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || parsed?.error || parsed?.message || raw;
    } catch {
      detail = raw;
    }
  } catch {
    detail = "";
  }
  const cleanDetail = String(detail || "").trim().slice(0, 280);

  if (res.status === 401 || res.status === 403) {
    return makeHttpError(
      res.status,
      `Authentication failed for ${cfg.label}. Check your API key in Settings.`
    );
  }
  if (res.status === 429) {
    return makeHttpError(429, `Rate limit reached on ${cfg.label}. Wait a moment or switch providers in Settings.`);
  }
  if (res.status === 404 && cfg.id === "ollama") {
    return makeHttpError(404, `Ollama model "${cfg.model}" not found on ${cfg.baseUrl}.`);
  }
  return makeHttpError(res.status >= 400 ? res.status : 502, cleanDetail || `${cfg.label} error (${res.status}).`);
}

function mapNetworkError(cfg, err) {
  if (err?.name === "AbortError") return err;
  if (cfg.id === "ollama") {
    return makeHttpError(
      503,
      `Could not reach Ollama at ${cfg.baseUrl}. Make sure it is running (and set OLLAMA_ORIGINS="*" if calling from another origin).`
    );
  }
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err?.message || "")) {
    return makeHttpError(
      502,
      `Direct browser request to ${cfg.label} was blocked by network or browser CORS policy. Open Settings to switch to OpenRouter, Claude, or Local Ollama (or check your Custom endpoint CORS settings).`
    );
  }
  if (err?.status) return err;
  return makeHttpError(502, err?.message || `Failed to reach ${cfg.label}.`);
}

function resolveReadyConfig(settings, providerId) {
  const clean = sanitizeSettings(settings);
  const cfg = getProviderConfig(clean, providerId || clean.activeProvider);
  if (cfg.keyRequired && !cfg.apiKey) {
    throw makeHttpError(400, `Add your ${cfg.label} API key in Settings first.`);
  }
  if (!cfg.model) {
    throw makeHttpError(400, `Choose or enter a model for ${cfg.label} in Settings.`);
  }
  if (cfg.editableBaseUrl && !cfg.baseUrl) {
    throw makeHttpError(400, `Enter a valid Base URL for ${cfg.label} in Settings.`);
  }
  return { cfg, temperature: clean.temperature };
}

async function executeDirectFetch(opts, stream, signal) {
  const { cfg, temperature } = resolveReadyConfig(opts.settings, opts.providerId);
  const fetchImpl = opts.fetchImpl || fetch;
  const jsonMode = opts.jsonMode !== false;

  const attempt = (useJsonMode) => {
    const reqDesc = buildProviderRequest({
      provider: cfg.id,
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      temperature,
      system: opts.system,
      userText: opts.userText,
      images: opts.images,
      stream,
      jsonMode: useJsonMode
    });
    return fetchImpl(reqDesc.url, {
      method: "POST",
      headers: reqDesc.headers,
      body: JSON.stringify(reqDesc.body),
      signal
    });
  };

  let res;
  try {
    res = await attempt(jsonMode);
  } catch (err) {
    throw mapNetworkError(cfg, err);
  }

  if (
    !res.ok &&
    res.status === 400 &&
    (cfg.id === "openrouter" || cfg.id === "meta" || cfg.id === "custom") &&
    jsonMode
  ) {
    const preview = await res.text().catch(() => "");
    if (/response_format|json_object|structured/i.test(preview)) {
      try {
        res = await attempt(false);
      } catch (err) {
        throw mapNetworkError(cfg, err);
      }
    } else {
      throw makeHttpError(400, preview.slice(0, 280) || `${cfg.label} rejected the request.`);
    }
  }

  if (!res.ok) {
    throw await formatUpstreamError(cfg, res);
  }

  return { res, cfg };
}

function extractNonStreamText(provider, json) {
  if (!json || typeof json !== "object") return "";
  if (provider === "gemini") {
    return (json?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("");
  }
  if (provider === "claude") {
    return (json?.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  }
  if (provider === "ollama") {
    return json?.message?.content ?? json?.response ?? "";
  }
  return json?.choices?.[0]?.message?.content ?? "";
}

/**
 * Streams a completion directly from the browser to the selected provider and returns full text.
 */
export async function streamCompletionDirect(opts, onDelta, signal) {
  const { res, cfg } = await executeDirectFetch(opts, true, signal);
  const contentType = String(res.headers?.get?.("content-type") || "").toLowerCase();

  if (contentType.includes("application/json") || !res.body) {
    const json = await res.json();
    const text = extractNonStreamText(cfg.id, json);
    if (text && onDelta) onDelta(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  const processLine = (line) => {
    const { text } = parseProviderChunk(cfg.id, line);
    if (text) {
      fullText += text;
      if (onDelta) onDelta(text);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      processLine(line);
    }
  }
  if (buffer.trim()) {
    processLine(buffer);
  }

  return fullText;
}

/**
 * Executes a non-streaming completion directly against the provider and extracts one JSON object.
 */
export async function completeJsonDirect(opts, signal) {
  const { res, cfg } = await executeDirectFetch(opts, false, signal);
  const json = await res.json();
  const rawText = extractNonStreamText(cfg.id, json);
  return extractJsonObject(rawText);
}

/**
 * Fetches live available models for a configured provider.
 */
export async function fetchProviderModels(providerId, config = {}, { fetchImpl = fetch, signal } = {}) {
  const meta = PROVIDERS[providerId];
  if (!meta) throw makeHttpError(400, `Unsupported provider: ${providerId}`);

  const apiKey = String(config.apiKey || "").trim();
  const baseUrl = String(config.baseUrl || meta.defaultBaseUrl || "").trim().replace(/\/+$/, "");

  if (meta.keyRequired && !apiKey) {
    throw makeHttpError(400, `Enter a ${meta.label} API key before fetching models.`);
  }
  if (meta.editableBaseUrl && !baseUrl) {
    throw makeHttpError(400, `Enter a Base URL for ${meta.label} first.`);
  }

  let url = "";
  let headers = {};

  if (providerId === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models";
    headers = { "x-goog-api-key": apiKey };
  } else if (providerId === "claude") {
    url = "https://api.anthropic.com/v1/models";
    headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
  } else if (providerId === "ollama") {
    url = `${baseUrl}/api/tags`;
  } else if (providerId === "openai") {
    url = "https://api.openai.com/v1/models";
    headers = { Authorization: `Bearer ${apiKey}` };
  } else if (providerId === "openrouter") {
    url = "https://openrouter.ai/api/v1/models";
    headers = {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": getHttpReferer(),
      "X-Title": "Mise"
    };
  } else {
    url = `${baseUrl}/models`;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  }

  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal });
  } catch (err) {
    throw mapNetworkError({ id: providerId, label: meta.label, baseUrl }, err);
  }

  if (!res.ok) {
    throw await formatUpstreamError({ id: providerId, label: meta.label, baseUrl, model: config.model || "" }, res);
  }

  const json = await res.json();
  let ids = [];
  if (providerId === "gemini") {
    ids = (json?.models || [])
      .filter(
        (m) =>
          !Array.isArray(m.supportedGenerationMethods) ||
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  } else if (providerId === "ollama") {
    ids = (json?.models || []).map((m) => String(m.name || m.model || "")).filter(Boolean);
  } else {
    ids = (json?.data || []).map((m) => String(m.id || "")).filter(Boolean);
  }

  return Array.from(new Set(ids));
}

/**
 * Tests the currently configured provider end-to-end and reports latency in ms.
 */
export async function testProviderConnection(settings, { providerId, fetchImpl = fetch, signal } = {}) {
  const { cfg } = resolveReadyConfig(settings, providerId);
  const startedAt = Date.now();
  await completeJsonDirect(
    {
      settings,
      providerId: cfg.id,
      system: 'Reply with ONLY the JSON object {"ok":true}.',
      userText: "Connection check",
      jsonMode: true,
      fetchImpl
    },
    signal
  );
  return {
    ok: true,
    latencyMs: Math.max(1, Date.now() - startedAt),
    provider: cfg.label,
    model: cfg.model
  };
}

/**
 * Fetches an open web dish photo by default, or calls AI image generation when `useAi` is true,
 * always falling back gracefully to open photos if AI generation fails or is unavailable.
 */
export async function generateDishImageDirect({
  settings,
  title,
  tagline = "",
  cuisine = "",
  visualPrompt = "",
  useAi = false,
  excludeUrls = [],
  fetchImpl = fetch,
  signal
}) {
  if (useAi) {
    const target = getEffectiveImageTarget(settings);
    if (target) {
      try {
        const prompt = buildDishImagePrompt({ title, tagline, cuisine, visualPrompt });
        const desc = buildImageRequest({
          provider: target.id,
          apiKey: target.apiKey,
          model: target.imageModel,
          baseUrl: target.baseUrl,
          prompt
        });
        const res = await fetchImpl(desc.url, {
          method: "POST",
          headers: desc.headers,
          body: JSON.stringify(desc.body),
          signal
        });
        if (res.ok) {
          const json = await res.json();
          const imageUrl = parseImageResponse(target.id, json);
          if (imageUrl) {
            return {
              imageUrl,
              source: target.id,
              credit: `AI · ${target.label}`,
              creditUrl: "",
              isAi: true
            };
          }
        }
      } catch {
        // Fall through cleanly to open image waterfall
      }
    }
  }

  const open = await fetchOpenDishPhoto({ title, cuisine, excludeUrls, fetchImpl, signal });
  if (open?.imageUrl) {
    return { ...open, isAi: false };
  }

  return { imageUrl: null, source: "none", credit: "", creditUrl: "", isAi: false };
}

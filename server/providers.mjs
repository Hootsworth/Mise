import { getPublicProviderCatalog } from "./env.mjs";
import { buildDishImagePrompt } from "./prompts.mjs";

export const PROVIDER_DEFAULTS = {
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    imageModel: "gemini-2.5-flash-image",
    envKey: "GEMINI_API_KEY",
    envModel: "GEMINI_MODEL",
    envImageModel: "GEMINI_IMAGE_MODEL"
  },
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    imageModel: "gpt-image-1",
    envKey: "OPENAI_API_KEY",
    envModel: "OPENAI_MODEL",
    envImageModel: "OPENAI_IMAGE_MODEL"
  },
  claude: {
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-4-20250514",
    imageModel: "",
    envKey: "ANTHROPIC_API_KEY",
    envModel: "ANTHROPIC_MODEL",
    envImageModel: ""
  },
  openrouter: {
    label: "OpenRouter",
    defaultModel: "google/gemini-2.5-flash",
    imageModel: "bytedance-seed/seedream-4.5",
    envKey: "OPENROUTER_API_KEY",
    envModel: "OPENROUTER_MODEL",
    envImageModel: "OPENROUTER_IMAGE_MODEL"
  },
  ollama: {
    label: "Local Ollama",
    defaultModel: "llama3.2",
    imageModel: "",
    envKey: "OLLAMA_HOST",
    envModel: "OLLAMA_MODEL",
    envImageModel: ""
  }
};

function makeHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Validates that an Ollama host URL is strictly loopback (localhost, 127.0.0.1, ::1)
 * or matches an explicit server-configured OLLAMA_HOST to prevent SSRF.
 */
export function validateOllamaHost(rawHost, env = process.env) {
  const candidate = String(rawHost || env.OLLAMA_HOST || "http://127.0.0.1:11434").trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw makeHttpError(400, "Invalid Ollama host URL. Expected something like http://127.0.0.1:11434.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw makeHttpError(400, "Ollama host must use http:// or https://.");
  }
  const envHost = env.OLLAMA_HOST ? env.OLLAMA_HOST.trim().replace(/\/+$/, "") : "";
  const normalized = `${parsed.protocol}//${parsed.host}`;
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!isLoopback && (!envHost || normalized !== envHost)) {
    throw makeHttpError(400, "For security, Ollama host must point to localhost / 127.0.0.1 / ::1 (or match OLLAMA_HOST in .env).");
  }
  return normalized;
}

/**
 * Resolves provider credentials strictly from server environment variables / GitHub Secrets.
 * Any client-supplied key, model, or host is ignored.
 */
export function resolveCredentials({ provider } = {}, env = process.env) {
  const catalog = getPublicProviderCatalog(env);
  const key = String(provider || catalog.defaultProvider || "gemini").toLowerCase().trim();
  const meta = PROVIDER_DEFAULTS[key];
  if (!meta) {
    throw makeHttpError(400, `Unsupported provider "${provider}". Choose gemini, openai, claude, openrouter, or ollama.`);
  }

  const chosenModel = String(env[meta.envModel] || "").trim() || meta.defaultModel;

  if (key === "ollama") {
    const isEnabled = Boolean(env.OLLAMA_HOST?.trim() || env.OLLAMA_MODEL?.trim());
    if (!isEnabled) {
      throw makeHttpError(400, `${meta.label} is not configured on this server. Add OLLAMA_HOST / OLLAMA_MODEL in .env or pick another provider.`);
    }
    return {
      provider: key,
      apiKey: "",
      model: chosenModel,
      ollamaHost: validateOllamaHost(env.OLLAMA_HOST, env)
    };
  }

  const resolvedKey = String(env[meta.envKey] || "").trim();
  if (!resolvedKey) {
    throw makeHttpError(
      400,
      `${meta.label} is not configured on this server. Add ${meta.envKey} in GitHub Secrets / .env or pick a configured provider.`
    );
  }

  return {
    provider: key,
    apiKey: resolvedKey,
    model: chosenModel,
    ollamaHost: ""
  };
}

/**
 * Resolves which image provider should generate/fetch dish imagery.
 */
export function resolveImageProvider(preferredProvider, env = process.env) {
  const mode = String(env.IMAGE_PROVIDER || "auto").toLowerCase().trim();
  if (mode === "off") return null;

  if (mode === "wikimedia") {
    return { provider: "wikimedia", apiKey: "", model: "" };
  }

  const checkAiProvider = (id) => {
    const meta = PROVIDER_DEFAULTS[id];
    if (!meta || !meta.imageModel) return null;
    const key = String(env[meta.envKey] || "").trim();
    if (!key) return null;
    const model = String(env[meta.envImageModel] || "").trim() || meta.imageModel;
    return { provider: id, apiKey: key, model };
  };

  if (mode === "gemini" || mode === "openai" || mode === "openrouter") {
    return checkAiProvider(mode);
  }

  // auto mode: prefer active text provider if it supports images, then fall back across configured providers
  const pref = String(preferredProvider || "").toLowerCase().trim();
  const order = [];
  if (pref && ["gemini", "openai", "openrouter"].includes(pref)) order.push(pref);
  for (const id of ["gemini", "openai", "openrouter"]) {
    if (!order.includes(id)) order.push(id);
  }
  for (const id of order) {
    const resolved = checkAiProvider(id);
    if (resolved) return resolved;
  }

  return { provider: "wikimedia", apiKey: "", model: "" };
}

/**
 * Normalizes image inputs (`data:mime;base64,...` or `{ mimeType, data }`) safely.
 */
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

/**
 * Builds the HTTP request descriptor `{ url, headers, body }` for text/multimodal completions.
 */
export function buildProviderRequest({
  provider,
  apiKey,
  model,
  ollamaHost,
  system,
  userText,
  images = [],
  stream = true,
  jsonMode = true
}, env = process.env) {
  const imgs = normalizeImages(images);

  if (provider === "gemini") {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}`;
    const parts = [];
    for (const img of imgs) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
    parts.push({ text: userText });

    const generationConfig = { temperature: 0.7 };
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
    if (!isReasoning) body.temperature = 0.7;
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
        "anthropic-version": "2023-06-01"
      },
      body: {
        model,
        max_tokens: 4096,
        temperature: 0.7,
        system,
        stream: Boolean(stream),
        messages: [{ role: "user", content: userContent }]
      }
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
      temperature: 0.7,
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
        "HTTP-Referer": "http://localhost",
        "X-Title": "Mise"
      },
      body
    };
  }

  if (provider === "ollama") {
    const host = validateOllamaHost(ollamaHost, env);
    const userMsg = { role: "user", content: userText };
    if (imgs.length) userMsg.images = imgs.map((img) => img.base64);

    const body = {
      model,
      stream: Boolean(stream),
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

  throw makeHttpError(400, `Unsupported provider: ${provider}`);
}

/**
 * Builds the HTTP request descriptor for AI image generation (`gemini`, `openai`, `openrouter`).
 */
export function buildImageRequest({ provider, apiKey, model, prompt }) {
  if (provider === "gemini") {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      }
    };
  }

  if (provider === "openai") {
    const body = {
      model,
      prompt,
      size: "1024x1024"
    };
    if (/^dall-e/i.test(model)) {
      body.response_format = "b64_json";
    }
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
        "HTTP-Referer": "http://localhost",
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

  throw makeHttpError(400, `Image generation not supported for provider: ${provider}`);
}

/**
 * Extracts a usable image URL or base64 data URL from provider image JSON responses.
 */
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

  if (provider === "openai" || provider === "openrouter") {
    const entry = data?.data?.[0];
    if (!entry) return null;
    if (entry.b64_json) {
      const mime = entry.media_type || "image/png";
      return `data:${mime};base64,${entry.b64_json}`;
    }
    if (entry.url && /^https?:\/\//i.test(entry.url)) {
      return entry.url;
    }
    return null;
  }

  return null;
}

/**
 * Fetches a safe Wikimedia/Wikipedia dish thumbnail URL as a zero-key visual fallback.
 */
export async function fetchWikimediaDishPhoto(title, fetchImpl = fetch, signal) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return null;

  const queries = [cleanTitle, `${cleanTitle} dish food`];
  for (const q of queries) {
    const url =
      "https://en.wikipedia.org/w/api.php?action=query&generator=search" +
      `&gsrsearch=${encodeURIComponent(q)}&gsrlimit=4&prop=pageimages&piprop=thumbnail&pithumbsize=960&format=json`;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { "User-Agent": "MiseRecipeApp/1.0" },
        signal
      });
      if (!res.ok) continue;
      const json = await res.json();
      const pages = Object.values(json?.query?.pages || {}).sort(
        (a, b) => (a.index ?? 99) - (b.index ?? 99)
      );
      for (const page of pages) {
        const src = page?.thumbnail?.source;
        if (typeof src === "string" && /^https:\/\/upload\.wikimedia\.org\//i.test(src)) {
          return src;
        }
      }
    } catch {
      // Fall through cleanly
    }
  }
  return null;
}

/**
 * Generates or finds an editorial photograph for a dish, falling back gracefully.
 */
export async function generateDishImage({
  title,
  tagline = "",
  cuisine = "",
  visualPrompt = "",
  provider,
  env = process.env,
  fetchImpl = fetch,
  signal
}) {
  const target = resolveImageProvider(provider, env);
  if (!target) {
    return { imageUrl: null, source: "none" };
  }

  if (target.provider !== "wikimedia") {
    try {
      const prompt = buildDishImagePrompt({ title, tagline, cuisine, visualPrompt });
      const desc = buildImageRequest({
        provider: target.provider,
        apiKey: target.apiKey,
        model: target.model,
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
        const imageUrl = parseImageResponse(target.provider, json);
        if (imageUrl) {
          return { imageUrl, source: target.provider };
        }
      }
    } catch {
      // Fall through cleanly to Wikimedia fallback unless explicit AI provider was forced
    }
  }

  if (String(env.IMAGE_PROVIDER || "auto").toLowerCase().trim() !== "off") {
    const wikiUrl = await fetchWikimediaDishPhoto(title, fetchImpl, signal);
    if (wikiUrl) {
      return { imageUrl: wikiUrl, source: "wikimedia" };
    }
  }

  return { imageUrl: null, source: "none" };
}

/**
 * Parses a single SSE or NDJSON line from an upstream provider into `{ text, done }`.
 */
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

  if (provider === "openai" || provider === "openrouter") {
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

/**
 * Extracts and parses a single JSON object from raw model text output,
 * stripping accidental markdown code fences or conversational wrappers.
 */
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

async function formatUpstreamError(provider, res, ollamaHost) {
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
      `Authentication failed for ${PROVIDER_DEFAULTS[provider]?.label || provider}. Verify the server API key secret.`
    );
  }
  if (res.status === 429) {
    return makeHttpError(429, "Rate limit reached on this AI provider. Wait a moment or switch providers.");
  }
  if (res.status === 404 && provider === "ollama") {
    return makeHttpError(404, `Ollama model not found on ${ollamaHost}.`);
  }
  return makeHttpError(res.status >= 400 ? res.status : 502, cleanDetail || `AI provider error (${res.status}).`);
}

function mapNetworkError(provider, err, ollamaHost) {
  if (err?.name === "AbortError") return err;
  const code = err?.code || err?.cause?.code;
  if (provider === "ollama" && (code === "ECONNREFUSED" || /fetch failed/i.test(err?.message || ""))) {
    return makeHttpError(
      503,
      `Ollama isn't reachable on ${ollamaHost || "http://127.0.0.1:11434"} — start it with \`ollama serve\`.`
    );
  }
  if (err?.status) return err;
  return makeHttpError(502, err?.message || "Failed to reach the AI provider.");
}

async function executeProviderFetch(opts, stream, signal) {
  const env = opts.env || process.env;
  const creds = resolveCredentials({ provider: opts.provider }, env);
  const fetchImpl = opts.fetchImpl || fetch;
  const jsonMode = opts.jsonMode !== false;

  const attempt = async (useJsonMode) => {
    const reqDesc = buildProviderRequest(
      {
        ...creds,
        system: opts.system,
        userText: opts.userText,
        images: opts.images,
        stream,
        jsonMode: useJsonMode
      },
      env
    );
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
    throw mapNetworkError(creds.provider, err, creds.ollamaHost);
  }

  if (!res.ok && res.status === 400 && creds.provider === "openrouter" && jsonMode) {
    const preview = await res.text().catch(() => "");
    if (/response_format|json_object|structured/i.test(preview)) {
      try {
        res = await attempt(false);
      } catch (err) {
        throw mapNetworkError(creds.provider, err, creds.ollamaHost);
      }
    } else {
      throw makeHttpError(400, preview.slice(0, 280) || "OpenRouter rejected the request.");
    }
  }

  if (!res.ok) {
    throw await formatUpstreamError(creds.provider, res, creds.ollamaHost);
  }

  return { res, creds };
}

/**
 * Streams text chunks from the configured AI provider and returns the concatenated text.
 */
export async function streamCompletion(opts, onDelta, signal) {
  const { res, creds } = await executeProviderFetch(opts, true, signal);
  const contentType = res.headers?.get?.("content-type") || "";

  if (!res.body || (contentType.includes("application/json") && creds.provider !== "ollama")) {
    const raw = await res.text();
    const { text } = parseProviderChunk(creds.provider, raw);
    if (text && onDelta) onDelta(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseProviderChunk(creds.provider, line);
        if (parsed.text) {
          fullText += parsed.text;
          if (onDelta) onDelta(parsed.text);
        }
      }
    }
    if (buffer.trim()) {
      const parsed = parseProviderChunk(creds.provider, buffer);
      if (parsed.text) {
        fullText += parsed.text;
        if (onDelta) onDelta(parsed.text);
      }
    }
  } catch (err) {
    throw mapNetworkError(creds.provider, err, creds.ollamaHost);
  }

  return fullText;
}

/**
 * Runs a non-streaming completion and parses the resulting JSON object.
 */
export async function completeJson(opts, signal) {
  const { res, creds } = await executeProviderFetch(opts, false, signal);
  const raw = await res.text();
  if (creds.provider === "gemini") {
    const data = JSON.parse(raw);
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("");
    return extractJsonObject(text);
  }
  if (creds.provider === "openai" || creds.provider === "openrouter") {
    const data = JSON.parse(raw);
    if (data?.error) throw makeHttpError(502, data.error.message || "Upstream AI error.");
    const text = data?.choices?.[0]?.message?.content || "";
    return extractJsonObject(text);
  }
  if (creds.provider === "claude") {
    const data = JSON.parse(raw);
    if (data?.error) throw makeHttpError(502, data.error.message || "Claude error.");
    const text = (data?.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
    return extractJsonObject(text);
  }
  if (creds.provider === "ollama") {
    const data = JSON.parse(raw);
    if (data?.error) throw makeHttpError(502, data.error);
    const text = data?.message?.content ?? data?.response ?? "";
    return extractJsonObject(text);
  }
  return extractJsonObject(raw);
}

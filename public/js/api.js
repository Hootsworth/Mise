import { fetchOpenDishPhoto } from "./open-images.js";

const PROVIDER_STORAGE_KEY = "mise:provider";
const AI_IMAGES_STORAGE_KEY = "mise:ai_images";

export function apiUrl(path) {
  const base = String(window.__MISE_CONFIG__?.apiBaseUrl || "").trim().replace(/\/+$/, "");
  return `${base}${path}`;
}

export function loadSelectedProvider() {
  try {
    return localStorage.getItem(PROVIDER_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveSelectedProvider(provider) {
  try {
    if (provider) localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    else localStorage.removeItem(PROVIDER_STORAGE_KEY);
  } catch {
    // Storage unavailable
  }
}

export function loadAiImagesOptIn() {
  try {
    return localStorage.getItem(AI_IMAGES_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveAiImagesOptIn(enabled) {
  try {
    if (enabled) localStorage.setItem(AI_IMAGES_STORAGE_KEY, "true");
    else localStorage.removeItem(AI_IMAGES_STORAGE_KEY);
  } catch {
    // Storage unavailable
  }
}

export function getActiveProvider() {
  return loadSelectedProvider() || "";
}

export async function getHealth() {
  try {
    const res = await fetch(apiUrl("/api/health"));
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("application/json")) {
      throw new Error("Static-only mode");
    }
    return await res.json();
  } catch {
    return {
      ok: false,
      staticOnly: true,
      defaultProvider: "gemini",
      imageGenerationAvailable: true,
      aiImageGenerationAvailable: false,
      providers: []
    };
  }
}

export async function postJson(path, payload, signal) {
  const provider = payload.provider || getActiveProvider();
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, ...(provider ? { provider } : {}) }),
    signal
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  return data;
}

export async function fetchDishIdeas(payload, signal) {
  return postJson("/api/ideas", payload, signal);
}

/**
 * Fetches a dish image via the server/Worker `/api/dish-image` endpoint (default open-image waterfall;
 * opt-in AI when `payload.useAi` is true). Falls back directly to client-side open image APIs when static-only.
 */
export async function fetchDishImage(payload, signal) {
  const body = {
    ...payload,
    useAi: Boolean(payload.useAi),
    excludeUrls: Array.isArray(payload.excludeUrls) ? payload.excludeUrls : [],
    ...(getActiveProvider() ? { provider: getActiveProvider() } : {})
  };

  try {
    const res = await fetch(apiUrl("/api/dish-image"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.includes("application/json")) {
      return await res.json();
    }
  } catch {
    // Fall through to client-side open photo lookup when backend is unavailable
  }

  if (!body.useAi) {
    return await fetchOpenDishPhoto({
      title: payload.title,
      cuisine: payload.cuisine,
      excludeUrls: body.excludeUrls,
      signal
    });
  }

  return { imageUrl: null, source: "none", credit: "", creditUrl: "" };
}

/**
 * Streams an SSE endpoint (`/api/generate`, `/api/revise`, `/api/apply-swap`)
 * across arbitrary chunk boundaries.
 */
export async function streamRecipeEndpoint(path, payload, { onDelta, onDone, onError, signal } = {}) {
  const provider = payload.provider || getActiveProvider();
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, ...(provider ? { provider } : {}) }),
    signal
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const err = new Error(errData.error || `Request failed (${res.status}).`);
    if (onError) onError(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;

  const dispatchFrame = (rawFrame) => {
    if (!rawFrame.trim()) return;
    let eventName = "message";
    const dataLines = [];
    for (const line of rawFrame.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!dataLines.length) return;
    let data;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (eventName === "delta" && data.text) {
      if (onDelta) onDelta(data.text);
    } else if (eventName === "done" && data.recipe) {
      donePayload = data.recipe;
      if (onDone) onDone(data.recipe);
    } else if (eventName === "error") {
      const err = new Error(data.message || "AI stream error.");
      if (onError) onError(err);
      throw err;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      dispatchFrame(frame);
    }
  }
  if (buffer.trim()) {
    dispatchFrame(buffer);
  }

  return donePayload;
}

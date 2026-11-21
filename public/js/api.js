const PROVIDER_STORAGE_KEY = "mise:provider";

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

export function getActiveProvider() {
  return loadSelectedProvider() || "";
}

export async function getHealth() {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error("Failed to inspect server provider availability.");
  return res.json();
}

export async function postJson(path, payload, signal) {
  const provider = payload.provider || getActiveProvider();
  const res = await fetch(path, {
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

export async function fetchDishImage(payload, signal) {
  try {
    const res = await fetch("/api/dish-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        ...(getActiveProvider() ? { provider: getActiveProvider() } : {})
      }),
      signal
    });
    if (!res.ok) return { imageUrl: null, source: "none" };
    return await res.json();
  } catch {
    return { imageUrl: null, source: "none" };
  }
}

/**
 * Streams an SSE endpoint (`/api/generate`, `/api/revise`, `/api/apply-swap`)
 * across arbitrary chunk boundaries.
 */
export async function streamRecipeEndpoint(path, payload, { onDelta, onDone, onError, signal } = {}) {
  const provider = payload.provider || getActiveProvider();
  const res = await fetch(path, {
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

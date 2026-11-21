/**
 * Browser client for the Mise Local MCP Companion (`/api/mcp/*`).
 * Remains completely quiet on static GitHub Pages unless companionUrl is set or user probes manually.
 */

export function isLocalhostRuntime(loc = globalThis.location) {
  if (!loc?.hostname) return false;
  return loc.hostname === "localhost" || loc.hostname === "127.0.0.1";
}

function extractUrlString(candidate) {
  if (typeof candidate === "string") return candidate;
  if (typeof MessageEvent !== "undefined" && candidate instanceof MessageEvent) {
    return candidate.origin;
  }
  if (candidate === globalThis) {
    return globalThis.location?.href ?? "";
  }
  return candidate?.href ?? "";
}

function extractOriginObject(candidate) {
  try {
    return globalThis.Origin.from(candidate);
  } catch (err) {
    // Synthetic MessageEvent instances in unit tests only populate candidate.origin
    if (typeof MessageEvent !== "undefined" && candidate instanceof MessageEvent) {
      return globalThis.Origin.from(candidate.origin);
    }
    throw err;
  }
}

/**
 * Validates exact web origins using the Origin API when available, falling back
 * to strict tuple-origin URL comparison that rejects opaque "null" origins.
 */
export function isSameOriginSafe(candidate, trustedOriginStr) {
  if (!trustedOriginStr || trustedOriginStr === "null") return false;
  try {
    if ("Origin" in globalThis && typeof globalThis.Origin?.from === "function") {
      return extractOriginObject(candidate).isSameOrigin(globalThis.Origin.from(trustedOriginStr));
    }
    const candidateUrl = new URL(extractUrlString(candidate));
    const trustedUrl = new URL(trustedOriginStr);
    return (
      candidateUrl.origin !== "null" &&
      trustedUrl.origin !== "null" &&
      candidateUrl.origin === trustedUrl.origin
    );
  } catch {
    return false;
  }
}

export function resolveCompanionOrigin(prefs, loc = globalThis.location) {
  const configured = String(prefs?.companionUrl || "").trim().replace(/\/+$/, "");
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.origin !== "null" && (u.protocol === "http:" || u.protocol === "https:")) {
        return u.origin;
      }
    } catch {
      return "";
    }
  }
  if (loc?.origin && loc.origin !== "null") {
    try {
      const u = new URL(loc.origin);
      if (u.origin !== "null" && (u.protocol === "http:" || u.protocol === "https:")) {
        return u.origin;
      }
    } catch {
      return "";
    }
  }
  return "";
}

const SESSION_TOKEN_KEY = "mise:mcp-session-token";

function getStoredSessionToken() {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(SESSION_TOKEN_KEY) || "" : "";
  } catch {
    return "";
  }
}

function saveStoredSessionToken(tok) {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (!tok || tok === "cleared") sessionStorage.removeItem(SESSION_TOKEN_KEY);
    else sessionStorage.setItem(SESSION_TOKEN_KEY, tok);
  } catch {
    // Storage unavailable
  }
}

async function companionJson(origin, path, { method = "GET", body, signal } = {}) {
  if (!origin) {
    throw new Error("Local or Vercel MCP Companion is not connected.");
  }
  const headers = {};
  const sessionTok = getStoredSessionToken();
  if (sessionTok) {
    headers["X-Mise-Session"] = sessionTok;
  }
  const init = {
    method,
    headers,
    credentials: "include",
    signal
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${origin}${path}`, init);
  const nextTok = res.headers?.get?.("x-mise-session");
  if (nextTok) {
    saveStoredSessionToken(nextTok);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Companion error (${res.status})`);
  }
  return data;
}

export async function fetchCompanionStatus(prefs, { signal, forceLocalProbe = false } = {}) {
  let origin = resolveCompanionOrigin(prefs);
  if (!origin && forceLocalProbe) {
    origin = "http://localhost:3456";
  }
  if (!origin) {
    return { available: false, mode: "", origin: "", providers: {}, error: "" };
  }
  const effectiveSignal =
    signal || (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(2500) : undefined);
  try {
    const data = await companionJson(origin, "/api/mcp/status", { signal: effectiveSignal });
    return {
      available: Boolean(data?.available),
      mode: data?.mode || "local",
      origin,
      providers: data?.providers || {},
      error: ""
    };
  } catch (err) {
    return {
      available: false,
      mode: "",
      origin,
      providers: {},
      error: err?.message || "Local MCP Companion unreachable."
    };
  }
}

export async function startOAuthSignIn(providerId, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  if (!origin) {
    throw new Error("Connect a Vercel backend or run `npm start` locally to sign in with OAuth.");
  }

  // Open popup synchronously inside user activation so browsers never block it after DCR
  const popup = globalThis.open(
    "about:blank",
    `mise_mcp_${providerId}`,
    "width=520,height=720,resizable=yes,scrollbars=yes"
  );
  if (!popup) {
    throw new Error("Popup blocked by browser. Allow popups for Mise and try again.");
  }
  try {
    const doc = popup.document;
    if (doc?.body) {
      doc.title = "Mise — Connecting…";
      doc.body.innerHTML =
        '<p style="font-family:system-ui,sans-serif;padding:32px;text-align:center;color:#444">Opening sign-in…</p>';
    }
  } catch {
    // Ignore cross-origin document write restriction
  }

  let started;
  try {
    started = await companionJson(origin, `/api/mcp/oauth/start/${encodeURIComponent(providerId)}`, {
      method: "POST",
      body: { openerOrigin: globalThis.location?.origin || origin }
    });
    popup.location.replace(started.authUrl);
  } catch (err) {
    try {
      popup.close();
    } catch {
      // Ignore
    }
    throw err;
  }

  const expectedCallbackOrigin = new URL(started.redirectUri).origin;

  const outcome = await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      globalThis.removeEventListener("message", onMessage);
      clearInterval(pollTimer);
      clearTimeout(maxTimer);
    };

    const finishOk = (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(msg);
    };

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onMessage = (event) => {
      if (!isSameOriginSafe(event, expectedCallbackOrigin)) return;
      if (event.data?.type !== "mise:mcp-auth") return;
      if (event.data.sessionToken) {
        saveStoredSessionToken(event.data.sessionToken);
      }
      if (event.data.ok) {
        finishOk(event.data);
      } else {
        finishErr(new Error(event.data.error || "Sign-in was cancelled or failed."));
      }
    };

    globalThis.addEventListener("message", onMessage);

    const pollTimer = setInterval(async () => {
      if (popup.closed && !settled) {
        const latest = await fetchCompanionStatus(prefs);
        if (latest.providers?.[providerId]?.connected) {
          finishOk({ ok: true, provider: providerId });
        } else {
          finishErr(new Error("Sign-in window closed before authorization completed."));
        }
      }
    }, 600);

    const maxTimer = setTimeout(() => {
      finishErr(new Error("Sign-in timed out after 5 minutes."));
    }, 5 * 60 * 1000);
  });

  const status = await fetchCompanionStatus(prefs);
  return { outcome, status };
}

export async function disconnectMcpProvider(providerId, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, `/api/mcp/disconnect/${encodeURIComponent(providerId)}`, {
    method: "POST",
    body: {}
  });
}

export async function configureBlinkit(config, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/blinkit/config", {
    method: "POST",
    body: config
  });
}

export async function blinkitSendPhone(phone, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/blinkit/login", {
    method: "POST",
    body: { phone }
  });
}

export async function blinkitSubmitOtp(otp, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/blinkit/otp", {
    method: "POST",
    body: { otp }
  });
}

export async function fetchGroceryAddresses(provider, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/groceries/addresses", {
    method: "POST",
    body: { provider }
  });
}

export async function searchGroceries({ provider, query, addressId }, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/groceries/search", {
    method: "POST",
    body: { provider, query, addressId }
  });
}

export async function manageGroceryCart(payload, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/groceries/cart", {
    method: "POST",
    body: payload
  });
}

export async function searchFoodRestaurants({ query, addressId }, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/food/search", {
    method: "POST",
    body: { query, addressId }
  });
}

export async function fetchFoodMenu({ restaurantId, addressId, query }, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/food/menu", {
    method: "POST",
    body: { restaurantId, addressId, query }
  });
}

export async function manageFoodCart(payload, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/food/cart", {
    method: "POST",
    body: payload
  });
}

export async function callMcpTool({ provider, tool, args = {}, confirmedRealOrder = false }, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/call", {
    method: "POST",
    body: { provider, tool, args, confirmedRealOrder }
  });
}

export async function fetchGoToGroceries({ provider = "swiggy-im", addressId = "" }, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/groceries/goto", {
    method: "POST",
    body: { provider, addressId }
  });
}

export async function fetchPaymentOptions({ provider, addressId = "" }, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/payment/options", {
    method: "POST",
    body: { provider, addressId }
  });
}

export async function submitRealPayment(payload, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/payment/pay", {
    method: "POST",
    body: payload
  });
}

export async function pollPaymentStatus(payload, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/payment/status", {
    method: "POST",
    body: payload
  });
}

export async function confirmPaidOrder(payload, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/payment/confirm", {
    method: "POST",
    body: payload
  });
}

export async function trackLiveOrder(payload, prefs) {
  const origin = resolveCompanionOrigin(prefs);
  return await companionJson(origin, "/api/mcp/orders/track", {
    method: "POST",
    body: payload
  });
}

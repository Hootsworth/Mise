import { createMcpStore } from "./store.mjs";
import { createStatelessRequestStore, isStatelessPendingState } from "./cookie-store.mjs";
import {
  OAUTH_PROVIDERS,
  startOAuthFlow,
  completeOAuthCallback,
  ensureValidAccessToken,
  refreshAccessToken,
  revokeAndClearProvider
} from "./oauth.mjs";
import { createHttpMcpClient } from "./http-client.mjs";
import {
  createBlinkitClient,
  parseBlinkitAddresses,
  parseBlinkitSearchResults
} from "./blinkit-client.mjs";

const ALLOWED_STATIC_HOSTS = new Set(["adityapdixit.me", "hootsworth.github.io"]);

function getExtraAllowedOrigins() {
  const raw = String(process.env.MISE_ALLOWED_ORIGINS || "").trim();
  if (!raw) return new Set();
  const out = new Set();
  for (const part of raw.split(",")) {
    const trimmed = part.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.origin !== "null") out.add(u.origin);
    } catch {
      // Ignore invalid origin entry
    }
  }
  return out;
}

/**
 * Validates web origins for Local or Vercel MCP Companion requests without prefix/substring bugs.
 */
export function isAllowedCompanionOrigin(origin) {
  if (!origin || typeof origin !== "string" || origin === "null") return false;
  try {
    const u = new URL(origin);
    if (u.origin === "null") return false;
    if (`${u.protocol}//${u.host}` !== origin) return false;
    if (u.protocol === "http:") {
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    }
    if (u.protocol === "https:") {
      if (ALLOWED_STATIC_HOSTS.has(u.hostname)) return true;
      return getExtraAllowedOrigins().has(u.origin);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Detects real-money order placement MCP tools requiring explicit confirmation.
 */
export function isOrderPlacementTool(toolName) {
  const name = String(toolName || "").trim();
  if (!name) return false;
  return (
    /^(checkout|place_food_order|pay_now|place_order|confirm_order|submit_order)$/i.test(name) ||
    /(place|create|submit|confirm).*order|checkout/i.test(name)
  );
}

function sendJson(res, status, data, corsOrigin = "", store = null) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Expose-Headers"] = "X-Mise-Session";
    headers["Access-Control-Allow-Private-Network"] = "true";
    headers["Vary"] = "Origin";
  }
  if (store?.isStateless && !res.getHeader("X-Mise-Session")) {
    const tok = store.getEncodedSessionToken?.();
    if (tok) headers["X-Mise-Session"] = tok;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendHtml(res, status, html) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(html);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  // Vercel Node runtimes may pre-populate req.body
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));
}

function renderOAuthPopupHtml({ providerId, ok, error, openerOrigin, sessionToken = "" }) {
  const payload = {
    type: "mise:mcp-auth",
    provider: providerId,
    ok: Boolean(ok),
    error: error ? String(error) : "",
    ...(sessionToken ? { sessionToken } : {})
  };
  const targetOrigin = isAllowedCompanionOrigin(openerOrigin) ? openerOrigin : "";
  const safePayloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  const safeOriginJson = JSON.stringify(targetOrigin).replace(/</g, "\\u003c");
  const label = OAUTH_PROVIDERS[providerId]?.label || providerId;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mise — ${escapeHtml(label)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #fafafa; color: #111113; padding: 24px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0c; color: #f5f5f7; }
    .card { background: #141417; border-color: #25252b; }
  }
  .card {
    max-width: 380px; width: 100%; border-radius: 24px; padding: 28px;
    background: #fff; border: 1px solid #e2e2e7; text-align: center;
  }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0 0 18px; font-size: 14px; opacity: 0.78; line-height: 1.5; }
  button {
    border: 0; border-radius: 999px; padding: 10px 22px; cursor: pointer;
    background: currentColor; font-size: 14px;
  }
  button span { filter: invert(1); }
</style>
</head>
<body>
  <div class="card">
    <h1>${ok ? `${escapeHtml(label)} connected` : "Sign-in incomplete"}</h1>
    <p>${ok ? "You can return to Mise now. This window will close automatically." : escapeHtml(error || "Authentication could not be completed.")}</p>
    <button type="button" onclick="window.close()"><span>Close window</span></button>
  </div>
  <script>
    (function() {
      var payload = ${safePayloadJson};
      var targetOrigin = ${safeOriginJson};
      if (window.opener && targetOrigin) {
        try { window.opener.postMessage(payload, targetOrigin); } catch (e) {}
      }
      if (payload.ok) {
        setTimeout(function() { window.close(); }, 650);
      }
    })();
  </script>
</body>
</html>`;
}

function getHttpEndpointForProvider(provider, overrides = {}) {
  if (provider === "swiggy-im") {
    return overrides?.swiggy?.imUrl || OAUTH_PROVIDERS.swiggy.imUrl;
  }
  if (provider === "swiggy-food") {
    return overrides?.swiggy?.foodUrl || OAUTH_PROVIDERS.swiggy.foodUrl;
  }
  if (provider === "zepto") {
    return overrides?.zepto?.mcpUrl || OAUTH_PROVIDERS.zepto.mcpUrl;
  }
  throw new Error(`Unknown remote MCP provider: ${provider}`);
}

function getOAuthId(provider) {
  return provider === "swiggy-im" || provider === "swiggy-food" ? "swiggy" : provider;
}

function unwrapData(obj) {
  if (!obj || typeof obj !== "object") return {};
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) && obj.success !== undefined) {
    return obj.data;
  }
  return obj;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "object" && v.value !== undefined) return numOrNull(v.value);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickPropName(tool, candidates, fallback) {
  const props = tool?.inputSchema?.properties || {};
  const keys = Object.keys(props);
  for (const cand of candidates) {
    const found = keys.find((k) => k.toLowerCase() === cand.toLowerCase());
    if (found) return found;
  }
  return fallback;
}

function normalizeSwiggyAddresses(rawObj) {
  const data = unwrapData(rawObj);
  const list = Array.isArray(data?.addresses) ? data.addresses : [];
  const defId = data?.resolution?.defaultAddressId || "";
  return list.map((a, idx) => ({
    id: String(a.id || idx),
    label: a.addressCategory || a.label || a.tag || "Address",
    details: [a.addressLine, a.area, a.city].filter(Boolean).join(", ") || a.formattedAddress || "",
    isDefault: defId ? String(a.id) === String(defId) : idx === 0
  }));
}

function normalizeGenericAddresses(rawObj) {
  const data = unwrapData(rawObj);
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.addresses)
    ? data.addresses
    : Array.isArray(data?.locations)
    ? data.locations
    : Array.isArray(data?.items)
    ? data.items
    : [];
  return raw.map((a, idx) => ({
    id: String(a.id || a.addressId || a.locationId || idx),
    label: a.label || a.addressCategory || a.name || a.tag || "Saved location",
    details: a.details || a.addressLine || a.formattedAddress || a.address || "",
    isDefault: Boolean(a.isDefault || idx === 0)
  }));
}

function normalizeSwiggyProducts(rawObj) {
  const data = unwrapData(rawObj);
  const products = Array.isArray(data?.products) ? data.products : [];
  const flat = [];
  for (const p of products) {
    const variations = Array.isArray(p.variations) && p.variations.length ? p.variations : [p];
    for (const v of variations) {
      flat.push({
        id: String(v.spinId || v.skuId || p.id || flat.length),
        spinId: v.spinId || "",
        skuId: v.skuId || v.id || "",
        name: v.displayName || p.displayName || p.name || "Product",
        variant: v.quantityDescription || v.quantity || v.weight || "",
        price: v.price?.offerPrice ?? v.price?.storePrice ?? v.price?.mrp ?? v.offerPrice ?? v.price ?? null,
        mrp: v.price?.mrp ?? v.mrp ?? null,
        inStock: v.isInStockAndAvailable !== undefined ? Boolean(v.isInStockAndAvailable) : true,
        imageUrl: v.images?.[0] || p.images?.[0] || ""
      });
    }
  }
  return flat;
}

function normalizeZeptoProducts(rawObj) {
  const data = unwrapData(rawObj);
  const candidates =
    (Array.isArray(data) && data) ||
    data?.products ||
    data?.items ||
    data?.results ||
    data?.catalog ||
    [];
  if (!Array.isArray(candidates)) return [];
  return candidates.map((p, idx) => ({
    id: String(p.id || p.productVariantId || p.variantId || p.skuId || idx),
    productVariantId: p.productVariantId || p.variantId || p.id || "",
    skuId: p.skuId || "",
    name: p.name || p.productName || p.title || "Item",
    variant: p.formattedPacksize || p.packsize || p.quantity || p.unit || "",
    price: p.sellingPrice ?? p.discountedSellingPrice ?? p.price ?? p.mrp ?? null,
    mrp: p.mrp ?? null,
    inStock: p.outOfStock === true || p.inStock === false ? false : true,
    imageUrl: p.imageUrl || p.image || ""
  }));
}

function normalizeSwiggyCart(rawObj) {
  const data = unwrapData(rawObj);
  const cart = data?.cart || data || {};
  const bd = cart.billBreakdown || {};
  const toPay =
    numOrNull(bd.toPay) ??
    numOrNull(bd.total) ??
    numOrNull(cart.toPay) ??
    numOrNull(cart.totalAmount);

  const items = (Array.isArray(cart.items) ? cart.items : []).map((it) => ({
    id: String(it.spinId || it.skuId || it.id || ""),
    spinId: it.spinId || "",
    skuId: it.skuId || "",
    name: it.name || it.displayName || "Item",
    variant: it.quantityDescription || it.variant || "",
    quantity: Number(it.quantity || 1),
    price: numOrNull(it.price ?? it.finalPrice ?? it.total),
    mrp: numOrNull(it.mrp),
    imageUrl: it.imageUrl || it.images?.[0] || ""
  }));

  const bill = {
    itemTotal: numOrNull(bd.itemTotal ?? bd.subtotal ?? cart.itemTotal),
    deliveryFee: numOrNull(bd.deliveryCharges ?? bd.deliveryFee ?? bd.deliveryCharge),
    handlingFee: numOrNull(bd.handlingFee ?? bd.handlingCharges),
    taxes: numOrNull(bd.taxes ?? bd.gst),
    discount: numOrNull(bd.discount ?? bd.savings),
    toPay
  };

  const warnings = [
    cart.addressWarning,
    cart.cartWarning,
    Array.isArray(cart.unserviceableItems) && cart.unserviceableItems.length
      ? `${cart.unserviceableItems.length} item(s) unavailable for delivery address.`
      : ""
  ].filter(Boolean);

  return {
    provider: "swiggy-im",
    items,
    total: toPay,
    bill,
    addressLabel: cart.addressLabel || cart.selectedAddress?.label || "",
    addressDetails: cart.deliveryAddress || cart.selectedAddress?.addressLine || "",
    availablePaymentMethods: Array.isArray(cart.availablePaymentMethods) ? cart.availablePaymentMethods : [],
    warnings,
    raw: rawObj
  };
}

function normalizeZeptoCart(rawObj) {
  const data = unwrapData(rawObj);
  const rawItems = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.cart?.items)
    ? data.cart.items
    : [];
  const items = rawItems.map((it, idx) => ({
    id: String(it.productVariantId || it.variantId || it.id || it.skuId || idx),
    productVariantId: it.productVariantId || it.variantId || it.id || "",
    skuId: it.skuId || "",
    name: it.name || it.productName || it.title || "Item",
    variant: it.formattedPacksize || it.packsize || it.variant || "",
    quantity: Number(it.quantity || 1),
    price: numOrNull(it.sellingPrice ?? it.price ?? it.total),
    mrp: numOrNull(it.mrp),
    imageUrl: it.imageUrl || it.image || ""
  }));
  const toPay = numOrNull(data?.toPay ?? data?.payableAmount ?? data?.total ?? data?.bill?.toPay);
  return {
    provider: "zepto",
    items,
    total: toPay,
    bill: {
      itemTotal: numOrNull(data?.itemTotal ?? data?.bill?.itemTotal),
      deliveryFee: numOrNull(data?.deliveryFee ?? data?.bill?.deliveryFee),
      handlingFee: numOrNull(data?.handlingFee ?? data?.bill?.handlingFee),
      taxes: numOrNull(data?.taxes ?? data?.bill?.taxes),
      discount: numOrNull(data?.discount ?? data?.bill?.discount),
      toPay
    },
    warnings: [],
    raw: rawObj
  };
}

function normalizeFoodCart(rawObj) {
  const root = unwrapData(rawObj);
  const pricing = root.pricing || {};
  const total = numOrNull(pricing.to_pay ?? pricing.total ?? root.toPay);
  const rawItems = Array.isArray(root.cartItems)
    ? root.cartItems
    : Array.isArray(root.items)
    ? root.items
    : [];
  const items = rawItems.map((it) => ({
    id: String(it.menu_item_id || it.id || ""),
    name: it.name || it.itemName || "Dish",
    quantity: Number(it.quantity || 1),
    price: numOrNull(it.finalPrice ?? it.final_price ?? it.price ?? it.total)
  }));
  const warnings = [];
  if (typeof total === "number" && total > 1000) {
    warnings.push("Swiggy Food MCP has a ₹1000 order cap in v1 — reduce cart total below ₹1000 to place via MCP.");
  }
  return {
    provider: "swiggy-food",
    restaurantId: root.restaurantId || "",
    restaurantName: root.restaurantName || "",
    appliedCoupon: root.couponCode || root.appliedCoupon || "",
    items,
    total,
    bill: {
      itemTotal: numOrNull(pricing.item_total ?? pricing.subtotal),
      deliveryFee: numOrNull(pricing.delivery_fee ?? pricing.delivery_charges),
      taxes: numOrNull(pricing.taxes ?? pricing.gst),
      discount: numOrNull(pricing.coupon_discount ?? pricing.discount),
      toPay: total
    },
    exceedsCap: typeof total === "number" && total > 1000,
    warnings,
    raw: rawObj
  };
}

function normalizeSwiggyPaymentOptions(rawObj, provider) {
  const data = unwrapData(rawObj);
  const desktopQr = Array.isArray(data?.platforms?.desktop?.methods) ? data.platforms.desktop.methods : [];
  const mobileUpiApps = Array.isArray(data?.platforms?.mobile?.methods) ? data.platforms.mobile.methods : [];
  const allMethods = Array.isArray(data?.allMethods) ? data.allMethods : [];
  const cod = data?.cod?.available
    ? data.cod
    : allMethods.find((m) => /^(cash|cod)$/i.test(m.id || m.displayName || "")) || null;
  const swiggyMoney = data?.swiggyMoney?.available ? data.swiggyMoney : null;

  return {
    provider,
    paymentAmount: data?.paymentAmount ?? null,
    desktopQr,
    mobileUpiApps,
    swiggyMoney,
    cod,
    allMethods,
    raw: rawObj
  };
}

function normalizePayOutcome(rawResult, provider, fallbackAddressId = "") {
  const env = rawResult?.data || {};
  const d = unwrapData(env);
  const foodContext =
    provider === "swiggy-food" && d.lat != null && d.lng != null
      ? {
          addressId: d.addressId || fallbackAddressId,
          cartId: d.cartId || null,
          lat: Number(d.lat),
          lng: Number(d.lng)
        }
      : null;

  return {
    provider,
    orderId: d.orderId || d.orders?.[0]?.orderId || null,
    status: d.status || (d.allSucceeded ? "CONFIRMED" : ""),
    normalizedStatus:
      d.normalizedStatus ||
      (d.status === "PENDING_PAYMENT" ? "pending" : d.orderId || d.allSucceeded ? "success" : "unknown"),
    paasId: d.paasId || "",
    transactionId: d.transactionId || "",
    upiIntentUrl: d.upiIntentUrl || "",
    bridgeUrl: d.bridgeUrl || "",
    paymentUrl: d.paymentUrl || d.checkoutUrl || d.bridgeUrl || "",
    isQrFlow: Boolean(d.isQrFlow),
    pollingIntervalInMs: Number(d.pollingIntervalInMs) || 4000,
    maxTimeToPollForInMs: Number(d.maxTimeToPollForInMs) || 180000,
    paymentMethod: d.paymentMethod || "",
    totalAmount: numOrNull(d.totalAmount ?? d.cartTotal),
    deliveryAddress: d.deliveryAddress || "",
    brandMessage: rawResult?.raw?.content?.[0]?.text || env?.message || d?.message || "",
    orders: Array.isArray(d.orders) ? d.orders : null,
    foodContext,
    raw: env
  };
}

/**
 * Creates the Local or Vercel Stateless MCP Companion request handler for `/api/mcp/*` & `/callback`.
 */
export function createMcpBridge({
  statePath,
  storageMode = "file",
  sessionSecret = "",
  fetchImpl = fetch,
  spawnImpl,
  providerOverrides = {}
} = {}) {
  const isStateless = storageMode === "stateless";
  const fileStore = isStateless ? null : createMcpStore({ statePath });
  const httpMcp = createHttpMcpClient({ fetchImpl });
  const blinkit = isStateless ? null : createBlinkitClient({ spawnImpl, fetchImpl });

  function getStoreForRequest(req, res, url) {
    if (!isStateless) return fileStore;
    return createStatelessRequestStore({
      req,
      res,
      secret: sessionSecret,
      secure: url.protocol === "https:"
    });
  }

  async function ensureToken(provider, store) {
    const oauthId = getOAuthId(provider);
    return await ensureValidAccessToken({
      providerId: oauthId,
      store,
      fetchImpl,
      overrides: providerOverrides
    });
  }

  async function refreshToken(provider, store) {
    const oauthId = getOAuthId(provider);
    return await refreshAccessToken({
      providerId: oauthId,
      store,
      fetchImpl,
      overrides: providerOverrides
    });
  }

  async function listRemoteTools(provider, store) {
    if (provider === "blinkit") {
      if (!blinkit || !blinkit.isRunning()) {
        throw new Error(
          isStateless
            ? "Blinkit Playwright MCP requires running Mise locally (`npm start`)."
            : "Blinkit MCP is not connected. Configure and connect Blinkit in Settings first."
        );
      }
      return await blinkit.listTools();
    }
    const endpoint = getHttpEndpointForProvider(provider, providerOverrides);
    const token = await ensureToken(provider, store);
    return await httpMcp.listTools(endpoint, token, {
      onUnauthorized: () => refreshToken(provider, store)
    });
  }

  async function callRemoteTool(provider, toolName, args = {}, { confirmedRealOrder = false } = {}, store) {
    if (isOrderPlacementTool(toolName) && confirmedRealOrder !== true) {
      const err = new Error("Explicit user confirmation required before placing a real order.");
      err.status = 400;
      throw err;
    }

    if (provider === "blinkit") {
      if (!blinkit || !blinkit.isRunning()) {
        throw new Error("Blinkit MCP is not connected. Connect Blinkit in Settings first.");
      }
      return await blinkit.callTool(toolName, args);
    }

    const endpoint = getHttpEndpointForProvider(provider, providerOverrides);
    const token = await ensureToken(provider, store);
    return await httpMcp.callTool(endpoint, token, toolName, args, {
      onUnauthorized: () => refreshToken(provider, store)
    });
  }

  async function resolveSwiggyAddressId(explicitAddressId, service = "swiggy-im", store) {
    if (explicitAddressId) {
      await store.setProvider("swiggy", { selectedAddressId: String(explicitAddressId) });
      return String(explicitAddressId);
    }
    const saved = await store.getProvider("swiggy");
    if (saved.selectedAddressId) return saved.selectedAddressId;

    const resTool = await callRemoteTool(service, "get_addresses", {}, {}, store);
    const list = normalizeSwiggyAddresses(resTool.data);
    const def = list.find((a) => a.isDefault) || list[0];
    if (!def) {
      throw new Error("No saved delivery address found on your Swiggy account.");
    }
    await store.setProvider("swiggy", { selectedAddressId: def.id });
    return def.id;
  }

  async function findZeptoTool(regex, store) {
    const tools = await listRemoteTools("zepto", store);
    return tools.find((t) => regex.test(t.name)) || null;
  }

  function canHandleCallback(url) {
    if (url.pathname !== "/callback") return false;
    const state = url.searchParams.get("state") || "";
    if (isStatelessPendingState(state)) return true;
    return url.searchParams.has("state") || url.searchParams.has("error") || url.searchParams.has("code");
  }

  async function handleRequest(req, res, url) {
    const pathname = url.pathname;
    const isApiRoute = pathname.startsWith("/api/mcp/");
    const isOAuthCallback =
      pathname.startsWith("/api/mcp/oauth/callback/") || canHandleCallback(url);

    if (!isApiRoute && !isOAuthCallback) return false;

    const reqOrigin = req.headers.origin || "";
    const corsOrigin = reqOrigin && isAllowedCompanionOrigin(reqOrigin) ? reqOrigin : "";

    if (isApiRoute && reqOrigin && !corsOrigin) {
      sendJson(res, 403, { error: "Origin not allowed by Mise MCP Companion." });
      return true;
    }

    if (req.method === "OPTIONS" && isApiRoute) {
      const headers = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Mise-Session",
        "Access-Control-Expose-Headers": "X-Mise-Session",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        Vary: "Origin"
      };
      if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
      res.writeHead(204, headers);
      res.end();
      return true;
    }

    const store = getStoreForRequest(req, res, url);

    try {
      // 1. Companion Status
      if (req.method === "GET" && pathname === "/api/mcp/status") {
        const all = await store.load();
        const now = Date.now();
        sendJson(
          res,
          200,
          {
            available: true,
            mode: isStateless ? "vercel-stateless" : "local",
            providers: {
              swiggy: {
                id: "swiggy",
                connected: Boolean(all.swiggy.accessToken),
                expired: Boolean(all.swiggy.expiresAt && all.swiggy.expiresAt <= now),
                expiresAt: all.swiggy.expiresAt || 0,
                grantedAt: all.swiggy.grantedAt || 0,
                scope: all.swiggy.scope || "",
                selectedAddressId: all.swiggy.selectedAddressId || "",
                mode: "oauth"
              },
              zepto: {
                id: "zepto",
                connected: Boolean(all.zepto.accessToken),
                expired: Boolean(all.zepto.expiresAt && all.zepto.expiresAt <= now),
                expiresAt: all.zepto.expiresAt || 0,
                grantedAt: all.zepto.grantedAt || 0,
                scope: all.zepto.scope || "",
                mode: "oauth"
              },
              blinkit: isStateless
                ? {
                    id: "blinkit",
                    connected: false,
                    loggedIn: false,
                    mode: "local-only",
                    reason: "Blinkit Playwright MCP requires running Mise locally (`npm start`)."
                  }
                : {
                    id: "blinkit",
                    connected: Boolean(blinkit?.isRunning()),
                    loggedIn: Boolean(all.blinkit.loggedIn),
                    mode: all.blinkit.mode || "stdio",
                    repoPath: all.blinkit.repoPath || "",
                    sseUrl: all.blinkit.sseUrl || "http://127.0.0.1:8000/sse"
                  },
              zomato: {
                id: "zomato",
                connected: false,
                mode: "deeplink",
                reason:
                  "Zomato MCP restricts OAuth redirect URIs to 6 approved clients (no custom apps or localhost)."
              }
            }
          },
          corsOrigin,
          store
        );
        return true;
      }

      // 2. OAuth Start
      const oauthStartMatch = pathname.match(/^\/api\/mcp\/oauth\/start\/(swiggy|zepto)$/);
      if (req.method === "POST" && oauthStartMatch) {
        const providerId = oauthStartMatch[1];
        const body = await readJsonBody(req);
        const proto = url.protocol === "https:" ? "https:" : "http:";
        const baseOrigin = `${proto}//${url.host || req.headers.host || "localhost:3456"}`;
        const candidateOpener = body.openerOrigin || reqOrigin || baseOrigin;
        const openerOrigin = isAllowedCompanionOrigin(candidateOpener) ? candidateOpener : baseOrigin;
        const started = await startOAuthFlow({
          providerId,
          baseOrigin,
          openerOrigin,
          store,
          fetchImpl,
          overrides: providerOverrides
        });
        sendJson(res, 200, started, corsOrigin, store);
        return true;
      }

      // 3. OAuth Callback (Swiggy custom callback or Zepto /callback)
      const cbMatch = pathname.match(/^\/api\/mcp\/oauth\/callback\/(swiggy|zepto)$/);
      if (req.method === "GET" && (cbMatch || canHandleCallback(url))) {
        const providerHint = cbMatch ? cbMatch[1] : undefined;
        try {
          const result = await completeOAuthCallback({
            providerId: providerHint,
            code: url.searchParams.get("code") || "",
            state: url.searchParams.get("state") || "",
            error: url.searchParams.get("error") || "",
            errorDescription: url.searchParams.get("error_description") || "",
            store,
            fetchImpl,
            overrides: providerOverrides
          });
          sendHtml(
            res,
            200,
            renderOAuthPopupHtml({
              providerId: result.providerId,
              ok: true,
              openerOrigin: result.openerOrigin,
              sessionToken: store.isStateless ? store.getEncodedSessionToken() : ""
            })
          );
        } catch (err) {
          sendHtml(
            res,
            400,
            renderOAuthPopupHtml({
              providerId: err.providerId || providerHint || "swiggy",
              ok: false,
              error: err.message,
              openerOrigin: err.openerOrigin || ""
            })
          );
        }
        return true;
      }

      // 4. Disconnect Provider
      const discMatch = pathname.match(/^\/api\/mcp\/disconnect\/(swiggy|zepto|blinkit)$/);
      if (req.method === "POST" && discMatch) {
        const pid = discMatch[1];
        if (pid === "blinkit") {
          if (blinkit) await blinkit.disconnect();
          await store.setProvider("blinkit", { loggedIn: false });
        } else {
          httpMcp.clearSession(
            pid === "swiggy"
              ? getHttpEndpointForProvider("swiggy-im", providerOverrides)
              : getHttpEndpointForProvider("zepto", providerOverrides)
          );
          if (pid === "swiggy") {
            httpMcp.clearSession(getHttpEndpointForProvider("swiggy-food", providerOverrides));
          }
          await revokeAndClearProvider({
            providerId: pid,
            store,
            fetchImpl,
            overrides: providerOverrides
          });
        }
        sendJson(res, 200, { ok: true, provider: pid }, corsOrigin, store);
        return true;
      }

      // 5. List Tools
      const toolsMatch = pathname.match(/^\/api\/mcp\/tools\/(swiggy-im|swiggy-food|zepto|blinkit)$/);
      if (req.method === "GET" && toolsMatch) {
        const tools = await listRemoteTools(toolsMatch[1], store);
        sendJson(res, 200, { tools }, corsOrigin, store);
        return true;
      }

      // 6. Direct Tool Call (guarded)
      if (req.method === "POST" && pathname === "/api/mcp/call") {
        const body = await readJsonBody(req);
        const { provider, tool, args = {}, confirmedRealOrder = false } = body;
        if (!provider || !tool) {
          sendJson(res, 400, { error: "Missing `provider` or `tool`." }, corsOrigin, store);
          return true;
        }
        const result = await callRemoteTool(provider, tool, args, { confirmedRealOrder }, store);
        sendJson(res, 200, result, corsOrigin, store);
        return true;
      }

      // 7. Blinkit Config + Connect + Phone/OTP (local runtime only)
      if (pathname.startsWith("/api/mcp/blinkit/") && (isStateless || !blinkit)) {
        sendJson(
          res,
          400,
          { error: "Blinkit Playwright MCP is only available when running Mise locally (`npm start`)." },
          corsOrigin,
          store
        );
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/blinkit/config") {
        const body = await readJsonBody(req);
        const current = await store.getProvider("blinkit");
        const nextCfg = {
          mode: body.mode === "sse" ? "sse" : "stdio",
          repoPath: body.repoPath !== undefined ? String(body.repoPath).trim() : current.repoPath,
          sseUrl: body.sseUrl !== undefined ? String(body.sseUrl).trim() : current.sseUrl,
          command: body.command ? String(body.command).trim() : current.command || "uv",
          args: Array.isArray(body.args) ? body.args : current.args || ["run", "main.py"],
          headless: body.headless !== undefined ? Boolean(body.headless) : true
        };
        await store.setProvider("blinkit", nextCfg);

        let loggedIn = false;
        let checkText = "";
        if (body.connect !== false) {
          await blinkit.connect(nextCfg);
          const checkRes = await blinkit.callTool("check_login", {});
          checkText = checkRes.text || "";
          loggedIn = /\blogged in\b/i.test(checkText) && !/not logged in/i.test(checkText);
          await store.setProvider("blinkit", { loggedIn });
        }
        sendJson(
          res,
          200,
          {
            ok: true,
            connected: blinkit.isRunning(),
            loggedIn,
            statusText: checkText,
            config: { ...nextCfg, loggedIn }
          },
          corsOrigin,
          store
        );
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/blinkit/login") {
        const body = await readJsonBody(req);
        const phone = String(body.phone || "").trim();
        if (!phone) {
          sendJson(res, 400, { error: "Enter a mobile number for Blinkit OTP login." }, corsOrigin, store);
          return true;
        }
        if (!blinkit.isRunning()) {
          const cfg = await store.getProvider("blinkit");
          await blinkit.connect(cfg);
        }
        const out = await blinkit.callTool("login", { phone_number: phone });
        const alreadyLogged = /already logged in/i.test(out.text || "");
        if (alreadyLogged) {
          await store.setProvider("blinkit", { loggedIn: true });
        }
        sendJson(res, 200, { ok: true, message: out.text, alreadyLogged }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/blinkit/otp") {
        const body = await readJsonBody(req);
        const otp = String(body.otp || "").trim();
        if (!otp) {
          sendJson(res, 400, { error: "Enter the OTP received on your phone." }, corsOrigin, store);
          return true;
        }
        if (!blinkit.isRunning()) {
          throw new Error("Blinkit session is not active. Reconnect Blinkit first.");
        }
        const out = await blinkit.callTool("enter_otp", { otp });
        const checkRes = await blinkit.callTool("check_login", {});
        const loggedIn =
          /session saved|logged in/i.test(`${out.text}\n${checkRes.text}`) &&
          !/not logged in/i.test(checkRes.text || "");
        await store.setProvider("blinkit", { loggedIn });
        sendJson(res, 200, { ok: true, loggedIn, message: out.text || checkRes.text }, corsOrigin, store);
        return true;
      }

      // 8. Normalized Grocery Helpers
      if (req.method === "POST" && pathname === "/api/mcp/groceries/addresses") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        if (provider === "swiggy-im" || provider === "swiggy-food") {
          const resTool = await callRemoteTool(provider, "get_addresses", {}, {}, store);
          const addresses = normalizeSwiggyAddresses(resTool.data);
          const def = addresses.find((a) => a.isDefault) || addresses[0];
          if (def) await store.setProvider("swiggy", { selectedAddressId: def.id });
          sendJson(res, 200, { addresses }, corsOrigin, store);
          return true;
        }
        if (provider === "blinkit") {
          const resTool = await callRemoteTool("blinkit", "get_addresses", {}, {}, store);
          sendJson(
            res,
            200,
            { addresses: parseBlinkitAddresses(resTool.text), rawText: resTool.text },
            corsOrigin,
            store
          );
          return true;
        }
        if (provider === "zepto") {
          const addrTool = await findZeptoTool(/(get|list|fetch).*address|location/i, store);
          if (!addrTool) {
            sendJson(res, 200, { addresses: [], note: "Address managed inside Zepto account." }, corsOrigin, store);
            return true;
          }
          const resTool = await callRemoteTool("zepto", addrTool.name, {}, {}, store);
          sendJson(res, 200, { addresses: normalizeGenericAddresses(resTool.data), raw: resTool.data }, corsOrigin, store);
          return true;
        }
        sendJson(res, 400, { error: `Unsupported grocery provider: ${provider}` }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/groceries/goto") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        if (provider === "swiggy-im") {
          const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-im", store);
          const resTool = await callRemoteTool("swiggy-im", "your_go_to_items", { addressId }, {}, store);
          sendJson(
            res,
            200,
            { addressId, items: normalizeSwiggyProducts(resTool.data), raw: resTool.data },
            corsOrigin,
            store
          );
          return true;
        }
        if (provider === "zepto") {
          const histTool = await findZeptoTool(/order.*history|recent.*order|frequent/i, store);
          if (!histTool) {
            sendJson(res, 200, { items: [], raw: null }, corsOrigin, store);
            return true;
          }
          const resTool = await callRemoteTool("zepto", histTool.name, {}, {}, store);
          sendJson(res, 200, { items: normalizeZeptoProducts(resTool.data), raw: resTool.data }, corsOrigin, store);
          return true;
        }
        sendJson(res, 200, { items: [] }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/groceries/search") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        const query = String(body.query || "").trim();
        if (!query) {
          sendJson(res, 400, { error: "Search query is required." }, corsOrigin, store);
          return true;
        }

        if (provider === "swiggy-im") {
          const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-im", store);
          const resTool = await callRemoteTool("swiggy-im", "search_products", { addressId, query }, {}, store);
          sendJson(
            res,
            200,
            { addressId, items: normalizeSwiggyProducts(resTool.data), raw: resTool.data },
            corsOrigin,
            store
          );
          return true;
        }

        if (provider === "blinkit") {
          const resTool = await callRemoteTool("blinkit", "search", { query }, {}, store);
          sendJson(
            res,
            200,
            { items: parseBlinkitSearchResults(resTool.text), rawText: resTool.text },
            corsOrigin,
            store
          );
          return true;
        }

        if (provider === "zepto") {
          const searchTool = await findZeptoTool(/search|catalog|find.*product/i, store);
          if (!searchTool) {
            throw new Error("Could not find a search tool in Zepto MCP tools/list.");
          }
          const queryKey = pickPropName(searchTool, ["query", "search", "q", "keyword", "searchQuery"], "query");
          const args = { [queryKey]: query };
          if (body.addressId) {
            const addrKey = pickPropName(searchTool, ["addressId", "locationId"], "");
            if (addrKey) args[addrKey] = body.addressId;
          }
          const resTool = await callRemoteTool("zepto", searchTool.name, args, {}, store);
          sendJson(
            res,
            200,
            { items: normalizeZeptoProducts(resTool.data), raw: resTool.data },
            corsOrigin,
            store
          );
          return true;
        }

        sendJson(res, 400, { error: `Unsupported grocery provider: ${provider}` }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/groceries/cart") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        const action = body.action || "get";

        if (provider === "swiggy-im") {
          const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-im", store);
          if (action === "get") {
            const resTool = await callRemoteTool("swiggy-im", "get_cart", {}, {}, store);
            sendJson(res, 200, normalizeSwiggyCart(resTool.data), corsOrigin, store);
            return true;
          }
          if (action === "clear") {
            const resTool = await callRemoteTool("swiggy-im", "clear_cart", {}, {}, store);
            sendJson(res, 200, normalizeSwiggyCart(resTool.data), corsOrigin, store);
            return true;
          }
          if (action === "update") {
            const items = Array.isArray(body.items) ? body.items : [];
            if (!items.length) {
              const cleared = await callRemoteTool("swiggy-im", "clear_cart", {}, {}, store);
              sendJson(res, 200, normalizeSwiggyCart(cleared.data), corsOrigin, store);
              return true;
            }
            const resTool = await callRemoteTool(
              "swiggy-im",
              "update_cart",
              { selectedAddressId: addressId, items },
              {},
              store
            );
            const after = await callRemoteTool("swiggy-im", "get_cart", {}, {}, store).catch(() => resTool);
            sendJson(res, 200, normalizeSwiggyCart(after.data), corsOrigin, store);
            return true;
          }
          if (action === "add" || action === "set_qty" || action === "remove") {
            const cur = await callRemoteTool("swiggy-im", "get_cart", {}, {}, store).catch(() => ({
              data: { items: [] }
            }));
            const existing = normalizeSwiggyCart(cur.data).items.map((it) => ({
              spinId: it.spinId || it.id,
              skuId: it.skuId || it.id,
              quantity: it.quantity || 1
            }));

            if (action === "add") {
              const additions =
                Array.isArray(body.items) && body.items.length
                  ? body.items
                  : [
                      {
                        spinId: body.spinId || body.itemId,
                        skuId: body.skuId || body.itemId,
                        quantity: Number(body.quantity || 1)
                      }
                    ];
              for (const addItem of additions) {
                const found = existing.find(
                  (e) =>
                    (addItem.spinId && e.spinId === addItem.spinId) ||
                    (addItem.skuId && e.skuId === addItem.skuId)
                );
                if (found) found.quantity += Number(addItem.quantity || 1);
                else {
                  existing.push({
                    spinId: addItem.spinId || addItem.itemId,
                    skuId: addItem.skuId || addItem.itemId,
                    quantity: Number(addItem.quantity || 1)
                  });
                }
              }
            } else {
              const targetSpin = body.spinId || body.itemId || body.id;
              const targetSku = body.skuId || body.itemId || body.id;
              const nextQty = action === "remove" ? 0 : Number(body.quantity ?? 0);
              const idx = existing.findIndex(
                (e) => (targetSpin && e.spinId === targetSpin) || (targetSku && e.skuId === targetSku)
              );
              if (idx !== -1) {
                if (nextQty <= 0) existing.splice(idx, 1);
                else existing[idx].quantity = nextQty;
              } else if (nextQty > 0) {
                existing.push({ spinId: targetSpin, skuId: targetSku, quantity: nextQty });
              }
            }

            if (!existing.length) {
              const cleared = await callRemoteTool("swiggy-im", "clear_cart", {}, {}, store);
              sendJson(res, 200, normalizeSwiggyCart(cleared.data), corsOrigin, store);
              return true;
            }
            const upd = await callRemoteTool(
              "swiggy-im",
              "update_cart",
              { selectedAddressId: addressId, items: existing },
              {},
              store
            );
            const after = await callRemoteTool("swiggy-im", "get_cart", {}, {}, store).catch(() => upd);
            sendJson(res, 200, normalizeSwiggyCart(after.data), corsOrigin, store);
            return true;
          }
        }

        if (provider === "blinkit") {
          if (action === "get") {
            const resTool = await callRemoteTool("blinkit", "check_cart", {}, {}, store);
            sendJson(res, 200, { provider: "blinkit", items: [], total: null, rawText: resTool.text }, corsOrigin, store);
            return true;
          }
          if (action === "add") {
            const resTool = await callRemoteTool(
              "blinkit",
              "add_to_cart",
              { item_id: String(body.itemId || body.id || ""), quantity: Number(body.quantity || 1) },
              {},
              store
            );
            sendJson(res, 200, { provider: "blinkit", ok: true, rawText: resTool.text }, corsOrigin, store);
            return true;
          }
          if (action === "clear" || action === "update" || action === "remove" || action === "set_qty") {
            const resTool = await callRemoteTool(
              "blinkit",
              "remove_from_cart",
              { item_id: String(body.itemId || body.id || ""), quantity: Number(body.quantity || 1) },
              {},
              store
            );
            sendJson(res, 200, { provider: "blinkit", ok: true, rawText: resTool.text }, corsOrigin, store);
            return true;
          }
        }

        if (provider === "zepto") {
          if (action === "get") {
            const getTool = await findZeptoTool(/get.*cart|view.*cart|cart.*get|^cart$/i, store);
            if (!getTool) throw new Error("Could not locate Zepto get_cart tool.");
            const resTool = await callRemoteTool("zepto", getTool.name, {}, {}, store);
            sendJson(res, 200, normalizeZeptoCart(resTool.data), corsOrigin, store);
            return true;
          }
          if (action === "clear") {
            const clearTool = await findZeptoTool(/clear.*cart|empty.*cart|flush.*cart/i, store);
            if (!clearTool) throw new Error("Could not locate Zepto clear_cart tool.");
            const resTool = await callRemoteTool("zepto", clearTool.name, {}, {}, store);
            sendJson(res, 200, normalizeZeptoCart(resTool.data), corsOrigin, store);
            return true;
          }
          if (action === "remove") {
            const rmTool =
              (await findZeptoTool(/remove.*cart|delete.*cart/i, store)) ||
              (await findZeptoTool(/update.*cart|manage.*cart|add.*cart/i, store));
            if (!rmTool) throw new Error("Could not locate Zepto remove/update cart tool.");
            const idKey = pickPropName(rmTool, ["productVariantId", "variantId", "productId", "skuId", "itemId", "id"], "itemId");
            const qtyKey = pickPropName(rmTool, ["quantity", "qty", "count"], "");
            const args = { [idKey]: body.productVariantId || body.itemId || body.id || "" };
            if (qtyKey) args[qtyKey] = 0;
            const resTool = await callRemoteTool("zepto", rmTool.name, args, {}, store);
            sendJson(res, 200, normalizeZeptoCart(resTool.data), corsOrigin, store);
            return true;
          }
          if (action === "add" || action === "update" || action === "set_qty") {
            const addTool =
              (action === "set_qty" && (await findZeptoTool(/update.*cart|manage.*cart/i, store))) ||
              (await findZeptoTool(/add.*cart|update.*cart|manage.*cart/i, store));
            if (!addTool) throw new Error("Could not locate Zepto add/update cart tool.");
            const idKey = pickPropName(addTool, ["productVariantId", "variantId", "productId", "skuId", "itemId", "id"], "itemId");
            const qtyKey = pickPropName(addTool, ["quantity", "qty", "count"], "quantity");
            const args = Array.isArray(addTool.inputSchema?.properties?.items)
              ? { items: body.items }
              : {
                  [idKey]: body.productVariantId || body.itemId || body.id || "",
                  [qtyKey]: Number(body.quantity ?? 1)
                };
            const resTool = await callRemoteTool("zepto", addTool.name, args, {}, store);
            sendJson(res, 200, normalizeZeptoCart(resTool.data), corsOrigin, store);
            return true;
          }
        }

        sendJson(res, 400, { error: `Unsupported cart action (${action}) for ${provider}` }, corsOrigin, store);
        return true;
      }

      // 9. Normalized Swiggy Food Helpers
      if (req.method === "POST" && pathname === "/api/mcp/food/search") {
        const body = await readJsonBody(req);
        const query = String(body.query || "").trim();
        if (!query) {
          sendJson(res, 400, { error: "Dish or restaurant query is required." }, corsOrigin, store);
          return true;
        }
        const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-food", store);
        const resTool = await callRemoteTool("swiggy-food", "search_restaurants", { addressId, query }, {}, store);
        const data = unwrapData(resTool.data);
        const rawList = Array.isArray(data?.restaurants) ? data.restaurants : [];
        const restaurants = rawList
          .map((r) => ({
            id: String(r.id || ""),
            name: r.name || "Restaurant",
            rating: r.rating ?? r.avgRating ?? null,
            eta: r.slaString || r.deliveryTime || (r.sla?.deliveryTime ? `${r.sla.deliveryTime} min` : ""),
            distance: r.lastMileTravelString || r.distance || "",
            costForTwo: r.costForTwoMessage || r.costForTwo || "",
            cuisines: Array.isArray(r.cuisines) ? r.cuisines : [],
            availabilityStatus: r.availabilityStatus || (r.isOpen === false ? "CLOSED" : "OPEN")
          }))
          .sort((a, b) => (a.availabilityStatus === "OPEN" ? 0 : 1) - (b.availabilityStatus === "OPEN" ? 0 : 1));

        sendJson(res, 200, { addressId, restaurants, raw: resTool.data }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/food/menu") {
        const body = await readJsonBody(req);
        const restaurantId = String(body.restaurantId || "").trim();
        if (!restaurantId) {
          sendJson(res, 400, { error: "restaurantId is required." }, corsOrigin, store);
          return true;
        }
        const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-food", store);
        const resTool = await callRemoteTool(
          "swiggy-food",
          "get_restaurant_menu",
          { addressId, restaurantId },
          {},
          store
        );
        const data = unwrapData(resTool.data);
        const categories = Array.isArray(data?.categories) ? data.categories : [];
        const flatItems = [];
        for (const cat of categories) {
          const top = Array.isArray(cat.items) ? cat.items : [];
          const sub = Array.isArray(cat.subcategories)
            ? cat.subcategories.flatMap((s) => (Array.isArray(s.items) ? s.items : []))
            : [];
          for (const it of [...top, ...sub]) {
            flatItems.push({
              id: String(it.id || it.menu_item_id || flatItems.length),
              name: it.name || "Dish",
              category: cat.title || cat.name || "",
              description: it.description || "",
              price: it.price ?? it.defaultPrice ?? null,
              inStock: it.inStock !== false,
              isVeg: it.isVeg ?? null
            });
          }
        }
        const q = String(body.query || "").trim().toLowerCase();
        if (q) {
          const tokens = q.split(/\s+/).filter((t) => t.length > 2);
          flatItems.sort((a, b) => {
            const sa = tokens.reduce((acc, tk) => acc + (`${a.name} ${a.description}`.toLowerCase().includes(tk) ? 1 : 0), 0);
            const sb = tokens.reduce((acc, tk) => acc + (`${b.name} ${b.description}`.toLowerCase().includes(tk) ? 1 : 0), 0);
            return sb - sa;
          });
        }
        sendJson(res, 200, { addressId, items: flatItems, raw: resTool.data }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/food/cart") {
        const body = await readJsonBody(req);
        const action = body.action || "get";
        const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-food", store);

        if (action === "get") {
          const resTool = await callRemoteTool(
            "swiggy-food",
            "get_food_cart",
            { addressId, restaurantName: body.restaurantName || "" },
            {},
            store
          );
          sendJson(res, 200, normalizeFoodCart(resTool.data), corsOrigin, store);
          return true;
        }
        if (action === "flush") {
          const resTool = await callRemoteTool("swiggy-food", "flush_food_cart", {}, {}, store);
          sendJson(res, 200, normalizeFoodCart(resTool.data), corsOrigin, store);
          return true;
        }
        if (action === "coupons") {
          const resTool = await callRemoteTool(
            "swiggy-food",
            "fetch_food_coupons",
            { addressId, restaurantId: body.restaurantId || "" },
            {},
            store
          );
          const data = unwrapData(resTool.data);
          const sections = Array.isArray(data?.coupon_sections) ? data.coupon_sections : [];
          const coupons = sections.flatMap((s) => s.coupons || []).filter((c) => c.applicable !== false);
          sendJson(res, 200, { coupons, raw: resTool.data }, corsOrigin, store);
          return true;
        }
        if (action === "apply_coupon") {
          const resTool = await callRemoteTool(
            "swiggy-food",
            "apply_food_coupon",
            { addressId, couponCode: body.couponCode || "" },
            {},
            store
          );
          const after = await callRemoteTool(
            "swiggy-food",
            "get_food_cart",
            { addressId, restaurantName: body.restaurantName || "" },
            {},
            store
          ).catch(() => resTool);
          sendJson(res, 200, normalizeFoodCart(after.data), corsOrigin, store);
          return true;
        }
        if (action === "add" || action === "set_qty" || action === "remove" || action === "update") {
          let nextItems = Array.isArray(body.cartItems) ? body.cartItems : null;
          let restaurantId = body.restaurantId || "";
          let restaurantName = body.restaurantName || "";

          if (!nextItems && (action === "add" || action === "set_qty" || action === "remove")) {
            const cur = await callRemoteTool(
              "swiggy-food",
              "get_food_cart",
              { addressId, restaurantName },
              {},
              store
            ).catch(() => ({ data: {} }));
            const norm = normalizeFoodCart(cur.data);
            restaurantId = restaurantId || norm.restaurantId;
            restaurantName = restaurantName || norm.restaurantName;
            const list =
              restaurantId && norm.restaurantId && restaurantId !== norm.restaurantId
                ? []
                : norm.items.map((it) => ({ menu_item_id: it.id, quantity: it.quantity || 1 }));

            const itemId = String(body.menuItemId || body.itemId || body.id || "");
            const idx = list.findIndex((x) => String(x.menu_item_id) === itemId);
            if (action === "add") {
              if (idx !== -1) list[idx].quantity += Number(body.quantity || 1);
              else if (itemId) list.push({ menu_item_id: itemId, quantity: Number(body.quantity || 1) });
            } else if (action === "remove") {
              if (idx !== -1) list.splice(idx, 1);
            } else {
              const q = Number(body.quantity ?? 0);
              if (idx !== -1) {
                if (q <= 0) list.splice(idx, 1);
                else list[idx].quantity = q;
              } else if (q > 0 && itemId) {
                list.push({ menu_item_id: itemId, quantity: q });
              }
            }
            nextItems = list;
          }

          if (!nextItems || !nextItems.length) {
            const flushed = await callRemoteTool("swiggy-food", "flush_food_cart", {}, {}, store);
            sendJson(res, 200, normalizeFoodCart(flushed.data), corsOrigin, store);
            return true;
          }

          const resTool = await callRemoteTool(
            "swiggy-food",
            "update_food_cart",
            { addressId, restaurantId, restaurantName, cartItems: nextItems },
            {},
            store
          );
          const after = await callRemoteTool(
            "swiggy-food",
            "get_food_cart",
            { addressId, restaurantName },
            {},
            store
          ).catch(() => resTool);
          sendJson(res, 200, normalizeFoodCart(after.data), corsOrigin, store);
          return true;
        }
        sendJson(res, 400, { error: `Unsupported food cart action: ${action}` }, corsOrigin, store);
        return true;
      }

      // 10. Unified Payment & Live Order Tracking Endpoints
      if (req.method === "POST" && pathname === "/api/mcp/payment/options") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";

        if (provider === "swiggy-im" || provider === "swiggy-food") {
          const addressId = await resolveSwiggyAddressId(body.addressId, provider, store);
          const resTool = await callRemoteTool(
            provider,
            "get_payment_options",
            { addressId },
            {},
            store
          );
          sendJson(res, 200, normalizeSwiggyPaymentOptions(resTool.data, provider), corsOrigin, store);
          return true;
        }

        if (provider === "zepto") {
          const optsTool = await findZeptoTool(/payment.*option|payment.*method/i, store);
          if (optsTool) {
            const resTool = await callRemoteTool("zepto", optsTool.name, {}, {}, store);
            sendJson(
              res,
              200,
              { provider: "zepto", zeptoMethods: resTool.data?.methods || resTool.data?.options || [], raw: resTool.data },
              corsOrigin,
              store
            );
            return true;
          }
          sendJson(
            res,
            200,
            {
              provider: "zepto",
              zeptoMethods: [
                { id: "UPI", displayName: "UPI Payment Link", kind: "link" },
                { id: "CARD", displayName: "Credit / Debit Card", kind: "card" },
                { id: "WALLET", displayName: "Zepto Cash Wallet", kind: "wallet" },
                { id: "UPI_RESERVE_PAY", displayName: "UPI Reserve Pay", kind: "reserve" },
                { id: "COD", displayName: "Cash on Delivery (COD)", kind: "cod" }
              ],
              raw: null
            },
            corsOrigin,
            store
          );
          return true;
        }

        sendJson(res, 400, { error: `Payment options not supported for ${provider}` }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/payment/pay") {
        const body = await readJsonBody(req);
        if (body.confirmedRealOrder !== true) {
          sendJson(
            res,
            400,
            { error: "Explicit user confirmation required before placing a real order." },
            corsOrigin,
            store
          );
          return true;
        }

        const provider = body.provider || "swiggy-im";
        const methodType = body.methodType || "cod"; // "upi_qr" | "upi_intent" | "swiggy_money" | "cod" | "zepto"

        if (provider === "swiggy-im" || provider === "swiggy-food") {
          const addressId = await resolveSwiggyAddressId(body.addressId, provider, store);
          const toolName = provider === "swiggy-im" ? "checkout" : "place_food_order";
          let args = { addressId };
          if (methodType === "upi_qr") {
            args = { addressId, paymentMethod: "UPI", generateUPIQR: true };
          } else if (methodType === "upi_intent") {
            if (!body.intentApp) {
              sendJson(res, 400, { error: "Select a returned UPI app identifier." }, corsOrigin, store);
              return true;
            }
            args = { addressId, paymentMethod: "UPI", intentApp: body.intentApp };
          } else if (methodType === "swiggy_money") {
            args = { addressId, paymentMethod: "SwiggyPay" };
          } else {
            args = {
              addressId,
              paymentMethod: body.paymentMethod || (provider === "swiggy-im" ? "COD" : "Cash")
            };
          }
          const resTool = await callRemoteTool(
            provider,
            toolName,
            args,
            { confirmedRealOrder: true },
            store
          );
          sendJson(res, 200, normalizePayOutcome(resTool, provider, addressId), corsOrigin, store);
          return true;
        }

        if (provider === "zepto") {
          const orderTool = await findZeptoTool(/checkout|place.*order|create.*order|submit.*order/i, store);
          if (!orderTool) {
            throw new Error("Could not find Zepto checkout tool.");
          }
          const pmKey = pickPropName(orderTool, ["paymentMethod", "paymentMode", "method"], "paymentMethod");
          const args = body.paymentMethod ? { [pmKey]: body.paymentMethod } : {};
          const resTool = await callRemoteTool(
            "zepto",
            orderTool.name,
            args,
            { confirmedRealOrder: true },
            store
          );
          sendJson(res, 200, normalizePayOutcome(resTool, "zepto"), corsOrigin, store);
          return true;
        }

        sendJson(res, 400, { error: `Unsupported payment provider: ${provider}` }, corsOrigin, store);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/payment/status") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        if (provider !== "swiggy-im" && provider !== "swiggy-food") {
          sendJson(res, 400, { error: `Payment status polling is for Swiggy MCP (${provider} not needed).` }, corsOrigin, store);
          return true;
        }
        const args = { paasId: body.paasId || "" };
        if (body.orderId) args.orderId = body.orderId;
        if (provider === "swiggy-food") {
          if (body.addressId) args.addressId = body.addressId;
          if (body.cartId) args.cartId = body.cartId;
          if (body.lat != null) args.lat = Number(body.lat);
          if (body.lng != null) args.lng = Number(body.lng);
        }
        const resTool = await callRemoteTool(provider, "check_payment_status", args, {}, store);
        const d = unwrapData(resTool.data);
        sendJson(
          res,
          200,
          {
            status: d.status || d.paymentStatus || "pending",
            terminal: Boolean(d.terminal),
            confirmed: Boolean(d.confirmed),
            message: resTool.data?.message || d.message || "",
            raw: resTool.data
          },
          corsOrigin,
          store
        );
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/payment/confirm") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        if (!body.orderId) {
          sendJson(res, 400, { error: "orderId is required to confirm order." }, corsOrigin, store);
          return true;
        }
        let args;
        if (provider === "swiggy-im") {
          args = { orderId: body.orderId, paasId: body.paasId || "" };
          if (body.transactionId) args.transactionId = body.transactionId;
        } else if (provider === "swiggy-food") {
          args = {
            orderId: body.orderId,
            addressId: body.addressId || "",
            lat: Number(body.lat),
            lng: Number(body.lng)
          };
          if (body.cartId) args.cartId = body.cartId;
        } else {
          sendJson(res, 400, { error: `Unsupported confirm provider: ${provider}` }, corsOrigin, store);
          return true;
        }

        const resTool = await callRemoteTool(
          provider,
          "confirm_order",
          args,
          { confirmedRealOrder: true },
          store
        );
        const d = unwrapData(resTool.data);
        sendJson(
          res,
          200,
          {
            ok: true,
            orderId: d.orderId || body.orderId,
            status: d.status || "PLACED",
            message: resTool.raw?.content?.[0]?.text || resTool.data?.message || d.message || "",
            raw: resTool.data
          },
          corsOrigin,
          store
        );
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/orders/track") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";

        if (provider === "swiggy-im") {
          const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-im", store);
          const resTool = await callRemoteTool(
            "swiggy-im",
            "get_delivery_status",
            { orderId: body.orderId || "", addressId },
            {},
            store
          );
          const d = unwrapData(resTool.data);
          sendJson(
            res,
            200,
            {
              orderId: d.orderId || body.orderId || "",
              status: d.status || (d.delivered ? "DELIVERED" : d.cancelled ? "CANCELLED" : "IN_PROGRESS"),
              etaText: d.etaText || d.deliveryBy || "",
              pollIntervalSec: Number(d.pollIntervalSec) || 15,
              delivered: Boolean(d.delivered),
              cancelled: Boolean(d.cancelled),
              disabled: Boolean(d.disabled),
              raw: resTool.data
            },
            corsOrigin,
            store
          );
          return true;
        }

        if (provider === "swiggy-food") {
          const resTool = await callRemoteTool(
            "swiggy-food",
            "track_food_order",
            body.orderId ? { orderId: body.orderId } : {},
            {},
            store
          );
          const d = unwrapData(resTool.data);
          const firstOrder = (Array.isArray(d.orders) && d.orders[0]) || d;
          const status = firstOrder.orderStatus || firstOrder.status || "IN_PROGRESS";
          sendJson(
            res,
            200,
            {
              orderId: firstOrder.orderId || body.orderId || "",
              status,
              etaText: firstOrder.etaText || firstOrder.estimatedDelivery || "",
              delivered: /delivered/i.test(status),
              cancelled: /cancelled/i.test(status),
              pollIntervalSec: 12,
              raw: resTool.data
            },
            corsOrigin,
            store
          );
          return true;
        }

        if (provider === "zepto") {
          const trackTool = await findZeptoTool(/track.*order|order.*status|get.*order/i, store);
          if (!trackTool) {
            sendJson(res, 200, { orderId: body.orderId || "", status: "Check Zepto app", etaText: "" }, corsOrigin, store);
            return true;
          }
          const orderKey = pickPropName(trackTool, ["orderId", "id"], "");
          const args = body.orderId && orderKey ? { [orderKey]: body.orderId } : {};
          const resTool = await callRemoteTool("zepto", trackTool.name, args, {}, store);
          const d = unwrapData(resTool.data);
          sendJson(
            res,
            200,
            {
              orderId: d.orderId || body.orderId || "",
              status: d.status || d.orderStatus || "PLACED",
              etaText: d.etaText || d.eta || "",
              delivered: /delivered/i.test(String(d.status || "")),
              cancelled: /cancelled/i.test(String(d.status || "")),
              raw: resTool.data
            },
            corsOrigin,
            store
          );
          return true;
        }

        sendJson(res, 400, { error: `Tracking not supported for ${provider}` }, corsOrigin, store);
        return true;
      }

      sendJson(res, 404, { error: "Unknown companion endpoint." }, corsOrigin, store);
      return true;
    } catch (err) {
      const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      sendJson(res, status, { error: err?.message || "MCP companion error." }, corsOrigin, store);
      return true;
    }
  }

  async function close() {
    if (blinkit) await blinkit.disconnect();
  }

  return {
    store: fileStore,
    canHandleCallback,
    handleRequest,
    close
  };
}

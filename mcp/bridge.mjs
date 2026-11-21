import { createMcpStore } from "./store.mjs";
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

/**
 * Validates web origins for Local MCP Companion requests without prefix/substring bugs.
 */
export function isAllowedCompanionOrigin(origin) {
  if (!origin || typeof origin !== "string" || origin === "null") return false;
  try {
    const u = new URL(origin);
    if (u.origin === "null") return false;
    // Reject trailing paths/queries inside an Origin candidate
    if (`${u.protocol}//${u.host}` !== origin) return false;
    if (u.protocol === "http:") {
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    }
    if (u.protocol === "https:") {
      return ALLOWED_STATIC_HOSTS.has(u.hostname);
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

function sendJson(res, status, data, corsOrigin = "") {
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
    headers["Access-Control-Allow-Private-Network"] = "true";
    headers["Vary"] = "Origin";
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

function renderOAuthPopupHtml({ providerId, ok, error, openerOrigin }) {
  const payload = {
    type: "mise:mcp-auth",
    provider: providerId,
    ok: Boolean(ok),
    error: error ? String(error) : ""
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

function pickPropName(tool, candidates, fallback) {
  const props = tool?.inputSchema?.properties || {};
  const keys = Object.keys(props);
  for (const cand of candidates) {
    const found = keys.find((k) => k.toLowerCase() === cand.toLowerCase());
    if (found) return found;
  }
  return fallback;
}

function normalizeSwiggyAddresses(data) {
  const list = Array.isArray(data?.addresses) ? data.addresses : [];
  const defId = data?.resolution?.defaultAddressId || "";
  return list.map((a, idx) => ({
    id: String(a.id || idx),
    label: a.addressCategory || a.label || a.tag || "Address",
    details: [a.addressLine, a.area, a.city].filter(Boolean).join(", ") || a.formattedAddress || "",
    isDefault: defId ? String(a.id) === String(defId) : idx === 0
  }));
}

function normalizeGenericAddresses(data) {
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

function normalizeSwiggyProducts(data) {
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

function normalizeZeptoProducts(data) {
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

function normalizeSwiggyCart(data) {
  const cart = data?.cart || data || {};
  const items = (Array.isArray(cart.items) ? cart.items : []).map((it) => ({
    id: String(it.spinId || it.skuId || it.id || ""),
    spinId: it.spinId || "",
    skuId: it.skuId || "",
    name: it.name || it.displayName || "Item",
    variant: it.quantityDescription || it.variant || "",
    quantity: Number(it.quantity || 1),
    price: it.price ?? it.finalPrice ?? it.total ?? null
  }));
  const total =
    cart.billBreakdown?.toPay?.value ??
    cart.toPay ??
    cart.totalAmount ??
    null;
  const warnings = [
    cart.addressWarning,
    cart.cartWarning,
    Array.isArray(cart.unserviceableItems) && cart.unserviceableItems.length
      ? `${cart.unserviceableItems.length} item(s) unavailable for delivery address.`
      : ""
  ].filter(Boolean);
  return { items, total, warnings, raw: data };
}

function normalizeFoodCart(data) {
  const root = data?.data || data || {};
  const pricing = root.pricing || {};
  const total = pricing.to_pay ?? pricing.total ?? root.toPay ?? null;
  const rawItems = Array.isArray(root.cartItems)
    ? root.cartItems
    : Array.isArray(root.items)
    ? root.items
    : [];
  const items = rawItems.map((it) => ({
    id: String(it.menu_item_id || it.id || ""),
    name: it.name || it.itemName || "Dish",
    quantity: Number(it.quantity || 1),
    price: it.finalPrice ?? it.price ?? it.total ?? null
  }));
  const warnings = [];
  if (typeof total === "number" && total > 1000) {
    warnings.push("Swiggy Food MCP has a ₹1000 order cap in v1 — reduce cart total below ₹1000 to place via MCP.");
  }
  return {
    restaurantId: root.restaurantId || "",
    restaurantName: root.restaurantName || "",
    items,
    total,
    exceedsCap: typeof total === "number" && total > 1000,
    warnings,
    raw: data
  };
}

/**
 * Creates the Local MCP Companion request handler for `/api/mcp/*` & OAuth `/callback`.
 */
export function createMcpBridge({
  statePath,
  fetchImpl = fetch,
  spawnImpl,
  providerOverrides = {}
} = {}) {
  const store = createMcpStore({ statePath });
  const httpMcp = createHttpMcpClient({ fetchImpl });
  const blinkit = createBlinkitClient({ spawnImpl, fetchImpl });

  async function ensureToken(provider) {
    const oauthId = getOAuthId(provider);
    return await ensureValidAccessToken({
      providerId: oauthId,
      store,
      fetchImpl,
      overrides: providerOverrides
    });
  }

  async function refreshToken(provider) {
    const oauthId = getOAuthId(provider);
    return await refreshAccessToken({
      providerId: oauthId,
      store,
      fetchImpl,
      overrides: providerOverrides
    });
  }

  async function listRemoteTools(provider) {
    if (provider === "blinkit") {
      if (!blinkit.isRunning()) {
        throw new Error("Blinkit MCP is not connected. Configure and connect Blinkit in Settings first.");
      }
      return await blinkit.listTools();
    }
    const endpoint = getHttpEndpointForProvider(provider, providerOverrides);
    const token = await ensureToken(provider);
    return await httpMcp.listTools(endpoint, token, {
      onUnauthorized: () => refreshToken(provider)
    });
  }

  async function callRemoteTool(provider, toolName, args = {}, { confirmedRealOrder = false } = {}) {
    if (isOrderPlacementTool(toolName) && confirmedRealOrder !== true) {
      const err = new Error("Explicit user confirmation required before placing a real order.");
      err.status = 400;
      throw err;
    }

    if (provider === "blinkit") {
      if (!blinkit.isRunning()) {
        throw new Error("Blinkit MCP is not connected. Connect Blinkit in Settings first.");
      }
      return await blinkit.callTool(toolName, args);
    }

    const endpoint = getHttpEndpointForProvider(provider, providerOverrides);
    const token = await ensureToken(provider);
    return await httpMcp.callTool(endpoint, token, toolName, args, {
      onUnauthorized: () => refreshToken(provider)
    });
  }

  async function resolveSwiggyAddressId(explicitAddressId, service = "swiggy-im") {
    if (explicitAddressId) {
      await store.setProvider("swiggy", { selectedAddressId: String(explicitAddressId) });
      return String(explicitAddressId);
    }
    const saved = await store.getProvider("swiggy");
    if (saved.selectedAddressId) return saved.selectedAddressId;

    const res = await callRemoteTool(service, "get_addresses", {});
    const list = normalizeSwiggyAddresses(res.data);
    const def = list.find((a) => a.isDefault) || list[0];
    if (!def) {
      throw new Error("No saved delivery address found on your Swiggy account.");
    }
    await store.setProvider("swiggy", { selectedAddressId: def.id });
    return def.id;
  }

  async function findZeptoTool(regex) {
    const tools = await listRemoteTools("zepto");
    return tools.find((t) => regex.test(t.name)) || null;
  }

  function canHandleCallback(url) {
    return (
      url.pathname === "/callback" &&
      (url.searchParams.has("state") || url.searchParams.has("error") || url.searchParams.has("code"))
    );
  }

  async function handleRequest(req, res, url) {
    const pathname = url.pathname;
    const isApiRoute = pathname.startsWith("/api/mcp/");
    const isOAuthCallback =
      pathname.startsWith("/api/mcp/oauth/callback/") || canHandleCallback(url);

    if (!isApiRoute && !isOAuthCallback) return false;

    const reqOrigin = req.headers.origin || "";
    const corsOrigin = reqOrigin && isAllowedCompanionOrigin(reqOrigin) ? reqOrigin : "";

    // Enforce origin check strictly when a browser Origin header is attached on API calls
    if (isApiRoute && reqOrigin && !corsOrigin) {
      sendJson(res, 403, { error: "Origin not allowed by Mise MCP Companion." });
      return true;
    }

    if (req.method === "OPTIONS" && isApiRoute) {
      const headers = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        Vary: "Origin"
      };
      if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
      res.writeHead(204, headers);
      res.end();
      return true;
    }

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
              blinkit: {
                id: "blinkit",
                connected: blinkit.isRunning(),
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
          corsOrigin
        );
        return true;
      }

      // 2. OAuth Start
      const oauthStartMatch = pathname.match(/^\/api\/mcp\/oauth\/start\/(swiggy|zepto)$/);
      if (req.method === "POST" && oauthStartMatch) {
        const providerId = oauthStartMatch[1];
        const body = await readJsonBody(req);
        const baseOrigin = `http://${req.headers.host || "localhost:3456"}`;
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
        sendJson(res, 200, started, corsOrigin);
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
              openerOrigin: result.openerOrigin
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
          await blinkit.disconnect();
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
        sendJson(res, 200, { ok: true, provider: pid }, corsOrigin);
        return true;
      }

      // 5. List Tools
      const toolsMatch = pathname.match(/^\/api\/mcp\/tools\/(swiggy-im|swiggy-food|zepto|blinkit)$/);
      if (req.method === "GET" && toolsMatch) {
        const tools = await listRemoteTools(toolsMatch[1]);
        sendJson(res, 200, { tools }, corsOrigin);
        return true;
      }

      // 6. Direct Tool Call (guarded)
      if (req.method === "POST" && pathname === "/api/mcp/call") {
        const body = await readJsonBody(req);
        const { provider, tool, args = {}, confirmedRealOrder = false } = body;
        if (!provider || !tool) {
          sendJson(res, 400, { error: "Missing `provider` or `tool`." }, corsOrigin);
          return true;
        }
        const result = await callRemoteTool(provider, tool, args, { confirmedRealOrder });
        sendJson(res, 200, result, corsOrigin);
        return true;
      }

      // 7. Blinkit Config + Connect + Phone/OTP
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
          corsOrigin
        );
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/blinkit/login") {
        const body = await readJsonBody(req);
        const phone = String(body.phone || "").trim();
        if (!phone) {
          sendJson(res, 400, { error: "Enter a mobile number for Blinkit OTP login." }, corsOrigin);
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
        sendJson(res, 200, { ok: true, message: out.text, alreadyLogged }, corsOrigin);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/blinkit/otp") {
        const body = await readJsonBody(req);
        const otp = String(body.otp || "").trim();
        if (!otp) {
          sendJson(res, 400, { error: "Enter the OTP received on your phone." }, corsOrigin);
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
        sendJson(res, 200, { ok: true, loggedIn, message: out.text || checkRes.text }, corsOrigin);
        return true;
      }

      // 8. Normalized Grocery Helpers
      if (req.method === "POST" && pathname === "/api/mcp/groceries/addresses") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        if (provider === "swiggy-im") {
          const resTool = await callRemoteTool("swiggy-im", "get_addresses", {});
          const addresses = normalizeSwiggyAddresses(resTool.data);
          const def = addresses.find((a) => a.isDefault) || addresses[0];
          if (def) await store.setProvider("swiggy", { selectedAddressId: def.id });
          sendJson(res, 200, { addresses }, corsOrigin);
          return true;
        }
        if (provider === "blinkit") {
          const resTool = await callRemoteTool("blinkit", "get_addresses", {});
          sendJson(
            res,
            200,
            { addresses: parseBlinkitAddresses(resTool.text), rawText: resTool.text },
            corsOrigin
          );
          return true;
        }
        if (provider === "zepto") {
          const addrTool = await findZeptoTool(/(get|list|fetch).*address|location/i);
          if (!addrTool) {
            sendJson(res, 200, { addresses: [], note: "Address managed inside Zepto account." }, corsOrigin);
            return true;
          }
          const resTool = await callRemoteTool("zepto", addrTool.name, {});
          sendJson(res, 200, { addresses: normalizeGenericAddresses(resTool.data), raw: resTool.data }, corsOrigin);
          return true;
        }
        sendJson(res, 400, { error: `Unsupported grocery provider: ${provider}` }, corsOrigin);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/groceries/search") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        const query = String(body.query || "").trim();
        if (!query) {
          sendJson(res, 400, { error: "Search query is required." }, corsOrigin);
          return true;
        }

        if (provider === "swiggy-im") {
          const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-im");
          const resTool = await callRemoteTool("swiggy-im", "search_products", { addressId, query });
          sendJson(
            res,
            200,
            { addressId, items: normalizeSwiggyProducts(resTool.data), raw: resTool.data },
            corsOrigin
          );
          return true;
        }

        if (provider === "blinkit") {
          const resTool = await callRemoteTool("blinkit", "search", { query });
          sendJson(
            res,
            200,
            { items: parseBlinkitSearchResults(resTool.text), rawText: resTool.text },
            corsOrigin
          );
          return true;
        }

        if (provider === "zepto") {
          const searchTool = await findZeptoTool(/search|catalog|find.*product/i);
          if (!searchTool) {
            throw new Error("Could not find a search tool in Zepto MCP tools/list.");
          }
          const queryKey = pickPropName(searchTool, ["query", "search", "q", "keyword", "searchQuery"], "query");
          const args = { [queryKey]: query };
          if (body.addressId) {
            const addrKey = pickPropName(searchTool, ["addressId", "locationId"], "");
            if (addrKey) args[addrKey] = body.addressId;
          }
          const resTool = await callRemoteTool("zepto", searchTool.name, args);
          sendJson(
            res,
            200,
            { items: normalizeZeptoProducts(resTool.data), raw: resTool.data },
            corsOrigin
          );
          return true;
        }

        sendJson(res, 400, { error: `Unsupported grocery provider: ${provider}` }, corsOrigin);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/groceries/cart") {
        const body = await readJsonBody(req);
        const provider = body.provider || "swiggy-im";
        const action = body.action || "get";

        if (provider === "swiggy-im") {
          const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-im");
          if (action === "get") {
            const resTool = await callRemoteTool("swiggy-im", "get_cart", {});
            sendJson(res, 200, normalizeSwiggyCart(resTool.data), corsOrigin);
            return true;
          }
          if (action === "clear") {
            const resTool = await callRemoteTool("swiggy-im", "clear_cart", {});
            sendJson(res, 200, normalizeSwiggyCart(resTool.data), corsOrigin);
            return true;
          }
          if (action === "update") {
            const items = Array.isArray(body.items) ? body.items : [];
            const resTool = await callRemoteTool("swiggy-im", "update_cart", {
              selectedAddressId: addressId,
              items
            });
            const after = await callRemoteTool("swiggy-im", "get_cart", {}).catch(() => resTool);
            sendJson(res, 200, normalizeSwiggyCart(after.data), corsOrigin);
            return true;
          }
          if (action === "add") {
            // Swiggy Instamart `update_cart` replaces the cart — read current items first and merge.
            const cur = await callRemoteTool("swiggy-im", "get_cart", {}).catch(() => ({ data: { items: [] } }));
            const existing = normalizeSwiggyCart(cur.data).items.map((it) => ({
              spinId: it.spinId || it.id,
              skuId: it.skuId || it.id,
              quantity: it.quantity || 1
            }));
            const additions = Array.isArray(body.items) && body.items.length
              ? body.items
              : [{ spinId: body.spinId || body.itemId, skuId: body.skuId || body.itemId, quantity: Number(body.quantity || 1) }];

            for (const addItem of additions) {
              const found = existing.find(
                (e) =>
                  (addItem.spinId && e.spinId === addItem.spinId) ||
                  (addItem.skuId && e.skuId === addItem.skuId)
              );
              if (found) {
                found.quantity += Number(addItem.quantity || 1);
              } else {
                existing.push({
                  spinId: addItem.spinId || addItem.itemId,
                  skuId: addItem.skuId || addItem.itemId,
                  quantity: Number(addItem.quantity || 1)
                });
              }
            }
            const upd = await callRemoteTool("swiggy-im", "update_cart", {
              selectedAddressId: addressId,
              items: existing
            });
            const after = await callRemoteTool("swiggy-im", "get_cart", {}).catch(() => upd);
            sendJson(res, 200, normalizeSwiggyCart(after.data), corsOrigin);
            return true;
          }
        }

        if (provider === "blinkit") {
          if (action === "get") {
            const resTool = await callRemoteTool("blinkit", "check_cart", {});
            sendJson(res, 200, { items: [], total: null, rawText: resTool.text }, corsOrigin);
            return true;
          }
          if (action === "add") {
            const resTool = await callRemoteTool("blinkit", "add_to_cart", {
              item_id: String(body.itemId || body.id || ""),
              quantity: Number(body.quantity || 1)
            });
            sendJson(res, 200, { ok: true, rawText: resTool.text }, corsOrigin);
            return true;
          }
          if (action === "clear" || action === "update") {
            const resTool = await callRemoteTool("blinkit", "remove_from_cart", {
              item_id: String(body.itemId || body.id || ""),
              quantity: Number(body.quantity || 1)
            });
            sendJson(res, 200, { ok: true, rawText: resTool.text }, corsOrigin);
            return true;
          }
        }

        if (provider === "zepto") {
          if (action === "get") {
            const getTool = await findZeptoTool(/get.*cart|view.*cart|cart.*get|^cart$/i);
            if (!getTool) throw new Error("Could not locate Zepto get_cart tool.");
            const resTool = await callRemoteTool("zepto", getTool.name, {});
            sendJson(res, 200, { items: resTool.data?.items || [], total: resTool.data?.total ?? null, raw: resTool.data }, corsOrigin);
            return true;
          }
          if (action === "clear") {
            const clearTool = await findZeptoTool(/clear.*cart|empty.*cart|flush.*cart/i);
            if (!clearTool) throw new Error("Could not locate Zepto clear_cart tool.");
            const resTool = await callRemoteTool("zepto", clearTool.name, {});
            sendJson(res, 200, { items: [], total: 0, raw: resTool.data }, corsOrigin);
            return true;
          }
          if (action === "add" || action === "update") {
            const addTool = await findZeptoTool(/add.*cart|update.*cart|manage.*cart/i);
            if (!addTool) throw new Error("Could not locate Zepto add/update cart tool.");
            const idKey = pickPropName(addTool, ["productVariantId", "variantId", "productId", "skuId", "itemId", "id"], "itemId");
            const qtyKey = pickPropName(addTool, ["quantity", "qty", "count"], "quantity");
            const args = Array.isArray(addTool.inputSchema?.properties?.items)
              ? { items: body.items }
              : {
                  [idKey]: body.productVariantId || body.itemId || body.id || "",
                  [qtyKey]: Number(body.quantity || 1)
                };
            const resTool = await callRemoteTool("zepto", addTool.name, args);
            sendJson(res, 200, { items: resTool.data?.items || [], total: resTool.data?.total ?? null, raw: resTool.data }, corsOrigin);
            return true;
          }
        }

        sendJson(res, 400, { error: `Unsupported cart action (${action}) for ${provider}` }, corsOrigin);
        return true;
      }

      // 9. Normalized Swiggy Food Helpers
      if (req.method === "POST" && pathname === "/api/mcp/food/search") {
        const body = await readJsonBody(req);
        const query = String(body.query || "").trim();
        if (!query) {
          sendJson(res, 400, { error: "Dish or restaurant query is required." }, corsOrigin);
          return true;
        }
        const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-food");
        const resTool = await callRemoteTool("swiggy-food", "search_restaurants", { addressId, query });
        const rawList = Array.isArray(resTool.data?.restaurants) ? resTool.data.restaurants : [];
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

        sendJson(res, 200, { addressId, restaurants, raw: resTool.data }, corsOrigin);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/food/menu") {
        const body = await readJsonBody(req);
        const restaurantId = String(body.restaurantId || "").trim();
        if (!restaurantId) {
          sendJson(res, 400, { error: "restaurantId is required." }, corsOrigin);
          return true;
        }
        const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-food");
        const resTool = await callRemoteTool("swiggy-food", "get_restaurant_menu", {
          addressId,
          restaurantId
        });
        const categories = Array.isArray(resTool.data?.categories) ? resTool.data.categories : [];
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
        sendJson(res, 200, { addressId, items: flatItems, raw: resTool.data }, corsOrigin);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/mcp/food/cart") {
        const body = await readJsonBody(req);
        const action = body.action || "get";
        const addressId = await resolveSwiggyAddressId(body.addressId, "swiggy-food");

        if (action === "get") {
          const resTool = await callRemoteTool("swiggy-food", "get_food_cart", {
            addressId,
            restaurantName: body.restaurantName || ""
          });
          sendJson(res, 200, normalizeFoodCart(resTool.data), corsOrigin);
          return true;
        }
        if (action === "flush") {
          const resTool = await callRemoteTool("swiggy-food", "flush_food_cart", {});
          sendJson(res, 200, normalizeFoodCart(resTool.data), corsOrigin);
          return true;
        }
        if (action === "coupons") {
          const resTool = await callRemoteTool("swiggy-food", "fetch_food_coupons", {
            addressId,
            restaurantId: body.restaurantId || ""
          });
          const sections = Array.isArray(resTool.data?.coupon_sections) ? resTool.data.coupon_sections : [];
          const coupons = sections.flatMap((s) => s.coupons || []).filter((c) => c.applicable !== false);
          sendJson(res, 200, { coupons, raw: resTool.data }, corsOrigin);
          return true;
        }
        if (action === "apply_coupon") {
          const resTool = await callRemoteTool("swiggy-food", "apply_food_coupon", {
            addressId,
            couponCode: body.couponCode || ""
          });
          const after = await callRemoteTool("swiggy-food", "get_food_cart", {
            addressId,
            restaurantName: body.restaurantName || ""
          }).catch(() => resTool);
          sendJson(res, 200, normalizeFoodCart(after.data), corsOrigin);
          return true;
        }
        if (action === "update") {
          const resTool = await callRemoteTool("swiggy-food", "update_food_cart", {
            addressId,
            restaurantId: body.restaurantId || "",
            restaurantName: body.restaurantName || "",
            cartItems: Array.isArray(body.cartItems) ? body.cartItems : []
          });
          const after = await callRemoteTool("swiggy-food", "get_food_cart", {
            addressId,
            restaurantName: body.restaurantName || ""
          }).catch(() => resTool);
          sendJson(res, 200, normalizeFoodCart(after.data), corsOrigin);
          return true;
        }
        sendJson(res, 400, { error: `Unsupported food cart action: ${action}` }, corsOrigin);
        return true;
      }

      sendJson(res, 404, { error: "Unknown companion endpoint." }, corsOrigin);
      return true;
    } catch (err) {
      const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      sendJson(res, status, { error: err?.message || "MCP companion error." }, corsOrigin);
      return true;
    }
  }

  async function close() {
    await blinkit.disconnect();
  }

  return {
    store,
    canHandleCallback,
    handleRequest,
    close
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { createServer } from "../server.mjs";
import { createMcpBridge, isAllowedCompanionOrigin, isOrderPlacementTool } from "../mcp/bridge.mjs";

async function startMockOAuthAndMcpServer() {
  const registeredClients = new Map();
  const authCodes = new Map();
  let swiggyToken = "swiggy_tok_v1";
  let zeptoToken = "zepto_tok_v1";
  let requireSwiggyRefresh = false;
  let swiggyCartItems = [];
  let foodCartState = null;
  let payPollCount = 0;
  let lastImConfirmArgs = null;
  let lastFoodConfirmArgs = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const bodyText = Buffer.concat(chunks).toString("utf8");

    const sendJson = (status, data, extraHeaders = {}) => {
      const b = JSON.stringify(data);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(b),
        ...extraHeaders
      });
      res.end(b);
    };

    const base = `http://${req.headers.host}`;

    // Metadata discovery
    if (req.method === "GET" && url.pathname === "/swiggy/.well-known/oauth-authorization-server") {
      return sendJson(200, {
        issuer: `${base}/swiggy`,
        authorization_endpoint: `${base}/swiggy/auth/authorize`,
        token_endpoint: `${base}/swiggy/auth/token`,
        registration_endpoint: `${base}/swiggy/auth/register`,
        scopes_supported: ["mcp:tools", "mcp:resources"]
      });
    }
    if (req.method === "GET" && url.pathname === "/zepto/.well-known/oauth-protected-resource") {
      return sendJson(200, {
        authorization_servers: [`${base}/zepto-auth`],
        scopes_supported: ["tools:read", "tools:write"]
      });
    }
    if (req.method === "GET" && url.pathname === "/zepto-auth/.well-known/oauth-authorization-server") {
      return sendJson(200, {
        issuer: `${base}/zepto-auth`,
        authorization_endpoint: `${base}/zepto-auth/authorize`,
        token_endpoint: `${base}/zepto-auth/token`,
        registration_endpoint: `${base}/zepto-auth/register`,
        revocation_endpoint: `${base}/zepto-auth/revoke`,
        scopes_supported: ["tools:read", "tools:write"]
      });
    }

    // Dynamic Client Registration
    if (req.method === "POST" && (url.pathname === "/swiggy/auth/register" || url.pathname === "/zepto-auth/register")) {
      const parsed = JSON.parse(bodyText || "{}");
      const id = `client_${url.pathname.includes("zepto") ? "zepto" : "swiggy"}_${registeredClients.size + 1}`;
      registeredClients.set(id, parsed);
      return sendJson(201, { client_id: id, redirect_uris: parsed.redirect_uris });
    }

    // Revocation
    if (req.method === "POST" && url.pathname === "/zepto-auth/revoke") {
      return sendJson(200, { revoked: true });
    }

    // Token endpoint
    if (req.method === "POST" && (url.pathname === "/swiggy/auth/token" || url.pathname === "/zepto-auth/token")) {
      const isSwiggy = url.pathname.startsWith("/swiggy");
      let params;
      if (String(req.headers["content-type"] || "").includes("application/json")) {
        params = JSON.parse(bodyText || "{}");
      } else {
        params = Object.fromEntries(new URLSearchParams(bodyText).entries());
      }

      if (params.grant_type === "refresh_token") {
        if (isSwiggy) {
          requireSwiggyRefresh = false;
          swiggyToken = "swiggy_tok_refreshed";
          return sendJson(200, {
            access_token: swiggyToken,
            refresh_token: "swiggy_refresh_2",
            token_type: "Bearer",
            expires_in: 432000
          });
        }
        zeptoToken = "zepto_tok_refreshed";
        return sendJson(200, {
          access_token: zeptoToken,
          refresh_token: "zepto_refresh_2",
          token_type: "Bearer",
          expires_in: 432000
        });
      }

      const expected = crypto.createHash("sha256").update(params.code_verifier || "").digest("base64url");
      const record = authCodes.get(params.code);
      if (!record || record.challenge !== expected) {
        return sendJson(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
      }
      authCodes.delete(params.code);

      return sendJson(200, {
        access_token: isSwiggy ? swiggyToken : zeptoToken,
        refresh_token: isSwiggy ? "swiggy_refresh_1" : "zepto_refresh_1",
        token_type: "Bearer",
        expires_in: 432000,
        scope: "mcp:tools"
      });
    }

    // Remote Streamable HTTP MCP endpoints (/swiggy/im, /swiggy/food, /zepto/mcp)
    if (req.method === "POST" && ["/swiggy/im", "/swiggy/food", "/zepto/mcp"].includes(url.pathname)) {
      const auth = String(req.headers.authorization || "");
      const isZepto = url.pathname === "/zepto/mcp";
      const expectedTok = isZepto ? zeptoToken : swiggyToken;
      if (auth !== `Bearer ${expectedTok}` || (!isZepto && requireSwiggyRefresh)) {
        return sendJson(401, { error: "unauthorized" });
      }

      const rpc = JSON.parse(bodyText || "{}");
      if (rpc.method === "notifications/initialized") {
        res.writeHead(202);
        return res.end();
      }
      if (rpc.method === "initialize") {
        return sendJson(
          200,
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } }
          },
          { "Mcp-Session-Id": "sess-123" }
        );
      }

      if (rpc.method === "tools/list") {
        const tools = isZepto
          ? [
              { name: "search_catalog", inputSchema: { properties: { query: { type: "string" } } } },
              { name: "get_cart", inputSchema: { properties: {} } },
              { name: "add_to_cart", inputSchema: { properties: { productVariantId: { type: "string" }, quantity: { type: "number" } } } }
            ]
          : url.pathname === "/swiggy/im"
          ? [
              { name: "get_addresses" },
              { name: "your_go_to_items" },
              { name: "search_products" },
              { name: "update_cart" },
              { name: "clear_cart" },
              { name: "get_cart" },
              { name: "get_payment_options" },
              { name: "checkout" },
              { name: "check_payment_status" },
              { name: "confirm_order" },
              { name: "get_delivery_status" }
            ]
          : [
              { name: "get_addresses" },
              { name: "search_restaurants" },
              { name: "get_restaurant_menu" },
              { name: "update_food_cart" },
              { name: "get_food_cart" },
              { name: "fetch_applicable_coupons" },
              { name: "apply_coupon" },
              { name: "get_payment_options" },
              { name: "place_food_order" },
              { name: "check_payment_status" },
              { name: "confirm_order" },
              { name: "track_food_order" }
            ];
        return sendJson(200, { jsonrpc: "2.0", id: rpc.id, result: { tools } });
      }

      if (rpc.method === "tools/call") {
        const { name, arguments: args = {} } = rpc.params || {};

        // Test SSE stream response for Zepto!
        if (isZepto) {
          let payload = {};
          if (name === "search_catalog") {
            payload = {
              products: [{ id: "zp-1", productVariantId: "zv-1", name: `Zepto ${args.query}`, formattedPacksize: "250 g", sellingPrice: 85, inStock: true }]
            };
          } else if (name === "add_to_cart" || name === "get_cart") {
            payload = { items: [{ id: "zv-1", name: "Zepto Miso", quantity: 1, price: 85 }], total: 85 };
          }
          const sseBody = `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
          })}\n\n`;
          res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sess-zepto" });
          return res.end(sseBody);
        }

        // Swiggy JSON structuredContent responses
        let structuredContent = {};
        if (name === "get_addresses") {
          structuredContent = {
            addresses: [{ id: "addr_1", addressCategory: "Home", addressLine: "12th Main Indiranagar" }],
            resolution: { defaultAddressId: "addr_1" }
          };
        } else if (name === "your_go_to_items") {
          structuredContent = {
            products: [
              {
                id: "gt_1",
                displayName: "GoTo Milk",
                variations: [{ spinId: "spin_gt1", skuId: "sku_gt1", displayName: "GoTo Milk 500 ml", quantityDescription: "500 ml", price: { offerPrice: 32 }, isInStockAndAvailable: true }]
              }
            ]
          };
        } else if (name === "search_products") {
          structuredContent = {
            products: [
              {
                id: "p1",
                displayName: args.query,
                variations: [{ spinId: "spin_1", skuId: "sku_1", displayName: `Organic ${args.query}`, quantityDescription: "200 g", price: { offerPrice: 120 }, isInStockAndAvailable: true }]
              }
            ]
          };
        } else if (name === "update_cart") {
          swiggyCartItems = args.items || [];
          const total = swiggyCartItems.reduce((s, it) => s + Number(it.quantity || 1) * 120, 0);
          structuredContent = { cart: { items: swiggyCartItems, billBreakdown: { toPay: { value: total } } } };
        } else if (name === "clear_cart") {
          swiggyCartItems = [];
          structuredContent = { items: [], billBreakdown: { toPay: { value: 0 } } };
        } else if (name === "get_cart") {
          const total = swiggyCartItems.reduce((s, it) => s + Number(it.quantity || 1) * 120, 0);
          structuredContent = { items: swiggyCartItems, billBreakdown: { toPay: { value: total } } };
        } else if (name === "get_payment_options") {
          structuredContent = {
            platforms: {
              desktop: { methods: [{ method: "UPI", label: "Scan UPI QR" }] },
              mobile: { methods: [{ method: "UPI", intentApp: "gpay", displayName: "GPay" }] }
            },
            cod: { available: true, paymentMethod: "COD" },
            swiggyMoney: { available: true, balance: 150, paymentMethod: "SwiggyPay" }
          };
        } else if (name === "checkout") {
          if (args.paymentMethod === "UPI" && args.generateUPIQR) {
            payPollCount = 0;
            structuredContent = {
              status: "PENDING_PAYMENT",
              orderId: "ORD-UPI-1",
              paasId: "PAAS-IM-1",
              transactionId: "TXN-IM-1",
              upiIntentUrl: "upi://pay?pa=swiggy@icici&pn=Swiggy&am=240.00&cu=INR&tr=TXN-IM-1",
              isQrFlow: true,
              pollingIntervalInMs: 1000,
              maxTimeToPollForInMs: 30000
            };
          } else {
            structuredContent = { orderId: "ORD-SW-1", status: "PLACED" };
          }
        } else if (name === "check_payment_status") {
          payPollCount += 1;
          structuredContent =
            payPollCount === 1
              ? { status: "pending", terminal: false, confirmed: false }
              : { status: "paid", terminal: true, confirmed: true };
        } else if (name === "confirm_order") {
          if (url.pathname === "/swiggy/im") lastImConfirmArgs = { ...args };
          else lastFoodConfirmArgs = { ...args };
          structuredContent = { orderId: args.orderId, status: "PLACED" };
        } else if (name === "get_delivery_status") {
          structuredContent = {
            orderId: args.orderId || "ORD-UPI-1",
            status: "ARRIVING",
            etaText: "8 mins",
            delivered: false,
            cancelled: false
          };
        } else if (name === "search_restaurants") {
          structuredContent = {
            restaurants: [{ id: "rest_1", name: "Noodle Atelier", rating: 4.6, slaString: "28 mins", availabilityStatus: "OPEN" }]
          };
        } else if (name === "get_restaurant_menu") {
          structuredContent = {
            categories: [{ title: "Pasta", items: [{ id: "dish_1", name: "Miso Rigatoni", price: 420, inStock: true }] }]
          };
        } else if (name === "update_food_cart") {
          foodCartState = { restaurantId: args.restaurantId, restaurantName: args.restaurantName, cartItems: args.cartItems, pricing: { to_pay: 420 } };
          structuredContent = { data: foodCartState };
        } else if (name === "get_food_cart") {
          structuredContent = { data: foodCartState || { cartItems: [], pricing: { to_pay: 0 } } };
        } else if (name === "place_food_order") {
          if (args.paymentMethod === "UPI") {
            payPollCount = 0;
            structuredContent = {
              status: "PENDING_PAYMENT",
              orderId: "ORD-FD-UPI-1",
              paasId: "PAAS-FD-1",
              addressId: args.addressId || "addr_1",
              cartId: "CART-FD-1",
              lat: 12.9716,
              lng: 77.5946,
              upiIntentUrl: "upi://pay?pa=swiggyfood@icici&am=420.00&cu=INR",
              isQrFlow: Boolean(args.generateUPIQR)
            };
          } else {
            structuredContent = { orderId: "FOOD-ORD-1", status: "PLACED" };
          }
        } else if (name === "track_food_order") {
          structuredContent = {
            orders: [{ orderId: args.orderId || "ORD-FD-UPI-1", orderStatus: "ON_THE_WAY", etaText: "22 mins" }]
          };
        }

        return sendJson(200, { jsonrpc: "2.0", id: rpc.id, result: { structuredContent } });
      }
    }

    sendJson(404, { error: "Unhandled mock route" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    issueAuthCode(authUrlStr) {
      const u = new URL(authUrlStr);
      const code = `code_${crypto.randomBytes(6).toString("hex")}`;
      authCodes.set(code, { challenge: u.searchParams.get("code_challenge") });
      return { code, state: u.searchParams.get("state") };
    },
    triggerSwiggy401() {
      requireSwiggyRefresh = true;
    },
    getLastImConfirmArgs: () => lastImConfirmArgs,
    getLastFoodConfirmArgs: () => lastFoodConfirmArgs,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("isAllowedCompanionOrigin and isOrderPlacementTool enforce strict security boundaries", () => {
  assert.equal(isAllowedCompanionOrigin("http://localhost:3456"), true);
  assert.equal(isAllowedCompanionOrigin("http://127.0.0.1:4000"), true);
  assert.equal(isAllowedCompanionOrigin("https://adityapdixit.me"), true);
  assert.equal(isAllowedCompanionOrigin("https://hootsworth.github.io"), true);

  assert.equal(isAllowedCompanionOrigin("https://adityapdixit.me.evil.com"), false);
  assert.equal(isAllowedCompanionOrigin("https://evil.example"), false);
  assert.equal(isAllowedCompanionOrigin("http://adityapdixit.me"), false);
  assert.equal(isAllowedCompanionOrigin("null"), false);

  assert.equal(isOrderPlacementTool("checkout"), true);
  assert.equal(isOrderPlacementTool("place_food_order"), true);
  assert.equal(isOrderPlacementTool("pay_now"), true);
  assert.equal(isOrderPlacementTool("search_products"), false);
});

test("MCP Companion handles CORS, OAuth PKCE flows, 401 refresh, cart merging, Blinkit stdio & real-order guard", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mise-mcp-test-"));
  const statePath = path.join(tmpDir, "mcp-state.json");
  const mockBlinkitScript = path.join(tmpDir, "mock-blinkit.mjs");

  // Fake Blinkit stdio script that mimics Python print(SERVE_SSE) => "False" on stdout before JSON-RPC!
  await fs.writeFile(
    mockBlinkitScript,
    `import readline from "node:readline";
process.stdout.write("False\\n");
let loggedIn = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result = {};
  if (msg.method === "initialize") {
    result = { protocolVersion: "2024-11-05", serverInfo: { name: "mock-blinkit", version: "1.0" } };
  } else if (msg.method === "tools/list") {
    result = { tools: [{ name: "check_login" }, { name: "login" }, { name: "enter_otp" }, { name: "search" }, { name: "add_to_cart" }, { name: "get_addresses" }, { name: "checkout" }] };
  } else if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params;
    let text = "";
    if (name === "check_login") text = loggedIn ? "Logged In" : "Not Logged In";
    else if (name === "login") text = "OTP sent to " + args.phone_number;
    else if (name === "enter_otp") { loggedIn = true; text = "Session saved successfully."; }
    else if (name === "get_addresses") text = "Saved Addresses:\\n[0] Home - 4th Block Koramangala";
    else if (name === "search") text = "Found 1 results:\\n[0] ID: bk-99 | Fresh " + args.query + " - ₹75";
    else if (name === "add_to_cart") text = "Added " + args.item_id;
    else if (name === "checkout") text = "Order placed";
    result = { content: [{ type: "text", text }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`,
    "utf8"
  );

  const remote = await startMockOAuthAndMcpServer();
  const appServer = createServer({
    mcpStatePath: statePath,
    mcpOptions: {
      providerOverrides: {
        swiggy: {
          metadataUrl: `${remote.baseUrl}/swiggy/.well-known/oauth-authorization-server`,
          authorizationEndpoint: `${remote.baseUrl}/swiggy/auth/authorize`,
          tokenEndpoint: `${remote.baseUrl}/swiggy/auth/token`,
          registrationEndpoint: `${remote.baseUrl}/swiggy/auth/register`,
          imUrl: `${remote.baseUrl}/swiggy/im`,
          foodUrl: `${remote.baseUrl}/swiggy/food`
        },
        zepto: {
          protectedResourceUrl: `${remote.baseUrl}/zepto/.well-known/oauth-protected-resource`,
          mcpUrl: `${remote.baseUrl}/zepto/mcp`
        }
      }
    }
  });

  await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  const { port } = appServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. CORS enforcement & Private Network header
    const okPreflight = await fetch(`${baseUrl}/api/mcp/status`, {
      method: "OPTIONS",
      headers: { Origin: "https://adityapdixit.me", "Access-Control-Request-Method": "GET" }
    });
    assert.equal(okPreflight.status, 204);
    assert.equal(okPreflight.headers.get("access-control-allow-origin"), "https://adityapdixit.me");
    assert.equal(okPreflight.headers.get("access-control-allow-private-network"), "true");

    const badOrigin = await fetch(`${baseUrl}/api/mcp/status`, {
      headers: { Origin: "https://adityapdixit.me.evil.com" }
    });
    assert.equal(badOrigin.status, 403);

    // 2. Initial status shows companion online + Zomato deep-link notice
    const st1 = await (await fetch(`${baseUrl}/api/mcp/status`)).json();
    assert.equal(st1.available, true);
    assert.equal(st1.providers.swiggy.connected, false);
    assert.equal(st1.providers.zomato.mode, "deeplink");

    // 3. Swiggy OAuth PKCE flow + 0600 file permissions
    const swStart = await (
      await fetch(`${baseUrl}/api/mcp/oauth/start/swiggy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://adityapdixit.me" },
        body: JSON.stringify({ openerOrigin: "https://adityapdixit.me" })
      })
    ).json();
    assert.match(swStart.redirectUri, /^http:\/\/localhost:/);
    const swGrant = remote.issueAuthCode(swStart.authUrl);
    const swCb = await fetch(
      `${baseUrl}/api/mcp/oauth/callback/swiggy?code=${encodeURIComponent(swGrant.code)}&state=${encodeURIComponent(swGrant.state)}`
    );
    assert.equal(swCb.status, 200);
    const swHtml = await swCb.text();
    assert.match(swHtml, /postMessage\(payload, targetOrigin\)/);
    assert.match(swHtml, /"https:\/\/adityapdixit\.me"/);

    const fileStat = await fs.stat(statePath);
    assert.equal(fileStat.mode & 0o777, 0o600);

    // 4. Swiggy Instamart addresses -> search -> merge cart -> trigger 401 refresh -> food search/menu/cart
    const addrs = await (
      await fetch(`${baseUrl}/api/mcp/groceries/addresses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im" })
      })
    ).json();
    assert.equal(addrs.addresses[0].id, "addr_1");

    const gSearch = await (
      await fetch(`${baseUrl}/api/mcp/groceries/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", query: "Miso" })
      })
    ).json();
    assert.equal(gSearch.items[0].spinId, "spin_1");

    const cart1 = await (
      await fetch(`${baseUrl}/api/mcp/groceries/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", action: "add", spinId: "spin_1", skuId: "sku_1", quantity: 1 })
      })
    ).json();
    assert.equal(cart1.items.length, 1);

    // Add second distinct SKU and confirm cart merge preserved first SKU
    const cart2 = await (
      await fetch(`${baseUrl}/api/mcp/groceries/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", action: "add", spinId: "spin_2", skuId: "sku_2", quantity: 1 })
      })
    ).json();
    assert.equal(cart2.items.length, 2);

    // Force 401 on remote Swiggy to test transparent token refresh + retry
    remote.triggerSwiggy401();
    const restaurants = await (
      await fetch(`${baseUrl}/api/mcp/food/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Miso Rigatoni" })
      })
    ).json();
    assert.equal(restaurants.restaurants[0].name, "Noodle Atelier");

    const menu = await (
      await fetch(`${baseUrl}/api/mcp/food/menu`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restaurantId: "rest_1", query: "Rigatoni" })
      })
    ).json();
    assert.equal(menu.items[0].name, "Miso Rigatoni");

    // 5. Zepto OAuth PKCE via `/callback` + SSE Streamable HTTP parsing
    const zStart = await (
      await fetch(`${baseUrl}/api/mcp/oauth/start/zepto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })
    ).json();
    assert.match(zStart.redirectUri, /\/callback$/);
    const zGrant = remote.issueAuthCode(zStart.authUrl);
    const zCb = await fetch(
      `${baseUrl}/callback?code=${encodeURIComponent(zGrant.code)}&state=${encodeURIComponent(zGrant.state)}`
    );
    assert.equal(zCb.status, 200);

    const zSearch = await (
      await fetch(`${baseUrl}/api/mcp/groceries/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "zepto", query: "Miso" })
      })
    ).json();
    assert.equal(zSearch.items[0].name, "Zepto Miso");

    // 6. Real order placement guard
    const unconfirmed = await fetch(`${baseUrl}/api/mcp/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "swiggy-im", tool: "checkout", args: { addressId: "addr_1", paymentMethod: "COD" } })
    });
    assert.equal(unconfirmed.status, 400);

    const confirmed = await (
      await fetch(`${baseUrl}/api/mcp/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "swiggy-im",
          tool: "checkout",
          args: { addressId: "addr_1", paymentMethod: "COD" },
          confirmedRealOrder: true
        })
      })
    ).json();
    assert.equal(confirmed.data.orderId, "ORD-SW-1");

    // 7. Blinkit config validation (400 instead of 500) + stdio client (ignores `False` line, supports Phone + OTP + search + disconnect)
    const blkEmpty = await fetch(`${baseUrl}/api/mcp/blinkit/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "stdio", repoPath: "" })
    });
    assert.equal(blkEmpty.status, 400);

    const blkMissing = await fetch(`${baseUrl}/api/mcp/blinkit/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "stdio", repoPath: path.join(tmpDir, "does-not-exist") })
    });
    assert.equal(blkMissing.status, 400);

    const blkCfg = await (
      await fetch(`${baseUrl}/api/mcp/blinkit/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "stdio",
          repoPath: tmpDir,
          command: process.execPath,
          args: ["mock-blinkit.mjs"]
        })
      })
    ).json();
    assert.equal(blkCfg.connected, true);
    assert.equal(blkCfg.loggedIn, false);

    const blkLogin = await (
      await fetch(`${baseUrl}/api/mcp/blinkit/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "9876543210" })
      })
    ).json();
    assert.match(blkLogin.message, /9876543210/);

    const blkOtp = await (
      await fetch(`${baseUrl}/api/mcp/blinkit/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp: "1234" })
      })
    ).json();
    assert.equal(blkOtp.loggedIn, true);

    const blkSearch = await (
      await fetch(`${baseUrl}/api/mcp/groceries/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "blinkit", query: "Tofu" })
      })
    ).json();
    assert.equal(blkSearch.items[0].id, "bk-99");
    assert.equal(blkSearch.items[0].name, "Fresh Tofu");

    // 8. Frequent Go-To groceries & cart set_qty / remove mutations
    const gotoRes = await (
      await fetch(`${baseUrl}/api/mcp/groceries/goto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im" })
      })
    ).json();
    assert.equal(gotoRes.items[0].name, "GoTo Milk 500 ml");

    const cartSetQty = await (
      await fetch(`${baseUrl}/api/mcp/groceries/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", action: "set_qty", spinId: "spin_2", skuId: "sku_2", quantity: 3 })
      })
    ).json();
    const spin2Item = cartSetQty.items.find((i) => i.spinId === "spin_2" || i.id === "sku_2");
    assert.equal(spin2Item.quantity, 3);

    const cartRemoved = await (
      await fetch(`${baseUrl}/api/mcp/groceries/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", action: "remove", spinId: "spin_2", skuId: "sku_2" })
      })
    ).json();
    assert.equal(cartRemoved.items.some((i) => i.spinId === "spin_2"), false);

    // 9. Payment options, 2-step confirmation guard, UPI QR PENDING_PAYMENT -> poll -> confirm_order & tracking (Instamart)
    const payOpts = await (
      await fetch(`${baseUrl}/api/mcp/payment/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im" })
      })
    ).json();
    assert.equal(payOpts.desktopQr[0].method, "UPI");
    assert.equal(payOpts.swiggyMoney.paymentMethod, "SwiggyPay");

    const payDenied = await fetch(`${baseUrl}/api/mcp/payment/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "swiggy-im", methodType: "upi_qr" })
    });
    assert.equal(payDenied.status, 400);

    const imUpiPay = await (
      await fetch(`${baseUrl}/api/mcp/payment/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", methodType: "upi_qr", confirmedRealOrder: true })
      })
    ).json();
    assert.equal(imUpiPay.status, "PENDING_PAYMENT");
    assert.equal(imUpiPay.paasId, "PAAS-IM-1");
    assert.match(imUpiPay.upiIntentUrl, /^upi:\/\/pay\?/);

    const poll1 = await (
      await fetch(`${baseUrl}/api/mcp/payment/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", orderId: imUpiPay.orderId, paasId: imUpiPay.paasId })
      })
    ).json();
    assert.equal(poll1.status, "pending");
    assert.equal(poll1.confirmed, false);

    const poll2 = await (
      await fetch(`${baseUrl}/api/mcp/payment/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", orderId: imUpiPay.orderId, paasId: imUpiPay.paasId })
      })
    ).json();
    assert.equal(poll2.status, "paid");
    assert.equal(poll2.terminal, true);
    assert.equal(poll2.confirmed, true);

    const imConfirm = await (
      await fetch(`${baseUrl}/api/mcp/payment/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "swiggy-im",
          orderId: imUpiPay.orderId,
          paasId: imUpiPay.paasId,
          transactionId: imUpiPay.transactionId
        })
      })
    ).json();
    assert.equal(imConfirm.status, "PLACED");
    assert.deepEqual(remote.getLastImConfirmArgs(), {
      orderId: "ORD-UPI-1",
      paasId: "PAAS-IM-1",
      transactionId: "TXN-IM-1"
    });

    const imTrack = await (
      await fetch(`${baseUrl}/api/mcp/orders/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-im", orderId: imConfirm.orderId })
      })
    ).json();
    assert.equal(imTrack.status, "ARRIVING");
    assert.equal(imTrack.etaText, "8 mins");

    // 10. Swiggy Food UPI checkout -> confirm_order must send addressId+lat+lng+cartId and omit paasId -> track_food_order
    const fdUpiPay = await (
      await fetch(`${baseUrl}/api/mcp/payment/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-food", methodType: "upi_qr", confirmedRealOrder: true })
      })
    ).json();
    assert.equal(fdUpiPay.status, "PENDING_PAYMENT");
    assert.equal(fdUpiPay.foodContext.cartId, "CART-FD-1");

    const fdConfirm = await (
      await fetch(`${baseUrl}/api/mcp/payment/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "swiggy-food",
          orderId: fdUpiPay.orderId,
          paasId: fdUpiPay.paasId,
          addressId: fdUpiPay.foodContext.addressId,
          cartId: fdUpiPay.foodContext.cartId,
          lat: fdUpiPay.foodContext.lat,
          lng: fdUpiPay.foodContext.lng
        })
      })
    ).json();
    assert.equal(fdConfirm.status, "PLACED");
    const lastFdArgs = remote.getLastFoodConfirmArgs();
    assert.equal("paasId" in lastFdArgs, false);
    assert.deepEqual(lastFdArgs, {
      orderId: "ORD-FD-UPI-1",
      addressId: "addr_1",
      lat: 12.9716,
      lng: 77.5946,
      cartId: "CART-FD-1"
    });

    const fdTrack = await (
      await fetch(`${baseUrl}/api/mcp/orders/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "swiggy-food", orderId: fdConfirm.orderId })
      })
    ).json();
    assert.equal(fdTrack.status, "ON_THE_WAY");
    assert.equal(fdTrack.etaText, "22 mins");
  } finally {
    await new Promise((resolve) => appServer.close(resolve));
    await remote.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Stateless Vercel bridge preserves OAuth PKCE & auth across cold instances via Cookie and X-Mise-Session", async () => {
  const remote = await startMockOAuthAndMcpServer();
  const providerOverrides = {
    swiggy: {
      metadataUrl: `${remote.baseUrl}/swiggy/.well-known/oauth-authorization-server`,
      authorizationEndpoint: `${remote.baseUrl}/swiggy/auth/authorize`,
      tokenEndpoint: `${remote.baseUrl}/swiggy/auth/token`,
      registrationEndpoint: `${remote.baseUrl}/swiggy/auth/register`,
      imUrl: `${remote.baseUrl}/swiggy/im`,
      foodUrl: `${remote.baseUrl}/swiggy/food`
    },
    zepto: {
      protectedResourceUrl: `${remote.baseUrl}/zepto/.well-known/oauth-protected-resource`,
      mcpUrl: `${remote.baseUrl}/zepto/mcp`
    }
  };
  const sessionSecret = "test-secret-32-bytes-minimum-key";

  const bridgeA = createMcpBridge({ storageMode: "stateless", sessionSecret, providerOverrides });
  const bridgeB = createMcpBridge({ storageMode: "stateless", sessionSecret, providerOverrides });

  const makeBridgeServer = (bridge) =>
    http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const handled = await bridge.handleRequest(req, res, url);
      if (!handled && !res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
    });

  const serverA = makeBridgeServer(bridgeA);
  const serverB = makeBridgeServer(bridgeB);

  const prevSecret = process.env.MISE_SESSION_SECRET;
  process.env.MISE_SESSION_SECRET = sessionSecret;
  const { default: vercelHandler } = await import("../api/[...route].mjs?stateless_test=1");
  const vercelServer = http.createServer((req, res) => vercelHandler(req, res));

  await Promise.all([
    new Promise((resolve) => serverA.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => serverB.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => vercelServer.listen(0, "127.0.0.1", resolve))
  ]);

  const baseA = `http://127.0.0.1:${serverA.address().port}`;
  const baseB = `http://127.0.0.1:${serverB.address().port}`;
  const baseV = `http://127.0.0.1:${vercelServer.address().port}`;

  try {
    // 1. Start OAuth on cold Instance A -> st1. encrypted PKCE state
    const startRes = await (
      await fetch(`${baseA}/api/mcp/oauth/start/swiggy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://adityapdixit.me" },
        body: JSON.stringify({ openerOrigin: "https://adityapdixit.me" })
      })
    ).json();
    assert.ok(startRes.state.startsWith("st1."), `Expected st1. state, got ${startRes.state}`);

    // 2. Complete OAuth callback on separate cold Instance B (redirect_uri was normalized to baseA's port, so rewrite query to serverB)
    const grant = remote.issueAuthCode(startRes.authUrl);
    const cbRes = await fetch(
      `${baseB}/api/mcp/oauth/callback/swiggy?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`
    );
    assert.equal(cbRes.status, 200);

    const setCookies = cbRes.headers.getSetCookie();
    const swiggyCookieHeader = setCookies.find((c) => c.startsWith("mise_mcp_swiggy="));
    assert.ok(swiggyCookieHeader, "Expected mise_mcp_swiggy Set-Cookie header");
    assert.match(swiggyCookieHeader, /HttpOnly/i);
    assert.equal(
      setCookies.some((c) => c.startsWith("mise_mcp_zepto=")),
      false,
      "Must not clear untouched Zepto cookie"
    );

    const cbHtml = await cbRes.text();
    const tokMatch = cbHtml.match(/"sessionToken":"([^"]+)"/);
    assert.ok(tokMatch?.[1], "Expected encrypted sessionToken inside popup postMessage payload");
    const sessionToken = tokMatch[1];

    // 3. Authenticate on Instance B with ONLY the HttpOnly Cookie
    const cookieStatus = await (
      await fetch(`${baseB}/api/mcp/status`, {
        headers: { Cookie: swiggyCookieHeader.split(";")[0] }
      })
    ).json();
    assert.equal(cookieStatus.mode, "vercel-stateless");
    assert.equal(cookieStatus.providers.blinkit.mode, "local-only");
    assert.equal(cookieStatus.providers.swiggy.connected, true);

    // 4. Authenticate on Instance B with ONLY X-Mise-Session header (third-party cookie fallback)
    const headerStatus = await (
      await fetch(`${baseB}/api/mcp/status`, {
        headers: { "X-Mise-Session": sessionToken }
      })
    ).json();
    assert.equal(headerStatus.mode, "vercel-stateless");
    assert.equal(headerStatus.providers.swiggy.connected, true);

    // 5. Verify api/[...route].mjs Vercel entrypoint /api/health
    const healthRes = await fetch(`${baseV}/api/health`, {
      headers: { Origin: "https://adityapdixit.me", "x-forwarded-proto": "https", "x-forwarded-host": "mise-api.vercel.app" }
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("access-control-allow-origin"), "https://adityapdixit.me");
    const health = await healthRes.json();
    assert.deepEqual(health, { ok: true, mode: "vercel-stateless", configured: true });
  } finally {
    if (prevSecret === undefined) delete process.env.MISE_SESSION_SECRET;
    else process.env.MISE_SESSION_SECRET = prevSecret;
    await Promise.all([
      new Promise((resolve) => serverA.close(resolve)),
      new Promise((resolve) => serverB.close(resolve)),
      new Promise((resolve) => vercelServer.close(resolve)),
      remote.close()
    ]);
  }
});

import { createMcpBridge, isAllowedCompanionOrigin } from "../mcp/bridge.mjs";

/**
 * Builds a Vercel Node.js serverless handler serving `/api/health`, `/api/mcp/*`, and `/callback`.
 */
export function createVercelHandler({ providerOverrides } = {}) {
  let cachedSecret = "";
  let cachedBridge = null;

  function getBridge(secret) {
    if (cachedBridge && cachedSecret === secret) {
      return cachedBridge;
    }
    cachedSecret = secret;
    cachedBridge = createMcpBridge({
      storageMode: "stateless",
      sessionSecret: secret,
      ...(providerOverrides ? { providerOverrides } : {})
    });
    return cachedBridge;
  }

  return async function handler(req, res) {
    const protoHeader = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
    const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim() || "localhost";
    const url = new URL(req.url || "/", `${protoHeader}://${hostHeader}`);

    if (url.searchParams.has("__path")) {
      const p = url.searchParams.get("__path") || "/";
      url.pathname = p.startsWith("/") ? p : `/${p}`;
      url.searchParams.delete("__path");
    }

    const selfOrigin = `${url.protocol}//${url.host}`;
    const origin = req.headers.origin || "";
    const corsOrigin = origin && isAllowedCompanionOrigin(origin, selfOrigin) ? origin : "";
    const secret = String(process.env.MISE_SESSION_SECRET || "").trim();

    if (url.pathname === "/api/health") {
      const body = JSON.stringify({
        ok: true,
        mode: "vercel-stateless",
        configured: Boolean(secret)
      });
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      if (corsOrigin) {
        headers["Access-Control-Allow-Origin"] = corsOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
        headers["Vary"] = "Origin";
      }
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    if (!secret) {
      const body = JSON.stringify({
        available: false,
        mode: "vercel-stateless",
        configured: false,
        error:
          "Set MISE_SESSION_SECRET in Vercel Project Settings → Environment Variables (run `openssl rand -hex 32`) and redeploy to activate Swiggy & Zepto MCP."
      });
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      if (corsOrigin) {
        headers["Access-Control-Allow-Origin"] = corsOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
        headers["Vary"] = "Origin";
      }
      res.writeHead(503, headers);
      res.end(body);
      return;
    }

    const bridge = getBridge(secret);
    const handled = await bridge.handleRequest(req, res, url);
    if (!handled && !res.writableEnded) {
      res.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  };
}

export default createVercelHandler();

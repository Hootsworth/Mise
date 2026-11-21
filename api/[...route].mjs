import { createMcpBridge, isAllowedCompanionOrigin } from "../mcp/bridge.mjs";

const secret = process.env.MISE_SESSION_SECRET || "";

const bridge = secret
  ? createMcpBridge({
      storageMode: "stateless",
      sessionSecret: secret
    })
  : null;

export default async function handler(req, res) {
  const protoHeader = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const url = new URL(req.url || "/", `${protoHeader}://${hostHeader}`);
  const origin = req.headers.origin || "";
  const corsOrigin = origin && isAllowedCompanionOrigin(origin) ? origin : "";

  if (url.pathname === "/api/health") {
    const body = JSON.stringify({
      ok: true,
      mode: "vercel-stateless",
      configured: Boolean(secret)
    });
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
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

  if (!bridge) {
    const errBody = JSON.stringify({
      error: "MISE_SESSION_SECRET environment variable is required on Vercel."
    });
    res.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(errBody);
    return;
  }

  const handled = await bridge.handleRequest(req, res, url);
  if (!handled && !res.writableEnded) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
}

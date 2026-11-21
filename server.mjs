import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpBridge } from "./mcp/bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

async function serveStatic(res, publicDir, pathname, method) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "Bad path" });
  }

  if (decodedPath.includes("\0")) {
    return sendJson(res, 400, { error: "Bad path" });
  }

  const rel = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const root = path.resolve(publicDir);
  const target = path.resolve(root, rel);

  if (target !== root && !target.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }

  const filePath = stat.isDirectory() ? path.join(target, "index.html") : target;
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isCodeAsset = ext === ".html" || ext === ".css" || ext === ".js" || ext === ".mjs";
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": content.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": isCodeAsset ? "no-cache" : "public, max-age=300"
    });
    res.end(method === "HEAD" ? undefined : content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

/**
 * Creates the static HTTP file server and Local MCP Companion bridge for Mise.
 */
export function createServer({ publicDir = DEFAULT_PUBLIC_DIR, mcpStatePath, mcpOptions = {} } = {}) {
  const mcpBridge = createMcpBridge({ statePath: mcpStatePath, ...mcpOptions });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/mcp/") || mcpBridge.canHandleCallback(url)) {
      const handled = await mcpBridge.handleRequest(req, res, url);
      if (handled) return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/favicon.ico") {
      const iconPath = path.join(path.resolve(publicDir), "favicon.svg");
      try {
        const content = await fs.readFile(iconPath);
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": content.length,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "public, max-age=300"
        });
        res.end(req.method === "HEAD" ? undefined : content);
      } catch {
        res.writeHead(204);
        res.end();
      }
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return await serveStatic(res, publicDir, url.pathname, req.method);
    }
    return sendJson(res, 405, { error: "Method not allowed." });
  });

  server.on("close", () => {
    mcpBridge.close().catch(() => {});
  });

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3456;
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Mise running at http://localhost:${port} (http://127.0.0.1:${port}) · Local MCP Companion active`);
  });
}

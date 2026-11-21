import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function expandHomePath(rawPath = "") {
  const s = String(rawPath || "").trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

function badRequestError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Parses Blinkit `search` stdout lines:
 * `[0] ID: abc123 | Amul Gold Milk 500ml - ₹34`
 */
export function parseBlinkitSearchResults(text) {
  const items = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/\[(\d+)\]\s*ID:\s*([^|]+)\|\s*(.+?)\s*-\s*([^\n]+)/);
    if (!m) continue;
    items.push({
      index: Number(m[1]),
      id: m[2].trim(),
      name: m[3].trim(),
      price: m[4].trim(),
      inStock: true
    });
  }
  return items;
}

/**
 * Parses Blinkit `get_addresses` stdout lines:
 * `[0] Home - 14th Main, Indiranagar, Bengaluru`
 */
export function parseBlinkitAddresses(text) {
  const addresses = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/\[(\d+)\]\s*([^-]+)-\s*(.+)/);
    if (!m) continue;
    addresses.push({
      index: Number(m[1]),
      id: m[1],
      label: m[2].trim(),
      details: m[3].trim(),
      isDefault: Number(m[1]) === 0
    });
  }
  return addresses;
}

function normalizeToolText(result) {
  if (!result || typeof result !== "object") return String(result || "");
  if (result.isError) {
    const errText = Array.isArray(result.content)
      ? result.content.map((c) => c?.text || "").filter(Boolean).join("\n")
      : "Blinkit MCP tool failed";
    throw new Error(errText);
  }
  if (Array.isArray(result.content)) {
    return result.content
      .filter((c) => c?.type === "text" || typeof c?.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Pure Node MCP client for `hereisSwapnil/blinkit-mcp` over stdio (`uv run main.py`) or local SSE.
 */
export function createBlinkitClient({ spawnImpl = spawn, fetchImpl = fetch } = {}) {
  let child = null;
  let mode = "stdio";
  let initialized = false;
  let nextRpcId = 1;
  let stdoutBuf = "";
  let stderrTail = "";
  const pending = new Map();

  // SSE state (when mode === "sse")
  let ssePostUrl = "";
  let sseAbort = null;
  let sseEndpoint = "";

  function rejectAllPending(err) {
    for (const [, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleJsonLine(line) {
    const trimmed = String(line || "").trim();
    // Critical guard: blinkit-mcp src/server.py executes `print(SERVE_SSE)` emitting non-JSON stdout lines like `False`
    if (!trimmed.startsWith("{")) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || `Blinkit MCP error ${msg.error.code}`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  function sendStdioRpc(method, params, timeoutMs = 45000, isNotification = false) {
    if (!child || !child.stdin || child.killed) {
      return Promise.reject(new Error("Blinkit stdio process is not running."));
    }
    const id = isNotification ? undefined : nextRpcId++;
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params !== undefined ? { params } : {})
    });

    if (isNotification) {
      child.stdin.write(frame + "\n");
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Blinkit MCP request timed out after ${timeoutMs}ms (${method}).`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(frame + "\n");
    });
  }

  async function openSseStream(url) {
    sseAbort?.abort();
    sseAbort = new AbortController();
    ssePostUrl = "";
    const res = await fetchImpl(url, {
      headers: { Accept: "text/event-stream" },
      signal: sseAbort.signal
    });
    if (!res.ok || !res.body) {
      throw new Error(`Could not connect to Blinkit SSE at ${url} (HTTP ${res.status}).`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resolveEndpoint;
    const endpointPromise = new Promise((resolve) => {
      resolveEndpoint = resolve;
    });

    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
            let evType = "message";
            const dataLines = [];
            for (const ln of rawEvent.split(/\r?\n/)) {
              if (ln.startsWith("event:")) evType = ln.slice(6).trim();
              else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trimStart());
            }
            const dataStr = dataLines.join("\n").trim();
            if (!dataStr) continue;
            if (evType === "endpoint") {
              ssePostUrl = new URL(dataStr, url).toString();
              resolveEndpoint(ssePostUrl);
            } else if (dataStr.startsWith("{")) {
              handleJsonLine(dataStr);
            }
          }
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          rejectAllPending(err);
        }
      }
    })();

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for Blinkit SSE endpoint event.")), 10000)
    );
    await Promise.race([endpointPromise, timeout]);
  }

  async function sendSseRpc(method, params, timeoutMs = 90000, isNotification = false) {
    if (!ssePostUrl) {
      throw new Error("Blinkit SSE connection is not active.");
    }
    const id = isNotification ? undefined : nextRpcId++;
    const payload = {
      jsonrpc: "2.0",
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params !== undefined ? { params } : {})
    };

    const waiter = isNotification
      ? Promise.resolve(null)
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Blinkit SSE call timed out after ${timeoutMs}ms (${method}).`));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
        });

    const postRes = await fetchImpl(ssePostUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!postRes.ok) {
      if (id !== undefined) {
        const entry = pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(id);
        }
      }
      throw new Error(`Blinkit SSE POST failed (${postRes.status}).`);
    }
    return await waiter;
  }

  async function sendRpc(method, params, timeoutMs = 90000, isNotification = false) {
    return mode === "sse"
      ? await sendSseRpc(method, params, timeoutMs, isNotification)
      : await sendStdioRpc(method, params, timeoutMs, isNotification);
  }

  async function connect(config = {}) {
    await disconnect();
    mode = config.mode === "sse" ? "sse" : "stdio";
    initialized = false;

    if (mode === "sse") {
      sseEndpoint = String(config.sseUrl || "http://127.0.0.1:8000/sse").trim();
      let parsedUrl;
      try {
        parsedUrl = new URL(sseEndpoint);
      } catch {
        throw badRequestError(`Invalid Blinkit SSE URL: ${sseEndpoint}`);
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw badRequestError(`Blinkit SSE URL must use http:// or https://: ${sseEndpoint}`);
      }
      await openSseStream(sseEndpoint);
    } else {
      const repoPath = expandHomePath(config.repoPath);
      if (!repoPath) {
        throw badRequestError(
          "Enter the local path to your cloned blinkit-mcp folder first (for example ~/blinkit-mcp)."
        );
      }
      if (!fs.existsSync(repoPath)) {
        throw badRequestError(`Blinkit MCP path does not exist: ${repoPath}`);
      }
      const cmd = config.command || "uv";
      const args = Array.isArray(config.args) && config.args.length ? config.args : ["run", "main.py"];
      stderrTail = "";
      stdoutBuf = "";

      child = spawnImpl(cmd, args, {
        cwd: path.resolve(repoPath),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HEADLESS: config.headless === false ? "false" : "true"
        }
      });

      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        let nl;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleJsonLine(line);
        }
      });

      child.stderr?.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1200);
      });

      child.on("error", (err) => {
        initialized = false;
        const msg =
          err?.code === "ENOENT"
            ? `${cmd} was not found in PATH — install uv and run \`uv sync\` inside ${repoPath}.`
            : `Could not start ${cmd} in ${repoPath}: ${err.message}`;
        const outErr = err?.code === "ENOENT" ? badRequestError(msg) : new Error(msg);
        rejectAllPending(outErr);
      });

      child.on("exit", (code) => {
        initialized = false;
        child = null;
        rejectAllPending(new Error(`Blinkit MCP process exited (${code ?? "signal"}). ${stderrTail}`.trim()));
      });
    }

    await sendRpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mise-companion", version: "1.0.0" }
      },
      30000
    );
    await sendRpc("notifications/initialized", {}, 5000, true);
    initialized = true;
    return true;
  }

  async function disconnect() {
    initialized = false;
    sseAbort?.abort();
    sseAbort = null;
    ssePostUrl = "";
    rejectAllPending(new Error("Blinkit MCP disconnected."));

    if (child && !child.killed) {
      const proc = child;
      child = null;
      await new Promise((resolve) => {
        const force = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Ignore
          }
          resolve();
        }, 1200);
        proc.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
        try {
          proc.kill("SIGTERM");
        } catch {
          clearTimeout(force);
          resolve();
        }
      });
    }
  }

  function isRunning() {
    return initialized && (mode === "sse" ? Boolean(ssePostUrl) : Boolean(child && !child.killed));
  }

  async function listTools() {
    const res = await sendRpc("tools/list", {}, 20000);
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async function callTool(name, args = {}, { timeoutMs = 90000 } = {}) {
    const res = await sendRpc("tools/call", { name, arguments: args || {} }, timeoutMs);
    return {
      raw: res,
      text: normalizeToolText(res)
    };
  }

  return {
    connect,
    disconnect,
    isRunning,
    listTools,
    callTool
  };
}

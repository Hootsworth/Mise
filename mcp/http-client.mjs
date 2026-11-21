/**
 * Extracts structured payload from an MCP CallToolResult.
 * Follows Swiggy Builders guidance: prefer structuredContent, then JSON-parsed text content.
 */
export function extractToolData(result) {
  if (!result || typeof result !== "object") return { text: "" };
  if (result.isError) {
    const errText = Array.isArray(result.content)
      ? result.content.map((c) => c?.text || "").filter(Boolean).join("\n")
      : "";
    throw new Error(errText || "MCP tool returned an error.");
  }

  const sc = result.structuredContent;
  if (sc && typeof sc === "object" && Object.keys(sc).length > 0) {
    return sc;
  }

  const textBlocks = Array.isArray(result.content)
    ? result.content.filter((c) => c?.type === "text" || typeof c?.text === "string").map((c) => c.text)
    : [];
  const combined = textBlocks.join("\n").trim();
  if (!combined) return {};

  try {
    const parsed = JSON.parse(combined);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Non-JSON text tool response
  }
  return { text: combined };
}

function parseSseMessages(rawText, targetId) {
  const blocks = String(rawText || "").split(/\r?\n\r?\n/);
  const envelopes = [];
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    const joined = dataLines.join("\n").trim();
    if (!joined || joined === "[DONE]") continue;
    try {
      const msg = JSON.parse(joined);
      envelopes.push(msg);
      if (targetId !== undefined && msg?.id === targetId) {
        return msg;
      }
    } catch {
      // Ignore partial / non-JSON SSE keepalives
    }
  }
  if (envelopes.length) {
    return envelopes[envelopes.length - 1];
  }
  return null;
}

/**
 * Pure Node Streamable HTTP MCP JSON-RPC 2.0 client (supports JSON + SSE responses and 401 token refresh).
 */
export function createHttpMcpClient({ fetchImpl = fetch } = {}) {
  const sessions = new Map(); // endpoint -> { sessionId, initialized }
  let nextRpcId = 1;

  function clearSession(endpoint) {
    if (endpoint) sessions.delete(endpoint);
    else sessions.clear();
  }

  async function postJsonRpc(endpoint, accessToken, payload, sessionId = "") {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`
    };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const returnedSessionId = res.headers.get("mcp-session-id") || sessionId || "";
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const rawText = await res.text();

    let rpcMsg = null;
    if (contentType.includes("text/event-stream")) {
      rpcMsg = parseSseMessages(rawText, payload.id);
    } else if (rawText.trim()) {
      try {
        rpcMsg = JSON.parse(rawText);
      } catch {
        rpcMsg = parseSseMessages(rawText, payload.id);
      }
    }

    if (res.status === 401 || rpcMsg?.error?.code === -32001) {
      const err = new Error(rpcMsg?.error?.message || "Unauthorized MCP request (401)");
      err.status = 401;
      err.rpcCode = rpcMsg?.error?.code;
      throw err;
    }

    if (!res.ok) {
      const err = new Error(rpcMsg?.error?.message || `MCP HTTP ${res.status}: ${rawText.slice(0, 240)}`);
      err.status = res.status;
      throw err;
    }

    if (rpcMsg?.error) {
      const err = new Error(rpcMsg.error.message || `MCP RPC error ${rpcMsg.error.code}`);
      err.rpcCode = rpcMsg.error.code;
      throw err;
    }

    return {
      result: rpcMsg?.result ?? null,
      sessionId: returnedSessionId
    };
  }

  async function initialize(endpoint, accessToken) {
    const cached = sessions.get(endpoint);
    if (cached?.initialized) return cached.sessionId;

    const initId = nextRpcId++;
    const initRes = await postJsonRpc(
      endpoint,
      accessToken,
      {
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mise-companion", version: "1.0.0" }
        }
      },
      ""
    );

    const sessionId = initRes.sessionId || "";
    sessions.set(endpoint, { sessionId, initialized: true });

    try {
      await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });
    } catch {
      // Some servers omit response or treat notification gracefully
    }

    return sessionId;
  }

  async function runWithReauth(endpoint, initialToken, onUnauthorized, runner) {
    let token = initialToken;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await runner(token);
      } catch (err) {
        if (attempt === 0 && (err?.status === 401 || err?.rpcCode === -32001) && typeof onUnauthorized === "function") {
          clearSession(endpoint);
          token = await onUnauthorized();
          continue;
        }
        throw err;
      }
    }
  }

  async function listTools(endpoint, accessToken, { onUnauthorized } = {}) {
    return await runWithReauth(endpoint, accessToken, onUnauthorized, async (token) => {
      const sessionId = await initialize(endpoint, token);
      const rpcRes = await postJsonRpc(
        endpoint,
        token,
        {
          jsonrpc: "2.0",
          id: nextRpcId++,
          method: "tools/list",
          params: {}
        },
        sessionId
      );
      if (rpcRes.sessionId) {
        sessions.set(endpoint, { sessionId: rpcRes.sessionId, initialized: true });
      }
      return Array.isArray(rpcRes.result?.tools) ? rpcRes.result.tools : [];
    });
  }

  async function callTool(endpoint, accessToken, name, args = {}, { onUnauthorized } = {}) {
    return await runWithReauth(endpoint, accessToken, onUnauthorized, async (token) => {
      const sessionId = await initialize(endpoint, token);
      const rpcRes = await postJsonRpc(
        endpoint,
        token,
        {
          jsonrpc: "2.0",
          id: nextRpcId++,
          method: "tools/call",
          params: {
            name,
            arguments: args || {}
          }
        },
        sessionId
      );
      if (rpcRes.sessionId) {
        sessions.set(endpoint, { sessionId: rpcRes.sessionId, initialized: true });
      }
      return {
        raw: rpcRes.result,
        data: extractToolData(rpcRes.result)
      };
    });
  }

  return {
    initialize,
    listTools,
    callTool,
    clearSession
  };
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PENDING_TTL_MS = 10 * 60 * 1000;

export function createDefaultMcpState() {
  return {
    swiggy: {
      clientId: "",
      clientSecret: "",
      redirectUri: "",
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      scope: "",
      grantedAt: 0,
      selectedAddressId: ""
    },
    zepto: {
      clientId: "",
      clientSecret: "",
      redirectUri: "",
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      scope: "",
      grantedAt: 0
    },
    blinkit: {
      mode: "stdio",
      repoPath: "",
      sseUrl: "http://127.0.0.1:8000/sse",
      command: "uv",
      args: ["run", "main.py"],
      loggedIn: false
    }
  };
}

/**
 * Persistent MCP token & config store (mode 0600) with in-memory single-use PKCE state tracking.
 */
export function createMcpStore({ statePath } = {}) {
  const resolvedPath = statePath || path.join(os.homedir(), ".mise", "mcp-state.json");
  const pendingAuth = new Map();
  let stateCache = null;

  function mergeDefaults(parsed) {
    const defaults = createDefaultMcpState();
    if (!parsed || typeof parsed !== "object") return defaults;
    return {
      swiggy: { ...defaults.swiggy, ...(parsed.swiggy || {}) },
      zepto: { ...defaults.zepto, ...(parsed.zepto || {}) },
      blinkit: {
        ...defaults.blinkit,
        ...(parsed.blinkit || {}),
        args: Array.isArray(parsed.blinkit?.args) ? [...parsed.blinkit.args] : [...defaults.blinkit.args]
      }
    };
  }

  async function load() {
    if (stateCache) return stateCache;
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      stateCache = mergeDefaults(JSON.parse(raw));
    } catch {
      stateCache = createDefaultMcpState();
    }
    return stateCache;
  }

  async function save(nextState = stateCache) {
    const merged = mergeDefaults(nextState);
    stateCache = merged;
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});

    const tmpPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(merged, null, 2);
    await fs.writeFile(tmpPath, serialized, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tmpPath, 0o600).catch(() => {});
    await fs.rename(tmpPath, resolvedPath);
    await fs.chmod(resolvedPath, 0o600).catch(() => {});
    return merged;
  }

  async function getProvider(id) {
    const all = await load();
    const defaults = createDefaultMcpState();
    return structuredClone(all[id] || defaults[id] || {});
  }

  async function setProvider(id, patch) {
    const all = await load();
    const defaults = createDefaultMcpState();
    const base = all[id] || defaults[id] || {};
    all[id] = { ...base, ...patch };
    await save(all);
    return structuredClone(all[id]);
  }

  async function clearProvider(id) {
    const all = await load();
    const defaults = createDefaultMcpState();
    if (!Object.hasOwn(defaults, id)) return null;
    all[id] = defaults[id];
    await save(all);
    return structuredClone(all[id]);
  }

  function prunePendingAuth() {
    const now = Date.now();
    for (const [k, entry] of pendingAuth.entries()) {
      if (!entry || now - entry.createdAt > PENDING_TTL_MS) {
        pendingAuth.delete(k);
      }
    }
  }

  function putPendingAuth(stateKey, data) {
    prunePendingAuth();
    pendingAuth.set(stateKey, { ...data, createdAt: Date.now() });
  }

  function takePendingAuth(stateKey) {
    prunePendingAuth();
    const entry = pendingAuth.get(stateKey);
    pendingAuth.delete(stateKey);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > PENDING_TTL_MS) return null;
    return entry;
  }

  function hasPendingAuth(stateKey) {
    prunePendingAuth();
    return pendingAuth.has(stateKey);
  }

  return {
    statePath: resolvedPath,
    load,
    save,
    getProvider,
    setProvider,
    clearProvider,
    putPendingAuth,
    takePendingAuth,
    hasPendingAuth
  };
}

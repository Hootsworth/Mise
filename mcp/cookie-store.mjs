import crypto from "node:crypto";
import { createDefaultMcpState } from "./store.mjs";

const PENDING_TTL_MS = 10 * 60 * 1000;
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const COOKIE_NAMES = {
  swiggy: "mise_mcp_swiggy",
  zepto: "mise_mcp_zepto"
};

/**
 * Derives a fixed 256-bit symmetric key from a server secret string.
 */
export function deriveKey(secret) {
  const s = String(secret || "");
  if (!s) {
    throw new Error("Session secret is required for stateless MCP storage.");
  }
  return crypto.createHash("sha256").update(s).digest();
}

function toKeyBuffer(keyOrSecret) {
  return Buffer.isBuffer(keyOrSecret) && keyOrSecret.length === 32 ? keyOrSecret : deriveKey(keyOrSecret);
}

/**
 * Authenticates and encrypts JSON payloads using AES-256-GCM (IV[12] + AuthTag[16] + Ciphertext).
 */
export function encryptPayload(obj, keyOrSecret) {
  const key = toKeyBuffer(keyOrSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

/**
 * Decrypts and verifies an AES-256-GCM base64url token, returning null on tampering or invalid input.
 */
export function decryptPayload(token, keyOrSecret) {
  if (!token || typeof token !== "string") return null;
  try {
    const key = toKeyBuffer(keyOrSecret);
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader = "") {
  const out = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function serializeCookie(
  name,
  value,
  { httpOnly = true, secure = false, sameSite = "Lax", path = "/", maxAge } = {}
) {
  const parts = [`${name}=${encodeURIComponent(value || "")}`, `Path=${path}`];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join("; ");
}

export function isStatelessPendingState(state) {
  return typeof state === "string" && state.startsWith("st1.") && state.length > 36;
}

function compactProviderRecord(rec, defaults) {
  const merged = { ...defaults, ...(rec || {}) };
  return {
    clientId: merged.clientId || "",
    clientSecret: merged.clientSecret || "",
    redirectUri: merged.redirectUri || "",
    accessToken: merged.accessToken || "",
    refreshToken: merged.refreshToken || "",
    expiresAt: merged.expiresAt || 0,
    scope: merged.scope || "",
    grantedAt: merged.grantedAt || 0,
    ...(Object.hasOwn(defaults, "selectedAddressId") ? { selectedAddressId: merged.selectedAddressId || "" } : {}),
    updatedAt: merged.updatedAt || merged.grantedAt || 0
  };
}

function hasAnyAuthData(rec) {
  return Boolean(rec && (rec.accessToken || rec.refreshToken || rec.clientId));
}

function pickFresher(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
}

/**
 * Creates a per-request stateless encrypted cookie & header store compatible with `createMcpStore`.
 */
export function createStatelessRequestStore({ req, res, secret, secure = false } = {}) {
  const key = deriveKey(secret);
  const cookies = parseCookies(req?.headers?.cookie || "");
  const headerToken = String(req?.headers?.["x-mise-session"] || "").trim();
  const headerBundle = headerToken ? decryptPayload(headerToken, key) : null;

  let stateCache = null;
  const dirtyProviders = new Set();

  function loadSync() {
    if (stateCache) return stateCache;
    const defaults = createDefaultMcpState();
    const cookieSwiggy = cookies[COOKIE_NAMES.swiggy] ? decryptPayload(cookies[COOKIE_NAMES.swiggy], key) : null;
    const cookieZepto = cookies[COOKIE_NAMES.zepto] ? decryptPayload(cookies[COOKIE_NAMES.zepto], key) : null;

    const swiggy = pickFresher(cookieSwiggy, headerBundle?.swiggy);
    const zepto = pickFresher(cookieZepto, headerBundle?.zepto);

    stateCache = {
      swiggy: compactProviderRecord(swiggy, defaults.swiggy),
      zepto: compactProviderRecord(zepto, defaults.zepto),
      blinkit: { ...defaults.blinkit }
    };
    return stateCache;
  }

  function getEncodedSessionToken() {
    const s = loadSync();
    const payload = {};
    if (hasAnyAuthData(s.swiggy)) payload.swiggy = s.swiggy;
    if (hasAnyAuthData(s.zepto)) payload.zepto = s.zepto;
    if (!payload.swiggy && !payload.zepto) return "";
    return encryptPayload(payload, key);
  }

  function writeResponseHeaders() {
    if (!res || res.headersSent) return;
    const s = loadSync();
    const sameSite = secure ? "None" : "Lax";
    const setCookies = [];

    for (const pid of dirtyProviders) {
      if (pid !== "swiggy" && pid !== "zepto") continue;
      const name = COOKIE_NAMES[pid];
      if (hasAnyAuthData(s[pid])) {
        setCookies.push(
          serializeCookie(name, encryptPayload(s[pid], key), {
            httpOnly: true,
            secure,
            sameSite,
            path: "/",
            maxAge: COOKIE_MAX_AGE_SEC
          })
        );
      } else {
        setCookies.push(
          serializeCookie(name, "", {
            httpOnly: true,
            secure,
            sameSite,
            path: "/",
            maxAge: 0
          })
        );
      }
    }

    if (setCookies.length) {
      res.setHeader("Set-Cookie", setCookies);
    }
    const token = getEncodedSessionToken();
    res.setHeader("X-Mise-Session", token || "cleared");
  }

  async function load() {
    return loadSync();
  }

  async function save(nextState = stateCache) {
    const defaults = createDefaultMcpState();
    if (dirtyProviders.size === 0) {
      dirtyProviders.add("swiggy");
      dirtyProviders.add("zepto");
    }
    stateCache = {
      swiggy: compactProviderRecord(nextState?.swiggy, defaults.swiggy),
      zepto: compactProviderRecord(nextState?.zepto, defaults.zepto),
      blinkit: { ...defaults.blinkit }
    };
    writeResponseHeaders();
    return stateCache;
  }

  async function getProvider(id) {
    const all = loadSync();
    const defaults = createDefaultMcpState();
    return structuredClone(all[id] || defaults[id] || {});
  }

  async function setProvider(id, patch) {
    if (id !== "swiggy" && id !== "zepto") return null;
    const all = loadSync();
    const defaults = createDefaultMcpState();
    dirtyProviders.add(id);
    all[id] = compactProviderRecord({ ...all[id], ...patch, updatedAt: Date.now() }, defaults[id]);
    await save(all);
    return structuredClone(all[id]);
  }

  async function clearProvider(id) {
    if (id !== "swiggy" && id !== "zepto") return null;
    const all = loadSync();
    const defaults = createDefaultMcpState();
    dirtyProviders.add(id);
    all[id] = compactProviderRecord({}, defaults[id]);
    await save(all);
    return structuredClone(all[id]);
  }

  function createPendingState(data) {
    const compact = {
      p: data.providerId,
      v: data.codeVerifier,
      r: data.redirectUri,
      c: data.clientId,
      ...(data.clientSecret ? { cs: data.clientSecret } : {}),
      o: data.openerOrigin,
      t: data.tokenEndpoint,
      ts: Date.now()
    };
    return `st1.${encryptPayload(compact, key)}`;
  }

  function decodeState(state) {
    if (!isStatelessPendingState(state)) return null;
    const raw = decryptPayload(state.slice(4), key);
    if (!raw || !raw.p || !raw.v || !raw.ts) return null;
    if (Date.now() - Number(raw.ts) > PENDING_TTL_MS) return null;
    return {
      providerId: raw.p,
      codeVerifier: raw.v,
      redirectUri: raw.r,
      clientId: raw.c,
      clientSecret: raw.cs || "",
      openerOrigin: raw.o || "",
      tokenEndpoint: raw.t || "",
      createdAt: raw.ts
    };
  }

  return {
    isStateless: true,
    load,
    save,
    getProvider,
    setProvider,
    clearProvider,
    createPendingState,
    putPendingAuth() {},
    takePendingAuth(state) {
      return decodeState(state);
    },
    hasPendingAuth(state) {
      return Boolean(decodeState(state));
    },
    getEncodedSessionToken
  };
}

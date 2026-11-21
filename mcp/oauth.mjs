import crypto from "node:crypto";

export const OAUTH_PROVIDERS = {
  swiggy: {
    id: "swiggy",
    label: "Swiggy (Instamart & Food)",
    metadataUrl: "https://mcp.swiggy.com/.well-known/oauth-authorization-server",
    authorizationEndpoint: "https://mcp.swiggy.com/auth/authorize",
    tokenEndpoint: "https://mcp.swiggy.com/auth/token",
    registrationEndpoint: "https://mcp.swiggy.com/auth/register",
    revocationEndpoint: "",
    defaultScope: "mcp:tools mcp:resources",
    tokenContentType: "json",
    callbackPath: "/api/mcp/oauth/callback/swiggy",
    imUrl: "https://mcp.swiggy.com/im",
    foodUrl: "https://mcp.swiggy.com/food"
  },
  zepto: {
    id: "zepto",
    label: "Zepto",
    protectedResourceUrl: "https://mcp.zepto.co.in/.well-known/oauth-protected-resource",
    metadataUrl: "https://auth.zepto.co.in/.well-known/oauth-authorization-server",
    authorizationEndpoint: "https://auth.zepto.co.in/authorize",
    tokenEndpoint: "https://auth.zepto.co.in/token",
    registrationEndpoint: "https://auth.zepto.co.in/register",
    revocationEndpoint: "https://auth.zepto.co.in/revoke",
    defaultScope:
      "tools:read tools:write dev.ucp.shopping.cart:manage dev.ucp.shopping.catalog.search:read dev.ucp.shopping.catalog.lookup:read dev.ucp.common.location.search:read dev.ucp.common.location.lookup:read dev.ucp.shopping.order:manage dev.ucp.shopping.checkout:manage",
    tokenContentType: "form",
    callbackPath: "/callback",
    mcpUrl: "https://mcp.zepto.co.in/mcp"
  }
};

function toBase64Url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Generates an RFC 7636 PKCE S256 verifier/challenge pair and CSRF state token.
 */
export function generatePkcePair() {
  const codeVerifier = toBase64Url(crypto.randomBytes(32));
  const codeChallenge = toBase64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = toBase64Url(crypto.randomBytes(24));
  return { codeVerifier, codeChallenge, state };
}

function getProviderMetaConfig(providerId, overrides = {}) {
  const base = OAUTH_PROVIDERS[providerId];
  if (!base) {
    throw new Error(`Unsupported OAuth provider: ${providerId}`);
  }
  const ov = overrides?.[providerId] || {};
  return { ...base, ...ov };
}

async function safeReadJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function discoverOAuthMetadata(providerId, { fetchImpl = fetch, overrides = {} } = {}) {
  const cfg = getProviderMetaConfig(providerId, overrides);
  let metadataUrl = cfg.metadataUrl || "";
  let resourceScopes = [];

  if (cfg.protectedResourceUrl) {
    try {
      const prRes = await fetchImpl(cfg.protectedResourceUrl);
      if (prRes.ok) {
        const pr = await prRes.json();
        if (Array.isArray(pr?.scopes_supported)) {
          resourceScopes = pr.scopes_supported;
        }
        if (Array.isArray(pr?.authorization_servers) && pr.authorization_servers[0] && !overrides?.[providerId]?.metadataUrl) {
          const authBase = String(pr.authorization_servers[0]).replace(/\/+$/, "");
          metadataUrl = `${authBase}/.well-known/oauth-authorization-server`;
        }
      }
    } catch {
      // Fall back to static defaults
    }
  }

  let serverMeta = {};
  if (metadataUrl) {
    try {
      const metaRes = await fetchImpl(metadataUrl);
      if (metaRes.ok) {
        serverMeta = (await metaRes.json()) || {};
      }
    } catch {
      // Fall back to static defaults
    }
  }

  const ov = overrides?.[providerId] || {};
  const scopesSupported =
    Array.isArray(serverMeta.scopes_supported) && serverMeta.scopes_supported.length
      ? serverMeta.scopes_supported
      : resourceScopes;

  return {
    providerId,
    authorizationEndpoint: ov.authorizationEndpoint || serverMeta.authorization_endpoint || cfg.authorizationEndpoint,
    tokenEndpoint: ov.tokenEndpoint || serverMeta.token_endpoint || cfg.tokenEndpoint,
    registrationEndpoint: ov.registrationEndpoint || serverMeta.registration_endpoint || cfg.registrationEndpoint,
    revocationEndpoint: ov.revocationEndpoint || serverMeta.revocation_endpoint || cfg.revocationEndpoint || "",
    scopesSupported,
    defaultScope: scopesSupported.length ? scopesSupported.join(" ") : cfg.defaultScope
  };
}

function buildLoopbackRedirectUri(providerId, baseOrigin) {
  const cfg = OAUTH_PROVIDERS[providerId];
  const parsed = new URL(baseOrigin || "http://localhost:3456");
  // Normalize http://127.0.0.1 -> http://localhost so Swiggy/Zepto allowlists match consistently
  if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") {
    parsed.hostname = "localhost";
  }
  const normalizedBase = `${parsed.protocol}//${parsed.host}`;
  return `${normalizedBase}${cfg.callbackPath}`;
}

async function registerDynamicClient({ providerId, meta, redirectUri, store, fetchImpl }) {
  const existing = await store.getProvider(providerId);
  if (existing.clientId && existing.redirectUri === redirectUri) {
    return {
      clientId: existing.clientId,
      clientSecret: existing.clientSecret || ""
    };
  }

  if (!meta.registrationEndpoint) {
    throw new Error(`No registration endpoint configured for ${providerId}.`);
  }

  const regPayload = {
    client_name: "Mise Kitchen Companion",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  };

  let regRes;
  try {
    regRes = await fetchImpl(meta.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(regPayload)
    });
  } catch (err) {
    const netErr = new Error(
      `Could not reach ${OAUTH_PROVIDERS[providerId].label} over the network (${err?.message || "fetch failed"}). Ensure the Mise companion process has outbound internet access.`
    );
    netErr.status = 502;
    throw netErr;
  }

  const data = await safeReadJson(regRes);
  if (!regRes.ok || !data?.client_id) {
    const desc = data?.error_description || data?.error || data?.message || `HTTP ${regRes.status}`;
    const zeptoHint =
      providerId === "zepto"
        ? " Note: Zepto whitelists http://localhost/callback; ensure no conflicting custom client registration is blocking it."
        : "";
    throw new Error(`${OAUTH_PROVIDERS[providerId].label} client registration failed (${desc}).${zeptoHint}`);
  }

  const creds = {
    clientId: String(data.client_id),
    clientSecret: data.client_secret ? String(data.client_secret) : "",
    redirectUri
  };
  await store.setProvider(providerId, creds);
  return creds;
}

export async function startOAuthFlow({
  providerId,
  baseOrigin,
  openerOrigin = "",
  store,
  fetchImpl = fetch,
  overrides = {}
}) {
  const cfg = getProviderMetaConfig(providerId, overrides);
  const meta = await discoverOAuthMetadata(providerId, { fetchImpl, overrides });
  const redirectUri = buildLoopbackRedirectUri(providerId, baseOrigin);
  const { clientId, clientSecret } = await registerDynamicClient({
    providerId,
    meta,
    redirectUri,
    store,
    fetchImpl
  });

  const { codeVerifier, codeChallenge, state: randomState } = generatePkcePair();
  const scope = cfg.defaultScope || meta.defaultScope;
  const pendingPayload = {
    providerId,
    codeVerifier,
    redirectUri,
    clientId,
    clientSecret,
    openerOrigin: openerOrigin || baseOrigin,
    tokenEndpoint: meta.tokenEndpoint
  };
  const state =
    typeof store.createPendingState === "function"
      ? store.createPendingState(pendingPayload)
      : (store.putPendingAuth(randomState, pendingPayload), randomState);

  const authUrl = new URL(meta.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  if (scope) authUrl.searchParams.set("scope", scope);

  return {
    providerId,
    authUrl: authUrl.toString(),
    redirectUri,
    state
  };
}

async function postTokenRequest(tokenEndpoint, paramsObj, preferMode, fetchImpl) {
  const tryRequest = async (mode) => {
    const isJson = mode === "json";
    const body = isJson
      ? JSON.stringify(paramsObj)
      : new URLSearchParams(
          Object.entries(paramsObj)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => [k, String(v)])
        ).toString();
    let res;
    try {
      res = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body
      });
    } catch (err) {
      const netErr = new Error(
        `Could not reach OAuth token server over the network (${err?.message || "fetch failed"}).`
      );
      netErr.status = 502;
      throw netErr;
    }
    const data = await safeReadJson(res);
    return { res, data };
  };

  let attempt = await tryRequest(preferMode);
  if (attempt.res.status === 415) {
    attempt = await tryRequest(preferMode === "json" ? "form" : "json");
  }
  return attempt;
}

export async function completeOAuthCallback({
  providerId,
  code,
  state,
  error,
  errorDescription,
  store,
  fetchImpl = fetch,
  overrides = {}
}) {
  if (!state) {
    throw new Error("Missing OAuth state parameter.");
  }

  const pending = store.takePendingAuth(state);
  if (!pending) {
    throw new Error("OAuth session expired or invalid state. Please start sign-in again.");
  }

  const resolvedProvider = providerId || pending.providerId;
  if (pending.providerId !== resolvedProvider) {
    throw new Error("OAuth provider mismatch.");
  }

  if (error) {
    const err = new Error(errorDescription || error);
    err.openerOrigin = pending.openerOrigin;
    err.providerId = resolvedProvider;
    throw err;
  }

  if (!code) {
    const err = new Error("Missing authorization code from provider.");
    err.openerOrigin = pending.openerOrigin;
    err.providerId = resolvedProvider;
    throw err;
  }

  const cfg = getProviderMetaConfig(resolvedProvider, overrides);
  const tokenEndpoint = pending.tokenEndpoint || cfg.tokenEndpoint;
  const payload = {
    grant_type: "authorization_code",
    code,
    code_verifier: pending.codeVerifier,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId
  };
  if (pending.clientSecret) {
    payload.client_secret = pending.clientSecret;
  }

  const { res, data } = await postTokenRequest(tokenEndpoint, payload, cfg.tokenContentType, fetchImpl);
  if (!res.ok || !data?.access_token) {
    const msg = data?.error_description || data?.error || `Token exchange failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.openerOrigin = pending.openerOrigin;
    err.providerId = resolvedProvider;
    throw err;
  }

  const now = Date.now();
  const expiresInSec = Number(data.expires_in);
  const expiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0 ? now + expiresInSec * 1000 : now + 432000 * 1000;

  await store.setProvider(resolvedProvider, {
    clientId: pending.clientId,
    clientSecret: pending.clientSecret || "",
    redirectUri: pending.redirectUri,
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : "",
    expiresAt,
    scope: data.scope ? String(data.scope) : cfg.defaultScope,
    grantedAt: now
  });

  return {
    providerId: resolvedProvider,
    openerOrigin: pending.openerOrigin,
    expiresAt,
    scope: data.scope ? String(data.scope) : cfg.defaultScope
  };
}

export async function refreshAccessToken({
  providerId,
  store,
  fetchImpl = fetch,
  overrides = {}
}) {
  const cfg = getProviderMetaConfig(providerId, overrides);
  const saved = await store.getProvider(providerId);
  if (!saved?.refreshToken) {
    throw new Error(`${cfg.label} session expired. Please sign in again.`);
  }

  const meta = await discoverOAuthMetadata(providerId, { fetchImpl, overrides });
  const payload = {
    grant_type: "refresh_token",
    refresh_token: saved.refreshToken
  };
  if (saved.clientId) payload.client_id = saved.clientId;
  if (saved.clientSecret) payload.client_secret = saved.clientSecret;

  const { res, data } = await postTokenRequest(meta.tokenEndpoint, payload, cfg.tokenContentType, fetchImpl);
  if (!res.ok || !data?.access_token) {
    await store.setProvider(providerId, { accessToken: "", refreshToken: "", expiresAt: 0 });
    const desc = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new Error(`${cfg.label} session refresh failed (${desc}). Please sign in again.`);
  }

  const now = Date.now();
  const expiresInSec = Number(data.expires_in);
  const expiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0 ? now + expiresInSec * 1000 : now + 2592000 * 1000;

  const updated = await store.setProvider(providerId, {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : saved.refreshToken,
    expiresAt,
    scope: data.scope ? String(data.scope) : saved.scope
  });

  return updated.accessToken;
}

export async function ensureValidAccessToken({
  providerId,
  store,
  fetchImpl = fetch,
  overrides = {}
}) {
  const saved = await store.getProvider(providerId);
  const cfg = getProviderMetaConfig(providerId, overrides);
  if (!saved?.accessToken) {
    throw new Error(`${cfg.label} is not connected. Sign in first.`);
  }
  if (saved.expiresAt && saved.expiresAt - Date.now() <= 60_000) {
    if (saved.refreshToken) {
      return await refreshAccessToken({ providerId, store, fetchImpl, overrides });
    }
    throw new Error(`${cfg.label} token expired. Please sign in again.`);
  }
  return saved.accessToken;
}

export async function revokeAndClearProvider({
  providerId,
  store,
  fetchImpl = fetch,
  overrides = {}
}) {
  const cfg = getProviderMetaConfig(providerId, overrides);
  const saved = await store.getProvider(providerId);
  if (cfg.revocationEndpoint && (saved?.refreshToken || saved?.accessToken)) {
    try {
      const meta = await discoverOAuthMetadata(providerId, { fetchImpl, overrides });
      if (meta.revocationEndpoint) {
        const token = saved.refreshToken || saved.accessToken;
        await fetchImpl(meta.revocationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            ...(saved.clientId ? { client_id: saved.clientId } : {})
          }).toString()
        });
      }
    } catch {
      // Clear local credentials even if remote revocation fails
    }
  }
  return await store.clearProvider(providerId);
}

import fs from "node:fs";
import path from "node:path";

export const PUBLIC_PROVIDERS = [
  { id: "gemini", label: "Google Gemini", envVar: "GEMINI_API_KEY", supportsImages: true },
  { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", supportsImages: true },
  { id: "claude", label: "Anthropic Claude", envVar: "ANTHROPIC_API_KEY", supportsImages: false },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", supportsImages: true },
  { id: "ollama", label: "Local Ollama", envVar: "OLLAMA_HOST", supportsImages: false }
];

/**
 * Loads environment variables from a `.env` file without overwriting existing
 * `process.env` values.
 */
export function loadEnv(envPath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf8");
  const loaded = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded[key] = val;
    }
  }
  return loaded;
}

/**
 * Returns the public provider availability catalog for clients.
 * Never exposes API keys, model identifiers, or private hosts.
 */
export function getPublicProviderCatalog(env = process.env) {
  const providers = PUBLIC_PROVIDERS.map((p) => {
    const configured =
      p.id === "ollama"
        ? Boolean(env.OLLAMA_HOST?.trim() || env.OLLAMA_MODEL?.trim())
        : Boolean(env[p.envVar]?.trim());
    return {
      id: p.id,
      label: p.label,
      configured,
      supportsImages: p.supportsImages
    };
  });

  const explicit = String(env.DEFAULT_PROVIDER || "").toLowerCase().trim();
  const explicitMatch = providers.find((p) => p.id === explicit && p.configured);
  const firstConfigured = providers.find((p) => p.configured);
  const defaultProvider = explicitMatch?.id || firstConfigured?.id || "gemini";

  const imgMode = String(env.IMAGE_PROVIDER || "auto").toLowerCase().trim();
  const imageGenerationAvailable = imgMode !== "off";

  return {
    defaultProvider,
    imageGenerationAvailable,
    providers
  };
}

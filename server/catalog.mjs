export const PUBLIC_PROVIDERS = [
  { id: "gemini", label: "Google Gemini", envVar: "GEMINI_API_KEY", supportsImages: true },
  { id: "meta", label: "Meta AI", envVar: "META_API_KEY", altEnvVar: "MODEL_API_KEY", supportsImages: true },
  { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", supportsImages: true },
  { id: "claude", label: "Anthropic Claude", envVar: "ANTHROPIC_API_KEY", supportsImages: false },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", supportsImages: true },
  { id: "ollama", label: "Local Ollama", envVar: "OLLAMA_HOST", supportsImages: false }
];

/**
 * Returns the public provider availability catalog for clients.
 * Pure runtime helper (zero Node-only imports) so Cloudflare Workers & Node share it cleanly.
 */
export function getPublicProviderCatalog(env = {}) {
  const providers = PUBLIC_PROVIDERS.map((p) => {
    const configured =
      p.id === "ollama"
        ? Boolean(env.OLLAMA_HOST?.trim() || env.OLLAMA_MODEL?.trim())
        : Boolean(env[p.envVar]?.trim() || (p.altEnvVar && env[p.altEnvVar]?.trim()));
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
  const aiImageGenerationAvailable =
    imgMode !== "off" &&
    imgMode !== "open" &&
    imgMode !== "wikimedia" &&
    providers.some((p) => p.supportsImages && p.configured);

  return {
    defaultProvider,
    imageGenerationAvailable,
    aiImageGenerationAvailable,
    providers
  };
}

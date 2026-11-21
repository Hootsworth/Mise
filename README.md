# Mise — Editorial AI Recipe Maker

A minimalist black-and-white AI recipe maker with live streaming typesetting, editorial dish photography, a **Dish Options Grid** for *"what I have"* / *"with ingredient X"* discovery, inline ingredient swaps & mid-cook rescue advice, and a hands-free fullscreen **Cook Mode**. Zero external npm dependencies.

## Running Locally

```bash
npm start
```

Open `http://127.0.0.1:3456`.

## Server Secrets & GitHub Secrets

All API keys and model selections live strictly on the server (via environment variables / GitHub Secrets or a local `.env` file). In the UI, users only choose which configured AI provider they want to use — keys and model names are never sent to or stored in the browser.

### Environment Variables / GitHub Secrets

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DEFAULT_PROVIDER` | Preferred initial provider (`gemini`, `meta`, `openai`, `claude`, `openrouter`, `ollama`) | First configured provider |
| `IMAGE_PROVIDER` | Dish image backend (`auto`, `gemini`, `meta`, `openai`, `openrouter`, `wikimedia`, `off`) | `auto` |
| `GEMINI_API_KEY` | Google Gemini API key | — |
| `GEMINI_MODEL` | Gemini text/vision model | `gemini-2.5-flash` |
| `GEMINI_IMAGE_MODEL` | Gemini image generation model | `gemini-2.5-flash-image` |
| `META_API_KEY` | Meta Model API key (`MODEL_API_KEY` also accepted) | — |
| `META_MODEL` | Meta text/vision model | `muse-spark-1.3` |
| `META_IMAGE_MODEL` | Meta image generation model | `muse-image-1.0` |
| `META_BASE_URL` | Optional Meta Model API base URL | `https://api.meta.ai/v1` |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `OPENAI_MODEL` | OpenAI text/vision model | `gpt-4.1-mini` |
| `OPENAI_IMAGE_MODEL` | OpenAI image generation model | `gpt-image-1` |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | — |
| `ANTHROPIC_MODEL` | Anthropic Claude model | `claude-sonnet-4-20250514` |
| `OPENROUTER_API_KEY` | OpenRouter API key | — |
| `OPENROUTER_MODEL` | OpenRouter text/vision model | `google/gemini-2.5-flash` |
| `OPENROUTER_IMAGE_MODEL` | OpenRouter image generation model | `bytedance-seed/seedream-4.5` |
| `OLLAMA_HOST` | Optional local Ollama host (loopback only, e.g. `http://127.0.0.1:11434`) | — |
| `OLLAMA_MODEL` | Optional local Ollama model | `llama3.2` |

## Testing

```bash
npm test
```

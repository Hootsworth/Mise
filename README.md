# Mise — Editorial AI Recipe Maker

A minimalist black-and-white AI recipe maker with live streaming typesetting, open-first dish photography (with opt-in AI image generation), a **Dish Options Grid** for *"what I have"* / *"with ingredient X"* discovery, inline ingredient swaps & mid-cook rescue advice, and a hands-free fullscreen **Cook Mode**. Zero external npm dependencies.

## Running Locally

```bash
npm start
```

Open `http://127.0.0.1:3456`.

## GitHub Pages + Cloudflare Worker Deployment

GitHub Pages serves static HTML/CSS/JS only and cannot safely hold private API keys. Mise solves this with [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

1. **GitHub Pages** deploys the static UI cleanly under any subpath (e.g., `/Mise/`). Sample recipes, Cook Mode, and open food photography work out of the box even in static-only mode.
2. **Cloudflare Worker (`worker/index.mjs`)** runs the exact same API endpoints (`/api/health`, `/api/ideas`, `/api/dish-image`, `/api/generate`, `/api/revise`, `/api/apply-swap`, `/api/ingredient-intel`, `/api/step-help`, `/api/enrich`) using your encrypted **GitHub Secrets** synced automatically via Wrangler, so visitors only pick a provider while secrets stay hidden on the edge.

### Setup Steps (GitHub Settings → Secrets and variables → Actions)

1. Ensure **Settings → Pages → Build and deployment → Source** is set to **GitHub Actions**.
2. Add your Cloudflare deployment secrets (free tier works great):
   - `CLOUDFLARE_API_TOKEN` (API token with **Edit Cloudflare Workers** permissions)
   - `CLOUDFLARE_ACCOUNT_ID`
   - *(Optional)* `MISE_API_URL` if you bind a custom domain to the Worker instead of the auto-captured `*.workers.dev` URL
3. Add whichever AI provider keys & models you want enabled as GitHub Secrets:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DEFAULT_PROVIDER` | Preferred initial provider (`gemini`, `meta`, `openai`, `claude`, `openrouter`, `ollama`) | First configured provider |
| `IMAGE_PROVIDER` | Controls automatic photos (`auto`, `open`, `off`) | `auto` (open endpoints default; AI opt-in) |
| `ALLOWED_ORIGINS` | Optional comma-separated extra allowed CORS origins | `adityapdixit.me`, `hootsworth.github.io`, `localhost` |
| `GEMINI_API_KEY` | Google Gemini API key | — |
| `GEMINI_MODEL` | Gemini text/vision model | `gemini-2.5-flash` |
| `GEMINI_IMAGE_MODEL` | Gemini opt-in image model | `gemini-2.5-flash-image` |
| `META_API_KEY` | Meta Model API key (`MODEL_API_KEY` also accepted) | — |
| `META_MODEL` | Meta text/vision model | `muse-spark-1.3` |
| `META_IMAGE_MODEL` | Meta opt-in image model | `muse-image-1.0` |
| `META_BASE_URL` | Optional Meta Model API base URL | `https://api.meta.ai/v1` |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `OPENAI_MODEL` | OpenAI text/vision model | `gpt-4.1-mini` |
| `OPENAI_IMAGE_MODEL` | OpenAI opt-in image model | `gpt-image-1` |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | — |
| `ANTHROPIC_MODEL` | Anthropic Claude model | `claude-sonnet-4-20250514` |
| `OPENROUTER_API_KEY` | OpenRouter API key | — |
| `OPENROUTER_MODEL` | OpenRouter text/vision model | `google/gemini-2.5-flash` |
| `OPENROUTER_IMAGE_MODEL` | OpenRouter opt-in image model | `bytedance-seed/seedream-4.5` |
| `OLLAMA_HOST` | Local Node server only: Ollama loopback URL | — |
| `OLLAMA_MODEL` | Local Node server only: Ollama model | `llama3.2` |

## Dish Photography Policy (Open-First, AI Opt-In)

By default, Mise fetches dish photos from free, zero-key open endpoints (**Openverse -> Wikimedia Commons -> TheMealDB -> Wikipedia**) with attribution credits and `New photo` cycling. Generating custom AI dish photos is strictly **opt-in**:
- Toggle **AI-generated photos** inside **Choose Provider**, or
- Click **Generate with AI** directly on an individual recipe's hero photograph (when a server AI image provider is configured).

## Testing

```bash
npm test
```

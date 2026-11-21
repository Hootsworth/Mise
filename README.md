# Mise — Bring Your Own AI Recipe Atelier

A monochrome, black-and-white editorial recipe workbench built as a 100% static web app with zero backend proxies and zero dependencies. Configure any supported AI provider, custom endpoint, model ID, temperature, dish photography preference, and Kitchen Profile directly in the full-screen **Settings** page — all keys and preferences stay exclusively in your browser's `localStorage`.

## Architecture

Mise deploys cleanly to **GitHub Pages** (`public/`) via GitHub Actions with no Cloudflare Workers or server secrets required:

- **Direct Browser BYOK (`public/js/ai-client.js`)**: Talks directly from your browser to:
  - **OpenRouter** (full browser CORS across Gemini, Claude, OpenAI, Llama, DeepSeek)
  - **Anthropic Claude** (uses `anthropic-dangerous-direct-browser-access: true`)
  - **Google Gemini** (`generativelanguage.googleapis.com/v1beta`)
  - **OpenAI** (`api.openai.com/v1`)
  - **Meta AI** (`https://api.meta.ai/v1` or custom base URL)
  - **Local Ollama** (`http://127.0.0.1:11434`, set `OLLAMA_ORIGINS="*"` when calling from GitHub Pages)
  - **Custom API** (any OpenAI-compatible `/v1` endpoint such as Groq, Together, Fireworks, LM Studio, or LiteLLM)
- **Full-Screen Settings Page (`public/js/settings-view.js`)**:
  - **AI & Models**: Switch providers, enter API keys with unmask toggle, set custom endpoints, type or pick models from presets or **Fetch live models**, tune temperature, and run **Test connection**.
  - **Photography**: Uses free **Open web photography** by default (**Openverse → Wikimedia Commons → TheMealDB → Wikipedia**), with an opt-in switch and model picker for AI-generated dish imagery.
  - **Kitchen Profile**: Persistent dietary rules, strict allergies, skill level, metric/US defaults, cookware, pantry staples, and house style notes applied to every prompt.
  - **Data**: Local storage counters and 2-step inline controls to clear keys, history, or all data.

## Local Development & Tests

```sh
# Run unit & static server tests (Node 22+, zero npm dependencies)
npm test

# Start local static server at http://127.0.0.1:3456
npm start
```

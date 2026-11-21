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
  - **Delivery & MCP**: Configure default grocery & restaurant apps, inspect app permissions, and manage Local MCP Companion connections.
  - **Data**: Local storage counters and 2-step inline controls to clear keys, history, or all data.

## Grocery & Restaurant Ordering (Hybrid)

Mise pairs static smart ordering on GitHub Pages with an optional **Local MCP Companion** (`npm start`) when running locally:

- **Static GitHub Pages (Zero Setup):**
  - Every recipe includes an **Order** action and an **Order missing** bar synced with checked ingredients and your Kitchen Profile pantry staples.
  - Launches one-click search deep-links into **Swiggy Instamart**, **Zepto**, **Blinkit**, **Swiggy Food**, and **Zomato**.
- **Local MCP Companion (`npm start` at `http://localhost:3456`):**
  - **Swiggy MCP (`/im` & `/food`)**: Official OAuth 2.1 + PKCE sign-in, live address lookup, Instamart product search & cart management, plus Swiggy Food nearby restaurant search, menus & coupons.
  - **Zepto MCP**: Official OAuth 2.1 + PKCE sign-in via whitelisted loopback `/callback`, catalog search & live cart building.
  - **Blinkit Unofficial MCP (`hereisSwapnil/blinkit-mcp`)**: Connect your local Python `uv` / Playwright server over `stdio` or SSE, complete phone + OTP login inside Settings, search live stock, and build carts.
  - **Zomato**: Remains a one-click Smart Deep-Link because Zomato's official MCP restricts OAuth redirect URIs to 6 approved clients.
  - Real-money order placement calls are blocked by a server-side guard until you explicitly confirm inside the 2-step review prompt.

## Local Development & Tests

```sh
# Run unit, companion & server tests (Node 22+, zero npm dependencies)
npm test

# Start Mise + Local MCP Companion at http://localhost:3456
npm start
```

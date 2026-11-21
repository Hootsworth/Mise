# Mise — Bring Your Own AI Recipe Atelier

A monochrome, black-and-white editorial recipe workbench with client-side BYOK AI streaming and an integrated zero-DB MCP delivery backend hosted cleanly on Vercel. Configure any supported AI provider, custom endpoint, model ID, temperature, dish photography preference, and Kitchen Profile directly in the full-screen **Settings** page — all API keys and recipe history stay exclusively in your browser's `localStorage`.

## Architecture

Mise runs as a **zero-dependency Vercel full-stack app** (`public/` static frontend + `api/index.mjs` serverless backend on the same origin, with `vercel.json`):

- **Direct Browser BYOK (`public/js/ai-client.js`)**: Talks directly from your browser to:
  - **OpenRouter** (full browser CORS across Gemini, Claude, OpenAI, Llama, DeepSeek)
  - **Anthropic Claude** (uses `anthropic-dangerous-direct-browser-access: true`)
  - **Google Gemini** (`generativelanguage.googleapis.com/v1beta`)
  - **OpenAI** (`api.openai.com/v1`)
  - **Meta AI** (`https://api.meta.ai/v1` or custom base URL)
  - **Local Ollama** (`http://127.0.0.1:11434`, set `OLLAMA_ORIGINS="*"` when calling from a hosted Vercel domain)
  - **Custom API** (any OpenAI-compatible `/v1` endpoint such as Groq, Together, Fireworks, LM Studio, or LiteLLM)
- **Full-Screen Settings Page (`public/js/settings-view.js`)**:
  - **AI & Models**: Switch providers, enter API keys with unmask toggle, set custom endpoints, type or pick models from presets or **Fetch live models**, tune temperature, and run **Test connection**.
  - **Photography**: Uses free **Open web photography** by default (**Openverse → Wikimedia Commons → TheMealDB → Wikipedia**), with an opt-in switch and model picker for AI-generated dish imagery.
  - **Kitchen Profile**: Persistent dietary rules, strict allergies, skill level, metric/US defaults, cookware, pantry staples, and house style notes applied to every prompt.
  - **Delivery & MCP**: Configure default grocery & restaurant apps, inspect app permissions, view live OAuth callback URLs for your deployment, and manage Swiggy, Zepto & optional local Blinkit connections.
  - **Data**: Local storage counters and 2-step inline controls to clear keys, history, or all data.

## Vercel Hosting & Stateless MCP Backend (`$0/mo`, Zero DB)

Mise hosts both the frontend (`outputDirectory: "public"`) and the serverless MCP backend (`api/index.mjs`) on the same Vercel origin using `vercel.json` rewrites (`/api/health`, `/api/mcp/*`, `/callback`):

1. Deploy this repository on [Vercel](https://vercel.com/new) (or run `npx vercel`).
2. In **Vercel Project Settings → Environment Variables**, configure:
   - `MISE_SESSION_SECRET` — required AES-256-GCM key (`openssl rand -hex 32`) used to encrypt provider sessions into `HttpOnly` cookies / `X-Mise-Session` headers and sign stateless `st1.` OAuth PKCE `state` parameters.
   - `MISE_ALLOWED_ORIGINS` — optional comma-separated extra frontend origins (same-origin requests on any `*.vercel.app` preview, production domain, or custom domain work automatically).
3. Submit your deployed HTTPS callback URLs for allowlisting before signing in:
   - Swiggy MCP (`/access` on Swiggy Builders): `https://<your-vercel-domain>/api/mcp/oauth/callback/swiggy`
   - Zepto MCP (`zeptonow/mcp` issue / allowlist): `https://<your-vercel-domain>/callback`

## Grocery & Restaurant Ordering, UPI QR & Live Tracking

When connected to the Vercel backend (or `npm start` locally), Mise upgrades delivery ordering into an end-to-end commerce workbench:

- **Groceries & Restaurants**: Live Swiggy Instamart, Zepto, and Swiggy Food catalogs with thumbnails, `− / qty / +` cart steppers, Swiggy frequent go-to quick reorders (`your_go_to_items`), itemized bills, and Swiggy Food coupons.
- **In-Mise Payment & UPI QR**: Renders only merchant-returned payment options (`get_payment_options`), guards real-money orders behind an explicit 2-step confirmation (`confirmedRealOrder === true`), displays an offline SVG UPI QR code on desktop alongside UPI app intent links, polls `check_payment_status` on `PENDING_PAYMENT`, and calls `confirm_order` before reporting success.
- **Live Order Tracking**: Polls live Swiggy Instamart (`get_delivery_status`), Swiggy Food (`track_food_order`), and Zepto order status inside the **Cart & Pay** sheet and header pill.
- **Local-Only / Deep-Link Providers**:
  - **Blinkit (`hereisSwapnil/blinkit-mcp`)**: Uses local Python/Playwright stdio execution (`Local Only` on Vercel); run `npm start` locally and optionally set **Backend URL override** to `http://localhost:3456`.
  - **Zomato**: Remains a one-click Smart Deep-Link because Zomato's official MCP restricts OAuth redirect URIs to 6 approved clients.

## Local Development & Tests

```sh
# Run unit, companion & Vercel handler tests (Node 22+, zero npm dependencies)
npm test

# Start Mise + Local MCP Companion at http://localhost:3456
npm start
```

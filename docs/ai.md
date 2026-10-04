# AI (Phase 10)

Everything AI-related is optional, provider-swappable and labelled honestly.
With no keys configured the store runs in **test mode**: the designer says so
and produces a placeholder pattern, and search uses a simple word-matching
index. Nothing is pretended.

## What it does

| Feature | Where | How |
|---|---|---|
| **Describe it** — turn a sentence into artwork | Custom Designer, step 4 | `POST /api/ai-generate` → provider image model → stored privately as the customer's design asset |
| **Remove background** | Designer: after generating (checkbox) and for any selected image | In the browser (free): flood-fills a plain background from the edges, keeps enclosed areas, soft edge |
| **Meaning-based search** | `/search` | `GET /api/ai-search` embeds the query and calls `search_products_smart` (pgvector cosine + keywords). Falls back to keywords if the provider is down |
| **Recommendations** | Product page ("You might also like"), bag ("Goes well with"), home ("Picked for you", signed in) | Database functions on the store's own orders, same-visit views, wishlists, collections — no outside service |
| **Forecast** | Admin → Analytics → Forecast | `analytics_forecast`: days of stock left and reorder quantities per SKU, partner blank run-out, live drop sell-out ETA, weekly demand |
| **Image descriptions for moderators** | Design moderation | Optional vision caption added to the findings; risky words send the design to a person. Never approves on its own |
| **Admin AI page** | Admin → Analytics → AI | Switches and daily limits, usage, search-index status, log of every request (including refused ones) with thumbnails |

## Provider

`netlify/lib/ai.mjs` is the only file that talks to an AI provider.

| Provider | Chosen when | Models (defaults) |
|---|---|---|
| `cloudflare` — Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN` are set | images `@cf/black-forest-labs/flux-1-schnell`, search `@cf/baai/bge-small-en-v1.5` (384-d), descriptions `@cf/llava-hf/llava-1.5-7b-hf` |
| `mock` — test mode | no keys, or `AI_PROVIDER=mock` | labelled pattern, word-hash vectors, no descriptions |

Cloudflare's free tier is about 10,000 "neurons" a day — enough for a few
hundred quick (4-step) images plus search. The store-wide daily limit in
admin protects it; when it's used up, customers are told to try tomorrow or
upload their own artwork.

### Turning it on

1. Sign up (free) at dash.cloudflare.com and open **AI → Workers AI**.
2. Choose **Use REST API** → **Create a Workers AI API Token** → **Create API Token** →
   **Copy API Token** (shown only once). Copy the **Account ID** from the same page.
   (A custom token needs *Workers AI – Read* and *Workers AI – Edit*.)
3. Netlify → Site configuration → Environment variables: add
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN`, then redeploy.
4. Within the hour `scheduled-ai` re-indexes every product with the real
   embedding model (products indexed by another model are always redone).

To change provider later, add a branch in `ai.mjs` (`generateImage`, `embed`,
`describeImage`) — nothing else changes. If a new embedding model doesn't
return 384 numbers, the `product_embeddings.embedding` column must be resized.

### Timeouts

Netlify ends synchronous functions after about 10 seconds, so image
generation uses FLUX schnell at 4 steps and stops waiting at 8.5 s. A slow
provider produces a friendly "try again" and a `failed` row in the log.

## Safety

- **Before generating**, the description is screened (`screenPrompt`):
  a built-in list (explicit, sexual content involving minors, hate symbols,
  graphic violence, real people's likeness, counterfeit merch) plus every
  term in the staff-editable moderation term list (brands, characters,
  teams). Refused requests are logged with the reason and never reach the
  provider.
- The prompt wraps the customer's words for print ("isolated graphic on a
  plain white background, no watermark, no mockup").
- Generated files live in the private `designs` bucket under the customer's
  own folder. The file name carries the description, so the moderation term
  check sees it again at submission.
- Generated art is moderated like any upload. In live mode images still go to
  a person; descriptions can only add a reason to review.
- Limits: per customer per day (default 15), store-wide per day (default
  300), and a per-IP rate limit. Blocked/failed requests don't count.

## Data

| Object | Purpose |
|---|---|
| `ai_generations` | every request: prompt, style, provider/model, status (`pending`/`succeeded`/`blocked`/`failed`), reason, asset, the copy used in a design (`used_asset_id`), timing. Customers read their own; moderators/analysts read all |
| `ai_quota(user)` / `ai_my_quota()` | server-side limit check / remaining count for the designer |
| `ai_attach(generation, asset)` | links the processed copy placed on a garment back to its generation (for "ordered" stats) |
| `admin_ai_overview()` | admin page data |
| `product_embeddings` | 384-d vector per product + content hash + model |
| `ai_products_to_embed(limit, model)` / `ai_save_embeddings()` | indexer (service role only) |
| `search_products_smart(q, embedding)` | hybrid search returning storefront rows |
| `recommend_for_product`, `recommend_for_bag`, `recommend_for_me` | recommendation rows (purchasable, in stock) |
| `analytics_forecast(days)` | forecast tab |

Settings (`store_settings`): `ai.enabled`, `ai.daily_user_limit`,
`ai.daily_global_limit`, `ai.vision_moderation` — editable on the admin AI page.

Analytics events: `ai_design_requested`, `ai_design_generated` (server),
`ai_design_used`, `design_background_removed`, `recommendation_click`,
`search` (now with `semantic`).

## Not built (yet)

- Try-on with AI garment fitting, AI upscaling/vectorization, demand-based
  automatic purchasing. The adapter shape leaves room for them.

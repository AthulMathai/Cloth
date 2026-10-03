# Custom Designer & dynamic pricing (Phase 3)

## Customer flow

`/custom` → pick a blank (products tagged `blank`) → colour → size → print area
(front, left chest, back, sleeves where the garment supports them) → upload artwork
or add text → drag / resize / rotate (mouse or touch) → switch front/back view →
choose print method per area → optional artwork services → quantity →
**Save** → **Submit for approval** → automated moderation → **Add to bag** → checkout.

Editor: layers (reorder, delete), undo/redo, reset, zoom, one-tap centre, rotation
snaps at 90°, layer centres kept within the print area, live price panel. Saved designs live at `/designs`; `/custom/<id>` reopens one.

## What is stored

A design is **configuration, not a screenshot** (`custom_designs.config`):

```json
{ "layers": [{ "id": "l1", "type": "image", "placement": "front", "asset_id": "…",
               "x_in": 6, "y_in": 6, "w_in": 10, "h_in": 10, "rotation": 0 },
             { "id": "l2", "type": "text", "placement": "back", "text": "TH8RTY CREW",
               "font": "anton", "color": "#ffffff", "x_in": 6, "y_in": 3, "w_in": 10, "h_in": 2, "rotation": 0 }],
  "methods":  { "front": "dtg", "back": "dtf" },
  "services": [] }
```

Positions are inches from the print area's top-left (layer centre), so production
files can be re-rendered at any DPI. Every save writes an append-only
`design_versions` row. Files are tracked in `design_assets` by kind —
`original` (upload), `processed`, `production` (150 dpi PNG per print area) and
`mockup` (garment preview per view). Uploads go to the private `designs` bucket
under the user's own folder; mockups to `mockups`. Nothing is public.

Editing an approved design creates a new version in `draft`; a bag line holding the
old version is flagged *"Design changed — submit it again"* and can't be checked out.

## Moderation (automated part)

`POST /api/moderate-design` (Netlify function, service role) for the submitted version:

- reads the **real file bytes** from Storage and sniffs the type (PNG/JPEG/WEBP/SVG) —
  declared MIME and extension aren't trusted; checks dimensions vs. print size (DPI)
- rejects SVGs with scripts, event handlers, external references or `foreignObject`
- matches file names, design name and text layers against `moderation_terms`
  (trademarks, sports teams, characters …) — OCR on images is a Phase 6 provider slot
- risk score → `approved` / `needs_review` / `rejected`, saved append-only in `moderation_results`

With `INTEGRATIONS_MODE=live` and no real provider configured, every image goes to
`needs_review` instead of auto-approval. Wording is always "may contain protected
material", never a legal finding. The human review queue arrives in Phase 6.

Only `approved` designs whose approved version equals the current version can enter
the bag (`cart_add_design`).

## Pricing engine

All prices are rows in `pricing_rules` — nothing is hard-coded in the front end.

| rule_type | matches on | example (placeholder amounts) |
|---|---|---|
| `base` | product / product type | optional override of the garment price |
| `size` | size | XXL +$3, 3XL +$5 |
| `placement` | placement | front/back +$8, left chest +$5, sleeve +$6 |
| `print_area` | area tier (by bounding box sq in) | small 0, medium +$3, large +$6, full +$9 |
| `method` | method (+ optional tier, min qty) | DTF +$2; embroidery +$6 & $15 setup; screen −$1.50, $35 setup, min 24 |
| `artwork` | service | background removal $5 per line |
| `quantity` | min/max qty | 5–9 −$2 … 100–249 −$11 per item (or `percent`) |
| `quote` | min qty | 250+ → request a quote |

Each rule has optional conditions (`product_id`, `product_type`, `size`, `placement`,
`method`, `area_tier`, `service`, `min_qty`, `max_qty`), customer price, production
cost, setup fee, `charge_per` (unit/order), `priority`, `effective_from/to`,
`is_active`. Per dimension the engine picks **one** rule: highest priority → most
specific → newest. Edits bump `version` and are written to the audit log.

```
unit = garment + size + Σ(placement + area tier + method) − volume discount
line = unit × qty + one-time fees (setup, artwork)
```

Functions (one engine, different views):

- `price_custom_internal` — full result incl. costs, margin and the rule ids + versions used
- `price_custom` — public (designer live price), costs stripped
- `price_custom_admin` — staff with `pricing.write`/`analytics.read`; the admin calculator
- `custom_quantity_tiers` — tier table + "add N more to save $X" nudge
- `design_price` — price a saved design for its owner

## Bag, checkout, snapshot

Custom bag lines are re-priced live (tier follows line quantity). `create_order`
re-prices server-side and refuses if the price changed; it freezes on the order line
the **full** breakdown (costs, margin, rules + versions), the design config of that
version and its production files. Later rule changes never alter an existing order
(covered by `supabase/tests/custom.sql`). After payment, custom orders record
`approved` → `fulfillment_pending` in the order history.

## Quotes

At or above the quote threshold the designer switches to **Request a quote**
(`submit_quote_request`): quantity, size breakdown, colours, placements, date, notes
and the engine's estimate. Requests land in `quote_requests` (status new → reviewing →
quoted → accepted → converted). The admin quote screen and quote → order conversion
come with the admin panel.

## Not yet built

Admin screens for pricing rules / calculator / quotes, the human moderation queue,
AI generation (Phase 10), side-view mockups.

## 3D studio and live try-on

The designer opens in **3D** by default (WebGL 2 required; otherwise it falls back to
the flat editor). Toolbar: **3D · Flat · Try on**.

**3D garments** (`public/js/three/`) are generic blanks modelled in code — tee,
longsleeve, crewneck, hoodie (hood, drawstrings, kangaroo pocket, ribbed cuffs and
waistband) and tank — so no model files need downloading. They are built the way a
pattern maker works, in inches: front and back panels, set-in sleeves, rib bands.
Every printable part's UVs are **inches of fabric** (torso: across from the centre
line × down from the high point of the shoulder; sleeves: around × down the sleeve),
so a 12 in print covers exactly 12 in of fabric and follows its wrinkles.

| File | What it does |
|---|---|
| `garment-model.js` | garment specs (inches) and geometry: panels, sleeves, hood, pocket, ribbing |
| `fabric.js` | procedural jersey / fleece / rib normal maps; fabric material (cotton sheen, plain inside) |
| `kit.js` | turns the design into per-part textures with the **same layer renderer as the production files** (clipped to the same print areas); print-method finish (DTF/vinyl glossier, embroidery thread texture); hit-testing |
| `studio.js` | viewer: studio lighting, orbit, front/back/sleeve views, drag artwork on the garment, 3D mockup render |
| `tryon.js` | camera try-on |

Colour, size, layers, method changes update the 3D view live. Dragging artwork on
the 3D garment moves the layer (same config, same undo history). Saved mockups are
3D product shots when the 3D view is running, flat drawings otherwise. Production
files are unchanged (flat PNG per print area at 150 dpi).

**Try on** opens the camera (or a photo). Body tracking (MediaPipe Pose Landmarker,
runs on-device, loaded on demand from jsDelivr / Google model storage — URLs in
`POSE_CONFIG`) places, scales and turns the garment from the shoulders, sets length
from the hips and bends the sleeves along the arms. An invisible body shape hides the
garment's inside. If tracking can't load, the garment can be dragged / pinched into
place. Mirror toggle, colour swatches, fit slider, snapshot download. Nothing is
uploaded; the page says so. `netlify.toml` allows `camera=(self)`.

To swap in real scanned/modelled garments later, replace the geometry in
`garment-model.js` for a type; the print pipeline only needs meshes with
`userData.part` and inch-based UVs.

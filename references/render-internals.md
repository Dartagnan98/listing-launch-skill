# Render internals reference

Deep detail for Phase 2 of the marketing runbook.

## What render-all.js does

- Reads the current counter from `data/marketing/counter.json` (or `--counter N`
  to override).
- Picks the variant from `ROTATION[counter % ROTATION.length]` (D or E).
- Loads realtor-level contact from `config/realtor.json` (phone / email /
  website). Swap this file to re-home the skill to another realtor.
- Writes `data-{coming-soon,just-listed,open-house}.json` into the run dir.
- Shells out to `render.js` for each stage -> writes
  `graphics/{coming-soon,just-listed,open-house}.png`.
- Retries with the OTHER rotation variant on failure (D ↔ E).
- Saves `render-summary.json` with per-stage template + fallback info.
- Exits non-zero if any stage failed (so Phase 4 can skip broken posts).

## Renderer (render.js)

Handles webfont loading (only when `branding.google_fonts` is on), `{{placeholder}}` substitution, Templated-style
autofit (shrinks text to fit its box), 2x device scale, and the `#canvas`
screenshot. It also carries a defensive URL rewriter that auto-converts common
wrong Drive URL formats to the `lh3` form, and aborts the render if any `<img>`
fails to load.

## Variant rotation

`["D","E"][counter % 2]`. D and E are the two approved template sets, rotated so
consecutive listings do not look identical.

**To change the rotation:** edit the `ROTATION` constant in
`scripts/render-all.js` AND the matching array in
`scripts/log-marketing-launch.js#variantFromCounter`. To add a variant, drop a
new `<stage>-<letter>.html` into `templates/html/` with a matching
`.meta.json`, then add the letter to both arrays.

**Override the variant for a single run:**
`MARKETING_VARIANT_OVERRIDE=D node render-all.js ...` — useful to force a style
for consistency across a paired campaign.

## Adding a new template variant

1. `curl` the Templated API (or whatever source) and save `<name>.meta.json` +
   `<name>.layers.json` to `templates/source/`.
2. Extend `templates/semantic-map.json` with any new layer names (check whether
   they map to existing canonicals or need a new one).
3. Run `python3 .claude/skills/marketing/scripts/templated-to-html.py <name>`
   to regenerate the standalone HTML.
4. Render-test with `data/marketing/test-<stage>.json` fixture before using in
   production.

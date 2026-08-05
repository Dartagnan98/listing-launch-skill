# Listing Marketing

A Claude skill that runs a realtor's full listing-launch campaign end to end, in
one continuous run: collect inputs -> render graphics -> write copy ->
schedule Buffer -> schedule Mailjet -> log the run.

Trigger phrases: "launch the new listing", "marketing go", "photos are in, let's go".

Replaces a 92-node Zapier zap plus its intake Google Form.

## Install

Drop this directory into the host repo as `.claude/skills/listing-marketing/`:

```bash
git clone <this-repo> .claude/skills/listing-marketing
```

`SKILL.md` is the runbook. Read it top to bottom -- it is the whole pipeline.

## First run

There is nothing realtor-specific in this repo. On the first `marketing go`,
Phase 0 asks for the agent's name, title, brokerage, team name, city, contact
details, logo files, brand colors, Instagram handle and hashtags, and the
Drive listing folder, then writes them to `config/realtor.json` and copies
the logos into `assets/`. Every later run reads that file and skips setup.

Prefer to fill it in by hand? Copy the examples:

```bash
cp config/realtor.example.json config/realtor.json
cp config/voice.example.json config/voice.json
cp config/buffer-channels.example.json config/buffer-channels.json
cp config/mailjet-lists.example.json config/mailjet-lists.json
```

`config/*.json` and `assets/*.png` are gitignored, so a realtor's details and
brand files never get committed back to the shared repo.

## What lives here vs. in the host repo

In this repo:

| Path | What |
|---|---|
| `SKILL.md` | The runbook. Phases 1-7. |
| `lessons.md` | Accumulated fixes and gotchas. Read before debugging. |
| `references/` | Deep detail: Buffer/Mailjet ops, inputs schema, render internals, voice. |
| `scripts/` | Render, Buffer/Mailjet scheduling, copy skeleton, logging. |
| `templates/` | Graphic templates (D/E rotation) + email HTML/text. |
| `config/` | `*.example.json` templates for realtor identity, voice, Buffer channels, Mailjet lists. |
| `assets/` | Where the realtor's logo files land. Empty until Phase 0 runs. |

Expected at the **host repo root** (not included here, per-realtor):

```
docs/voice/realtor-profile.md  long-form voice fingerprint (config/voice.json is the short form)
docs/brand/brand-guide.md      fuller styling detail beyond the colors in realtor.json
data/marketing/counter.json    D/E template rotation position
data/marketing/runs/           per-run output dirs
```

## Env vars

```
BUFFER_TOKEN          Buffer OIDC personal access token (Publish > Account > Apps)
MAILJET_API_KEY       Mailjet v3 REST key
MAILJET_SECRET_KEY    Mailjet v3 REST secret
LOFTY_API_KEY         Lofty CRM
LISTING_DRIVE_PARENT  optional, Drive folder ID for listing photos
TEMPLATED_API_KEY     optional, only to port new templates
```

Also needs: `gws` CLI logged in with Drive + Docs scopes, and Playwright.

```bash
npm install playwright && npx playwright install chromium
```

## Per-realtor settings

Nothing realtor-specific is hardcoded in scripts or templates -- not a name, not
a URL, not a hex code, not a font. Templates fill `{{agent_name}}`,
`{{brokerage_line}}`, `{{brand_logo}}`, `{{primary_color}}`, `{{surface_color}}`,
`{{heading_font_stack}}` and friends from `config/realtor.json` via
`scripts/realtor-config.js`. Adding a new per-realtor field means adding it
there, not in a template.

Defaults are deliberately neutral: grey palette, Georgia + Helvetica, no webfont
fetch. A fresh clone renders unbranded rather than wearing someone else's brand.
Set `branding.google_fonts` to true to load the configured faces from Google
Fonts.

```bash
node scripts/realtor-config.js --check     # validate the config shape
node scripts/schedule-buffer.js --list-channels   # get Buffer channel IDs
```

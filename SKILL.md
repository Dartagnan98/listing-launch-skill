---
name: marketing
requires_onboarding: [identity_profile, drive]
description: >
  the realtor's full listing-launch marketing campaign, end to end. Use when the
  user says "launch the new listing", "new listing marketing", "marketing go",
  "kick off the campaign", or "photos are in, let's go". One skill, one
  continuous run: collect inputs -> render graphics -> copy -> Buffer ->
  Mailjet -> log. No router, no sub-skills, no handoffs.
metadata:
  elevate:
    tags: [real-estate, marketing, listing-launch, workflow]
---

# Listing Launch

**Client**: whichever realtor this install is configured for (`config/realtor.json`)
**Trigger**: "launch the new listing" / "marketing go" / "photos are in, let's go"

This is one linear runbook. Work it top to bottom for a full listing launch. Do
not stop between phases to "hand off" — there are no sub-skills and no handoff
packets. Carry the run forward yourself.

## What this replaces

A 92-node Zapier zap plus the Google Form that kicked it off. This skill is the
whole pipeline in one place, portable and runnable from Claude desktop or
Telegram.

## Mandatory reads before running

1. `lessons.md` in this folder — the living record of every correction the realtor
   has made. Apply every lesson.
2. `config/realtor.json` — agent name, brokerage, contact, logos, brand colors,
   domains. Written by Phase 0. Nothing realtor-specific is hardcoded anywhere
   else; if you find yourself typing a name or a URL into a script or template,
   it belongs here instead.
3. `config/voice.json` — voice fingerprint and hashtag policy. All copy (posts
   and emails) must pass it. The long form lives in
   `docs/voice/realtor-profile.md` at the host repo root, mined from the
   realtor's own outgoing messages.
4. `templates/semantic-map.json` — canonical field name -> raw layer name
   mapping for the local templates.
5. `data/marketing/counter.json` — current D/E rotation position.

## Working root

```bash
cd <host-repo>   # the realtor tools repo this skill is installed into
```

## Always-apply rules

These hold for the entire run. Do not consult a reference for them — just do them.

- **The only gate is Phase 1 (input collection).** Everything after is
  autonomous. Do not stop to ask "should I continue?" mid-pipeline.
- **Never abort the whole run** because Buffer rejected one post or a Lofty
  lookup failed. If a step fails, save partial data, log the failure, continue
  to the next step that does not depend on the failed one.
- **No em dashes. Ever.** Use `--`, a comma, or rewrite. This applies to all
  posts and emails.
- **Step 2+ read `inputs.json` directly.** Never re-ask the realtor for data
  already collected.
- **Do NOT increment the counter** until Phase 6. Render reads it; only the log
  step bumps it.
- **Run dir pattern**: `data/marketing/runs/<YYYY-MM-DD-HHmm>-<address-slug>/`.
  All phase outputs go inside it.
- **Product packaging**: this skill is sold to other realtors. Keep everything
  config-driven. No realtor specifics in script code or templates — they belong
  in `config/realtor.json`, `config/voice.json`, and `.env`.

## Env vars required

```
BUFFER_TOKEN          OIDC personal access token (Buffer Publish > Account > Apps)
LISTING_DRIVE_PARENT  (optional) Drive folder ID; falls back to drive.listing_parent in config/realtor.json
MAILJET_API_KEY       Mailjet v3 REST API key
MAILJET_SECRET_KEY    Mailjet v3 REST secret
LOFTY_API_KEY         already set
TEMPLATED_API_KEY     optional, only needed to port new templates
```

gws CLI must be logged in with Drive + Docs scopes (already set).
Node deps: `playwright` + chromium browser (shared with cma/property-lookup):

```bash
npm install playwright
npx playwright install chromium
```

---

## Phase 0 — One-time setup (first run only)

**Check `config/realtor.json` first. If it exists, skip this entire phase and
start at Phase 1.** Never re-ask setup questions on a normal run.

If it does not exist, this is a fresh install. Say so plainly ("Setting you up
first, this is one time only"), then ask all of it in a single numbered block so
the realtor can rapid-fire answer. Re-ask only what comes back missing.

**Identity and brokerage**
1. Full name, as it should appear in an email signature
2. Title (Founder, REALTOR®, Broker, etc.)
3. Brokerage name, plus any designation to sit beside it
4. Team or brand name, if different from the brokerage
5. City and province/state

**Contact**
6. Email, phone, and website

**Branding**
7. Logo files — light/white version for dark backgrounds, dark/black version for
   light backgrounds. Accept local paths, Drive links, or public URLs. Copy them
   into `assets/logo-light.png` and `assets/logo-dark.png`. If only one exists,
   use it for both.
8. Brand colors — primary and accent, as hex. If she does not know them, pull
   them off the logo and read the values back for confirmation. Neutrals (text,
   muted, surface, border) default to a warm grey set and only need changing if
   she has opinions about them.
9. Fonts — a heading face and a body face. Default is Georgia + Helvetica, which
   render everywhere with no webfont fetch. If she names Google Fonts instead,
   set `branding.google_fonts` to true so the templates load them, and check she
   is actually licensed for them.

**Social and publishing**
10. Instagram handle plus 1-2 brand hashtags
11. The Google Drive folder her listing folders live under — graphics get staged
    there. Ask for the folder link and take the ID out of it yourself.

Then write the answers to `config/realtor.json` — schema and field names are in
`config/realtor.example.json`. Copy the logos into `assets/`. Read the whole
config back in plain language and get a yes before continuing.

**Then the two channel configs.** Copy `config/buffer-channels.example.json` and
`config/mailjet-lists.example.json` to their non-example names and fill in real
IDs. Buffer channel IDs come from `node scripts/schedule-buffer.js --list-channels`
once `BUFFER_TOKEN` is set. Mailjet list IDs come from the Mailjet contacts UI.
If either token is not available yet, write the file with the IDs blank, tell the
realtor exactly which one is missing, and carry on — Phases 1-3 do not need them.

**Then voice.** Copy `config/voice.example.json` to `config/voice.json`. The
shipped defaults are generic and safe, but the copy is only as good as this file.
If `docs/voice/realtor-profile.md` exists at the host repo root, mine it for
signature phrases, banned phrases, and emoji habits and fill them in. If it does
not, tell the realtor the copy will be competent but not yet in her voice, and
that the fix is a profile built from a sample of her real outgoing messages.

Setup is done. Go straight into Phase 1 in the same run — do not make her ask
twice.

---

## Phase 1 — Collect inputs (conversational walker)

Ask the user each question in order. Skip optional fields if the user says
"skip" or "none". Accept photo URLs as Drive links, public URLs, or local file
paths.

**Required (7):**
1. **Address** — street + city, e.g. `1234 Example Road, Springfield, BC`
2. **Listing price** — accept `$539,900` or `539900`
3. **Main exterior photo** — URL or path
4. **Interior feature photo** — URL or path (best interior shot)
5. **Secondary interior photo** — URL or path
6. **Open house date + time** — ISO or natural language
7. **Planned go-live date** — YYYY-MM-DD

**Optional (10):** city, sub division, unique features (one-liner), recreational
feature (e.g. "creek frontage"), recreational feature image, photo 4 / 5 /
6, property features (bullet list for email + copy), cross-post to the secondary
IG? (yes/no, default no — if yes, adds `secondary_instagram` to every post's
channel list; always posts to `default_listing_targets` regardless). All channel
keys are in `config/buffer-channels.json`.

**Walker style:** batch the 7 required fields in a single numbered prompt so
the realtor can rapid-fire answer all of them. If she misses one, re-ask only the
missing ones. After required fields are in, ask optionals as a single "anything
else to add?" block. Accept natural-language answers, no strict formats.

**Normalization (Claude applies before writing `inputs.json`):**
- **Address**: Title-case, strip trailing commas. Build `address_slug` by
  lowercasing + replacing non-alphanumeric with `-`.
- **Price**: Strip `$` and `,`, parse int, reformat as `$NNN,NNN`. Invalid
  prices -> re-ask.
- **Open house datetime**: Parse to ISO-8601 with `-07:00` (PDT) or `-08:00`
  (PST) depending on month, timezone America/Vancouver. Also produce a `display`
  variant like `Saturday, May 4 | 12-2 PM` for the graphic.
- **Go-live date**: Parse to `YYYY-MM-DD`. Use today's date from context for
  relative phrases ("Friday", "next week").
- **Photo URL**: If a local path, upload via
  `gws drive files create --params '{"name":"<filename>","parents":["<listing-folder-id>"]}' --media <path>`,
  set permissions to anyone-with-link reader, then use the resulting URL.
- **Property features**: Accept prose or bullets. Store both as a single
  ` | `-separated string for the graphic (`2 Bed | 1 Bath | 864 sqft`) AND as a
  bullet array for the emails.

**CRITICAL photo URL rule:** always use
`https://lh3.googleusercontent.com/d/<FILE_ID>=w2000` for Drive-hosted photos.
The `drive.google.com/uc?id=X&export=download` and `drive.google.com/open?id=X`
forms return a virus-scan HTML interstitial for files > ~25 MB, and Playwright
fetches the HTML instead of image bytes — the render ships with empty photo
placeholders. `render.js` has a defensive URL rewriter that auto-converts common
wrong formats and aborts on a failed `<img>`, but put the correct `lh3` URL in
`inputs.json` from the walker. Flow: share the Drive file as anyone-with-link
reader, copy the file ID from the share URL, use the `lh3` form.

**Validation before proceeding (re-prompt ONLY the failing field, never restart
the walker):**
- Open house datetime is in the future.
- Go-live date is today or future.
- Go-live date is <= open house date.
- All 7 required field values are non-empty.

Save to `data/marketing/runs/<run>/inputs.json`. Schema and a worked example are
in → `references/inputs-schema.md`.

## Phase 2 — Render graphics (local HTML + Playwright)

Rendering is fully local via Playwright chromium. Templated.io is NOT called at
runtime (removed for portability — no per-seat key for buyers). The templates
were one-time ported to standalone HTML + CSS under `templates/html/*.html`,
with canvas sizes in `templates/source/*.meta.json`. Two variants (D and E)
across three campaign stages, plus a just-sold pair.

**One command renders all 3 campaigns:**

```bash
node .claude/skills/marketing/scripts/render-all.js data/marketing/runs/<run>/inputs.json
```

That script reads the counter from `data/marketing/counter.json` (or
`--counter N`), picks the variant from `ROTATION[counter % ROTATION.length]`,
loads realtor contact from `config/realtor.json`, writes
`data-{coming-soon,just-listed,open-house}.json` into the run dir, shells out to
`render.js` per stage, retries with the OTHER rotation variant on failure
(D ↔ E), saves `render-summary.json`, and exits non-zero if any
stage failed.

**Variant rotation is `["D","E"][counter % 2]`** — D and E are the two approved
template sets. Override for one run with
`MARKETING_VARIANT_OVERRIDE=D node render-all.js ...`.

**Do NOT increment the counter here** — that is Phase 6.

Expected outputs: `graphics/coming-soon.png`, `graphics/just-listed.png`,
`graphics/open-house.png`, `render-summary.json`.

Rendering internals, the rotation-change procedure, and how to add a new
template variant are in → `references/render-internals.md`.

## Phase 3 — Generate copy (4 posts + 3 emails)

Run after render.

**Build the skeleton first** — it computes `scheduled_at_iso` for all 4 posts
from `inputs.json`. Claude never does timezone math by hand:

```bash
node .claude/skills/marketing/scripts/build-posts-skeleton.js data/marketing/runs/<run>
```

**Timing table (authoritative, all times America/Vancouver, DST-safe):**

| Post | Timing | Angle |
|---|---|---|
| Coming Soon | `go_live_date` -3d, 10:00 local | tease — address teaser + why it's special |
| Just Listed | `go_live_date`, 09:00 local | launch — hero shot, key specs, open-house nudge |
| Open House -3d | `open_house_iso` -3d, 09:00 local | invite — "this weekend come by", rec feature hook |
| Open House -1d | `open_house_iso` -1d, 08:00 local | urgency — "tomorrow only", directions + time |

**Fill-in protocol:**
1. Read the `posts.json` skeleton.
2. For each of the 4 posts, write `caption` (60-120 words, aim ~80-100) +
   `hashtags` (5-8) using inputs and the `angle` field. Facebook captions
   may include her website URL in the body; Instagram captions reference
   "link in bio" (IG strips links, so a URL never goes in an IG caption).
3. For each of the 3 emails in `emails[]`, fill every prompt-backed field:
   `subject`, `preheader`, `body_intro`, each `*_heading` + body section,
   `signoff`. Plain text, blank line between paragraphs —
   `schedule-mailjet.js` wraps paragraphs in `<p>`.
4. **LENGTH RULE (hard):** target the **upper half** of each prompt's word/char
   range. If the prompt says "150-220 words", aim 200-220. the realtor corrected
   this explicitly 2026-04-21.
5. Save the completed `posts.json` back to the same path.
6. **Run the validator before Phase 5/6:**
   ```bash
   node .claude/skills/marketing/scripts/validate-copy.js data/marketing/runs/<run>
   ```
   Exits 0 if all copy is in range with no banned phrases, exits 2 on hard fail,
   writes `copy-validation.json`. Do NOT push to Buffer/Mailjet on hard fail.
7. Show the realtor a tight preview of the 4 captions + 3 email subjects (no
   scheduled times). She approves or edits inline.

**Failure mode:** if the realtor pushes back on tone 2+ times in one session, stop
regenerating and ask: "Show me a past post you loved — I'll mirror it." Then
append the learning to `lessons.md`.

the realtor's voice rules, the banned-phrase list, hashtag mix, and anchor examples
are in → `references/voice-and-copy.md`. Read it before writing any caption.

Expected outputs: `posts.json`, `copy-validation.json`.

## Phase 4 — Schedule posts to Buffer

Run after copy passes validation. Buffer GraphQL API at `https://api.buffer.com/`
(legacy v1 REST `bufferapp.com` does NOT accept OIDC tokens — GraphQL only).

**One command schedules all 4 posts:**

```bash
node .claude/skills/marketing/scripts/schedule-buffer.js data/marketing/runs/<run>
```

Flags:
- `--dry-run` — resolves channels + graphics, skips Drive upload + Buffer calls.
- `--draft` — `saveToDraft: true`, posts land in Buffer drafts instead of the
  queue. Use for the first live test on a new listing.
- `--notification` — `schedulingType: notification` (the realtor gets a phone ping
  to tap "post"). Default is `automatic`.

The script validates non-empty captions, uploads each graphic to Drive (parent
from `LISTING_DRIVE_PARENT`, anyone-with-link reader), resolves channels from
`config/buffer-channels.json`, fires one `createPost` mutation per
(post × channel) with `mode: customScheduled` + `dueAt: scheduled_at_iso`, and
writes `buffer-updates.json`. A rejected (post, channel) records as `failed`;
the script still exits 0 so the pipeline continues. `scheduled_at_iso` is used
verbatim as `dueAt`.

Channel keys, handles, Buffer channel IDs, and the default listing targets all
live in `config/buffer-channels.json`. Default target is
`default_listing_targets`. To cross-post, add `secondary_instagram` to the
post(s) `"channels"` list before scheduling.

Buffer dry-run gates, full env detail, and failure handling are in →
`references/buffer-mailjet-ops.md`.

Expected output: `buffer-updates.json`.

## Phase 5 — Schedule emails to Mailjet

Run after copy; usually after Buffer so social status is known. Mailjet v3 REST
API, HTTP Basic `MAILJET_API_KEY:MAILJET_SECRET_KEY`.

```bash
# Schedule for real against scheduled_at_iso:
node .claude/skills/marketing/scripts/schedule-mailjet.js data/marketing/runs/<run>

# Draft only (no /schedule call) — for dry runs and the first test send:
node .claude/skills/marketing/scripts/schedule-mailjet.js data/marketing/runs/<run> --draft

# Fire a test send to one address after schedule:
node .claude/skills/marketing/scripts/schedule-mailjet.js data/marketing/runs/<run> --test you@example.com
```

The just-listed email CTA button points at the realtor's website
(`agent.website_url` in `config/realtor.json`). This is wired in
`build-posts-skeleton.js` — do not set it manually. The coming-soon and
open-house emails keep their `mailto:` CTAs (DM / RSVP).

Three emails per listing: `coming-soon` (go-live -3d, teaser, no price/address),
`just-listed` (go-live day, full walkthrough), `open-house` (open-house -3d,
in-person invite). Templates live at `templates/email-<stage>.html`.

A single email failing records as `status: "failed"`; Phase 6 still runs.
Per-email API steps, the accidental-schedule reverse, template syntax, and
contact-list config are in → `references/buffer-mailjet-ops.md`.

Expected output: `mailjet-drafts.json`.

## Phase 6 — Log, track, increment counter

Run after Buffer and Mailjet complete or partially complete.

```bash
node .claude/skills/marketing/scripts/log-marketing-launch.js data/marketing/runs/<run>
# optional:
#   --lead-id <N>   post a Lofty note against this lead
#   --no-lofty      skip the Lofty note entirely
#   --dry-run       preview output without writing anything
```

The script, in order:
1. **Detail file** — writes `docs/listings/<slug>-launch.md` with the launch
   summary (go-live + open house dates, variant, counter, all Buffer post IDs,
   all Mailjet draft IDs, all media Drive links). Separate from `<slug>.md`,
   which is owned by the weekly listing-reports pull and never clobbered.
2. **Lofty note (best-effort)** — if `--lead-id` is passed OR `inputs.json` has
   `lofty_lead_id`, POSTs a note to `api.chime.me/v1.0/notes`. Missing lead ID =
   skip with a warning, not a failure.
3. **Counter bump** — reads `data/marketing/counter.json`, increments, sets
   `last_run` + `last_address` + `last_run_at`, writes back. Next run uses
   `variant = ["D","E"][counter % 2]`.
4. **Launch log** — writes `<run>/launch-log.json` with counter before/after,
   variant used, per-channel counts, Lofty result.

`active-listings.md` is NOT touched here — it is auto-regenerated by
`scripts/refresh-active-listings.js` from weekly listing-reports JSONs.

Expected outputs: `launch-log.json`, `docs/listings/<slug>-launch.md`, updated
`data/marketing/counter.json`.

## Output to the realtor

At pipeline end, post one summary message (Telegram or console) assembled from
`launch-log.json` + `mailjet-drafts.json` + `buffer-updates.json`:

- Address + price
- 3 graphic thumbnails (Drive links)
- 4 scheduled Buffer post times
- 3 Mailjet draft IDs + scheduled send times
- Lofty note confirmation (or "no lead_id provided")
- Counter new value + next variant

Format: tight, bulleted, no em dashes, no narration.

## Completion Gate — run before reporting "done"

A pipeline that exited 0 is not a launched listing. Before reporting, verify
each line and cite the evidence:

- [ ] All 3 graphics rendered — files exist on disk under the listing's graphics
  folder, non-zero bytes. Not "render.js was called".
- [ ] Buffer posts scheduled — `buffer-updates.json` has a real post ID for each
  of the 4 channels/posts. A post with no ID did not schedule. If Buffer
  rate-limited, that post is `partial` — name it.
- [ ] Mailjet emails scheduled — `mailjet-drafts.json` has a draft ID + send
  time for each of the 3 emails.
- [ ] `data/marketing/counter.json` incremented (new value + next variant
  recorded).
- [ ] `launch-log.json` and `docs/listings/<slug>-launch.md` written.
- [ ] Lofty note applied (or explicitly "no lead_id provided").

Status is `done` only if every applicable line is verified with an ID/file.
Any post or email without an ID = `partial` — say "partial", name the exact
gap, and tell the realtor what needs manual promotion.

## After the run

If a correction happened during the run, append a dated entry to `lessons.md`.

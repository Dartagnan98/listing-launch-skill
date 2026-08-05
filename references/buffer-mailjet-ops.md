# Buffer and Mailjet operations reference

Deep detail for Phases 5 and 6 of the marketing runbook.

## Buffer (Phase 5)

Buffer GraphQL API at `https://api.buffer.com/`. The legacy v1 REST
(`bufferapp.com`) does NOT accept OIDC tokens — `schedule-buffer.js` uses
GraphQL only.

### What schedule-buffer.js does

- Validates every post in `posts.json` has a non-empty caption (fails loudly if
  not).
- Uploads each graphic to Drive (parent folder from `LISTING_DRIVE_PARENT`,
  defaults to `drive.listing_parent` in `config/realtor.json`). Sets
  anyone-with-link reader permission.
- Uses `https://drive.google.com/uc?id=<id>&export=download` as the image URL
  (cached so the Open House graphic uploads once, not twice).
- For each post, resolves target channels from `config/buffer-channels.json`
  (keyed by `post.channels` if set, else `default_listing_targets` filtered by
  `post.platforms`).
- Fires ONE `createPost` GraphQL mutation per (post × channel) with
  `mode: customScheduled` + `dueAt: post.scheduled_at_iso`.
- Writes `buffer-updates.json` with per-post status + per-channel post IDs +
  Drive file IDs.

### Flags

- `--dry-run` — resolves channels + graphics, skips Drive upload + Buffer calls.
- `--draft` — `saveToDraft: true`, posts land in Buffer drafts. Safe for the
  first live test on a new listing.
- `--notification` — `schedulingType: notification`, the realtor gets a phone ping
  to tap "post". Default is `automatic` (Buffer posts on its own via FB
  Business). Only needed if IG auto-publish is broken.

### Env

```
BUFFER_TOKEN          OIDC personal access token (Buffer Publish > Account > Apps)
LISTING_DRIVE_PARENT  (optional) Drive folder ID; defaults to the realtor's Listing folder
```

### Channels

Channel keys and handles are in `config/realtor.json` (`channels`);
`config/buffer-channels.json` maps each key to its Buffer API channel ID.

Default listing target: `channels.buffer.default_listing_targets`. To cross-post
to the secondary brand, add `channels.buffer.secondary_instagram` to the
post(s) `"channels"` list in `posts.json` before scheduling. The walker should
ask "Cross-post to the secondary IG too? (default no)" and add that channel to
every post if yes.

### Timezone and failure handling

`scheduled_at_iso` from the skeleton builder is used verbatim as `dueAt`.
GraphQL accepts ISO-8601 with offset, no conversion needed. DST-safe via the
skeleton builder's `Intl.DateTimeFormat`.

If Buffer rejects one (post, channel), the failure records as `status:
"failed"` with the error. The script still exits 0 so the pipeline continues to
Phase 6. Posts that partially succeed (IG scheduled, FB failed) record as
`status: "partial"`.

### Dry-run gates (automatic, error out)

- Missing `posts.json`.
- Any caption empty (forces Phase 4 completion first).
- Missing `BUFFER_TOKEN`.

## Mailjet (Phase 6)

Mailjet v3 REST API, HTTP Basic `MAILJET_API_KEY:MAILJET_SECRET_KEY`. Pipeline
mirrors Buffer: build drafts, schedule sends to `scheduled_at_iso` on each
email, write a summary to `<run>/mailjet-drafts.json`.

### Per-email API steps schedule-mailjet.js runs

1. `POST /v3/REST/campaigndraft` — create the draft shell (title, subject,
   sender, contacts list).
2. `POST /v3/REST/campaigndraft/{id}/detailcontent` — set HTML + text body from
   `templates/email-<stage>.html`.
3. `POST /v3/REST/campaigndraft/{id}/schedule` — lock in the send time from
   `scheduled_at_iso` (skipped with `--draft`).

### Accidental-schedule reverse

If you schedule by accident, `DELETE /v3/REST/campaigndraft/{id}/schedule`
(HTTP 204) reverts status to 0. Emails in "programmed" status WILL send if not
cancelled.

### Templates

`templates/email-<stage>.html` — mustache-ish `{{field}}` and
`{{#field}}...{{/field}}` conditional blocks. Snapshot versions saved as
`email-<stage>.sample.html`.

### Contact lists

`config/mailjet-lists.json` maps `contacts_list_key` -> `{id, name}`. Default is
`whole_list`. **Heads up:** `Whole List V1` (id 10597884) is nearly empty —
real subscriber migration from Flodesk/Lofty is a separate task before the first
production run.

### CTA URL behaviour

The just-listed email CTA button (`cta_url`) points at the realtor's website
(`agent.website_url` in `config/realtor.json`). This is wired in
`build-posts-skeleton.js` — you do not need to set it manually. The coming-soon
and open-house emails keep their `mailto:` CTAs (DM / RSVP), since coming-soon
is a teaser and open-house is an in-person invite.

### Failure handling

Per the "don't abort the pipeline" rule, a single email failing records as
`status: "failed"` and Phase 6 still runs.

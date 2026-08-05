# Inputs schema reference

Deep detail for Phase 1 of the marketing runbook. The walker collects 16 fields
(7 required, 10 optional — see `SKILL.md` Phase 1 for the field list and
normalization rules).

## inputs.json

Saved to `data/marketing/runs/<YYYY-MM-DD-HHmm>-<address-slug>/inputs.json`.

```json
{
  "run_id": "2026-04-20-1430-1234-example-road",
  "address": "1234 Example Road, Springfield, BC",
  "address_short": "1234 Example Road",
  "address_slug": "1234-example-road",
  "city": "Springfield",
  "price": "$539,900",
  "price_int": 539900,
  "main_photo": "https://lh3.googleusercontent.com/d/<FILE_ID>=w2000",
  "interior_photo": "https://lh3.googleusercontent.com/d/<FILE_ID>=w2000",
  "secondary_photo": "https://lh3.googleusercontent.com/d/<FILE_ID>=w2000",
  "photo_4": null,
  "photo_5": null,
  "photo_6": null,
  "recreational_photo": null,
  "features_line": "2 Bed | 1 Bath | 864 sqft | 1.15 acres | Creekfront",
  "features_bullets": ["2 Bed", "1 Bath", "864 sqft", "1.15 acres", "Creekfront"],
  "unique_features": "Only waterfront manufactured home under $600K in the river corridor.",
  "recreational_feature": "creek frontage",
  "sub_division": null,
  "open_house_iso": "2026-05-04T12:00:00-07:00",
  "open_house_display": "Saturday, May 4 | 12-2 PM",
  "go_live_date": "2026-04-25",
  "collected_at": "2026-04-20T14:30:00-07:00"
}
```

Optional `lofty_lead_id` may be added if known — the log step uses it for the
Lofty note (otherwise pass `--lead-id` to `log-marketing-launch.js`).

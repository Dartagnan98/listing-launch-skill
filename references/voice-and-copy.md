# Voice and copy reference

Deep detail for Phase 4 of the marketing runbook. Read this before writing any
caption. Also read `docs/voice/realtor-profile.md` sections 1-3 (voice
fingerprint + don't list). The voice was fingerprinted from 59k real outgoing
texts. Every caption must pass the profile check.

## Hard rules (any violation = regenerate)

- No em dashes. Ever. Use `--`, a comma, or rewrite.
- No AI cliches: "Certainly!", "I'd be happy to", "As an AI", "Let me help
  you", "Dive in", "Unlock", "Elevate your".
- No corporate jargon: "leverage", "synergy", "curate", "premier", "exquisite",
  "nestled".
- No sycophancy, no excessive apologies, no "don't miss out" urgency
  manufacturing.
- Max 120 words per caption. Min 60. Aim ~80-100.

## Positive rules (hit at least 2 per caption)

- Signature phrases: "I feel like" (her #1), "super", "totally", "honestly",
  "amazing", "obsessed with", "thought I would", "you guys", "stoked".
- "We" language — "we just listed", "we're hosting", not "I" or "the team".
- Warm + direct + unfiltered. the realtor talks to friends, not shoppers.
- End with a soft close: a specific question or concrete next step. "DM me for
  the info" is fine for marketing posts (different context than cold outreach).
  NEVER an open-ended "let me know".

## Do NOT use in writing (per realtor-profile.md)

- "at the end of the day" — only 5 hits in 59k written messages. Podcast
  phrase, not a writing phrase.
- "take this one with a grain of salt" — ZERO hits in her writing.
- "would you be opposed to..." — not her voice.
- A/B camp framing — not her voice.

## Banned phrases (hard-fail in validate-copy.js)

No em dashes. No "at the end of the day". No "grain of salt". No "would you be
opposed to". No AI real estate cliches: "nestled", "oasis", "stunning", "dream
home", "don't miss", "act fast", "hidden gem", "tucked away". Full rationale in
`docs/voice/realtor-profile.md`.

## Anchor examples (real the realtor texts, paraphrased — match this energy)

- *"Okay we just listed this one and I'm honestly obsessed. 2 bed / 1 bath on
  over an acre right on the creek. Who do you know that's been watching for
  something under 550 in town?"*
- *"Open house tomorrow from 12-2 at 1234 Example Road. Bring your coffee,
  bring a friend, bring anyone who keeps telling you they want waterfront but
  thinks it's out of reach."*
- *"Coming Friday. 864 sqft, on 1.15 acres, with a creek running right through
  the back. I feel like this is going to move fast. Are you a waterfront person
  or a view person?"*

## Hashtags

5-8 per post, case-preserved style. Mix:
- **Local** (2-3): `#<city>`, `#<town>`, `#<city>RealEstate`,
  `#<region>Living`, `#<region>RealEstate` (pick based on address city).
- **Stage-specific** (1-2): `#ComingSoon`, `#JustListed`, `#OpenHouse`.
- **Generic RE** (1-2): `#HomeSweetHome`, `#WaterfrontLiving`, `#RealEstate`,
  plus `brand.hashtags.primary` from `config/realtor.json`.
- **Realtor brand** (1): `brand.hashtags.brand` from `config/realtor.json`.

## Email copy

The 3 emails are cadence-matched with social:

| Stage | Sent | Audience | Tone | Sections |
|---|---|---|---|---|
| `coming-soon` | go-live day minus 3 | full list | teaser, no price/address | hero + body_intro + recreational teaser |
| `just-listed` | go-live day | full list | full walkthrough | hero + body_intro + setting + creek + "what makes this lot work" |
| `open-house` | open-house day minus 3 | full list | invite, "come see it" | hero + body_intro + "why come in person" |

Copy comes from `posts.json#emails[]` prompts. Each email has 4-7 prompt fields
with explicit length targets: `subject_prompt`, `preheader_prompt`,
`body_intro_prompt` (150-260 words), `setting_section_prompt` (120-180),
`recreational_section_prompt` (70-150), `infrastructure_section_prompt`
(140-200), `signoff_prompt` (30-70). Fill each to its target length (upper half
of the range). No em dashes. the realtor voice per profile. Plain text with a blank
line between paragraphs — `schedule-mailjet.js` wraps paragraphs in `<p>` for
the HTML output.

## posts.json schema (after fill)

`caption` is a non-empty string, `hashtags` is a 5-8 element array. Email
prompt-backed fields are non-empty strings. `scheduled_at_iso` is unchanged from
the skeleton. See `scripts/build-posts-skeleton.js` for the full shape.

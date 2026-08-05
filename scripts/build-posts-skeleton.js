#!/usr/bin/env node
/**
 * Build a posts.json skeleton with scheduled_at_iso pre-computed and
 * empty caption/hashtag slots for Claude to fill in.
 *
 * Timing rules (all in the realtor's timezone, brokerage.timezone):
 *   Coming Soon     : go_live_date      - 3 days  @ 10:00 local
 *   Just Listed     : go_live_date                @ 09:00 local
 *   Open House -3d  : open_house_iso    - 3 days  @ 09:00 local
 *   Open House -1d  : open_house_iso    - 1 day   @ 08:00 local
 *
 * Usage:
 *   node build-posts-skeleton.js <run-dir>
 *
 * Reads:   <run-dir>/inputs.json
 * Writes:  <run-dir>/posts.json (skeleton with empty caption + hashtags)
 *
 * Claude then reads the skeleton, writes captions + hashtags in the realtor's
 * voice, and saves back to the same path.
 */
const fs = require('fs');
const realtorConfig = require('./realtor-config');
const path = require('path');

// Resolve the realtor's UTC offset for a given date, so DST is handled per
// date rather than assumed. Zone comes from brokerage.timezone.
function localOffset(dateStr) {
  // dateStr = YYYY-MM-DD; find offset at noon local on that date
  const d = new Date(`${dateStr}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: realtorConfig.timezone(),
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(d);
  const tz = parts.find(p => p.type === 'timeZoneName').value; // e.g. "GMT-7"
  const m = tz.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return '+00:00';
  const sign = m[1];
  const h = String(m[2]).padStart(2, '0');
  const mm = (m[3] || '00').padStart(2, '0');
  return `${sign}${h}:${mm}`;
}

function addDays(isoDate, days) {
  // isoDate = YYYY-MM-DD; returns YYYY-MM-DD shifted
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function atLocal(isoDate, hour) {
  // combine YYYY-MM-DD + local hour -> ISO with Vancouver offset
  const off = localOffset(isoDate);
  const hh = String(hour).padStart(2, '0');
  return `${isoDate}T${hh}:00:00${off}`;
}

function openHouseDate(ohIso) {
  // ohIso = "2026-05-04T12:00:00-07:00" -> "2026-05-04"
  return ohIso.slice(0, 10);
}

function main() {
  const runDir = path.resolve(process.argv[2] || '.');
  const inputsPath = path.join(runDir, 'inputs.json');
  if (!fs.existsSync(inputsPath)) {
    console.error(`inputs.json not found at ${inputsPath}`);
    process.exit(1);
  }
  const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));

  const goLive = inputs.go_live_date;                    // YYYY-MM-DD
  const ohDate = openHouseDate(inputs.open_house_iso);   // YYYY-MM-DD

  const posts = [
    {
      id: 'coming-soon',
      stage: 'coming-soon',
      graphic: 'graphics/coming-soon.png',
      angle: 'tease -- address teaser + why it is special, "hitting the market Friday" vibe',
      prompt: [
        'Write a COMING-SOON tease post from the realtor.',
        'Tone: warm, high-energy, unfiltered, "I just had to share this one" vibe.',
        'Hook opens with excitement about the listing hitting the market soon (use the go-live day of week, not a specific date).',
        'Tease 1-2 standout features from unique_features / recreational_feature without dropping the full address -- short-address only.',
        'Close with a soft CTA: ask them to DM for the full info drop, or say full details are coming this week.',
        'Use signature phrases naturally (max 2 of: "I feel like", "super", "totally", "honestly", "obsessed with", "you guys", "thought I would").',
        'No corporate real estate jargon. No "nestled". No "oasis". No "stunning". No em dashes.',
        'Length: 80-120 words. Line breaks between beats for IG readability.',
      ].join(' '),
      caption: '',
      hashtags: [],
      scheduled_at_iso: atLocal(addDays(goLive, -3), 10),
      platforms: ['instagram', 'facebook'],
    },
    {
      id: 'just-listed',
      stage: 'just-listed',
      graphic: 'graphics/just-listed.png',
      angle: 'launch -- hero shot, key specs, open-house nudge',
      prompt: [
        'Write a JUST-LISTED launch post from the realtor.',
        'Open with energy -- the listing is officially live today. Use full address or short-address, your call based on flow.',
        'Walk through 2-3 features from features_bullets + unique_features. Make it feel like she is showing the place to a friend, not reading a spec sheet.',
        'Include the price naturally in the body (not just the graphic).',
        'Close with a plug for the open house if open_house_display is set -- day + time.',
        'Use signature phrases naturally (max 2 of: "I feel like", "super", "totally", "honestly", "obsessed with", "you guys").',
        'No "nestled", "oasis", "stunning", "dream home". No em dashes. No corporate filler.',
        'Length: 100-140 words.',
      ].join(' '),
      caption: '',
      hashtags: [],
      scheduled_at_iso: atLocal(goLive, 9),
      platforms: ['instagram', 'facebook'],
    },
    {
      id: 'open-house-3d',
      stage: 'open-house',
      graphic: 'graphics/open-house.png',
      angle: 'invite -- "this weekend come by", recreational feature hook',
      prompt: [
        'Write an OPEN-HOUSE invite post from the realtor, 3 days out.',
        'Lead with the open house day + time (from open_house_display).',
        'Hook on the recreational_feature or unique_features -- the thing that makes showing up in person worth it.',
        'Casual invite tone -- "come by", "swing through", "come say hi". The realtor will be on-site.',
        'Include short address so viewers know where to go.',
        'Close with a specific ask: "DM me if you are coming" or "bring a friend who is house-hunting".',
        'No em dashes. No "dont miss out". No "this one wont last".',
        'Length: 80-120 words.',
      ].join(' '),
      caption: '',
      hashtags: [],
      scheduled_at_iso: atLocal(addDays(ohDate, -3), 9),
      platforms: ['instagram', 'facebook'],
    },
    {
      id: 'open-house-1d',
      stage: 'open-house',
      graphic: 'graphics/open-house.png',
      angle: 'urgency -- "tomorrow only", directions + time',
      prompt: [
        'Write an OPEN-HOUSE reminder post from the realtor, 1 day out.',
        'Lead with "tomorrow" + the specific time (from open_house_display).',
        'Short and punchy -- this is the last-call nudge, not a full walkthrough.',
        'Mention the short address + one standout feature to re-hook people who scrolled past the first invite.',
        'End with a direct ask: "come by", "see you there", or "DM if you need the exact directions".',
        'No em dashes. No "hurry". No "act fast". The realtor\'s urgency is warm, not salesy.',
        'Length: 60-90 words.',
      ].join(' '),
      caption: '',
      hashtags: [],
      scheduled_at_iso: atLocal(addDays(ohDate, -1), 8),
      platforms: ['instagram', 'facebook'],
    },
  ];

  // Voice fingerprint + hashtag policy are per-realtor. They live in
  // config/voice.json (see config/voice.example.json), never in code.
  const voiceCfg = realtorConfig.loadVoice();
  const rc = realtorConfig.flat();
  const voice_rules = voiceCfg.voice_rules;
  const hashtag_rules = {
    ...voiceCfg.hashtag_rules,
    mix: (voiceCfg.hashtag_rules.mix || []).map((line) =>
      line.replace(
        /from config\/realtor\.json social\.brand_hashtags/,
        (realtorConfig.load().social?.brand_hashtags || []).join(' ') || 'none configured'
      )
    ),
  };

  // Emails -- 3-stage cadence mirroring social posts. Each email has its own
  // set of prompts (subject, preheader, body_intro, optional section headings +
  // bodies, signoff) with explicit length targets. Claude fills the plain-text
  // fields -- the renderer (schedule-mailjet.js) converts \n\n paragraph breaks
  // into <p>...</p> blocks for the HTML template.
  const emails = [
    {
      id: 'coming-soon-blast',
      stage: 'coming-soon',
      hero_graphic: 'graphics/coming-soon.png',
      area_photo_field: null,               // coming-soon does not use area photo
      recreational_photo_field: 'recreational_photo',
      scheduled_at_iso: atLocal(addDays(goLive, -3), 9),
      contacts_list_key: 'whole_list',
      cta_text: 'Reply for the early info drop',
      cta_url_template: `mailto:${rc.agent_email}?subject=Listing%20info%20-%20{address_short}`,

      subject_prompt: 'Write a coming-soon email subject line from the realtor. Max 60 characters. Tease without spoiling. Reference the go-live day of week (not a specific date). Good examples: "Coming Saturday: a creekfront listing you will want early", "Sneak peek: new acreage listing hits Saturday". NO "Don\'t miss". NO "Exclusive".',
      preheader_prompt: 'Write a 90-110 character email preheader. Adds intrigue the subject does not cover. Reference unique_features or recreational_feature without dropping the address or price. NO em dashes.',
      body_intro_prompt: 'Write a coming-soon email body from the realtor. Teaser tone, "I just had to give you guys early access before this hits public" energy. Reference the go-live day of week (not the full date). Tease 2 standout features from unique_features / recreational_feature. Short-address only, no full address, no price, no MLS number. Close with a soft ask: reply for the full info drop early. Length: 150-220 words. Blank line between paragraphs. the realtor\'s voice, 2-3 signature phrases max. NO em dashes. NO "nestled", "oasis", "stunning".',
      recreational_heading_prompt: 'Write an H2 heading for the recreational teaser block. Max 8 words. Specific to the recreational_feature (e.g. "A creek that runs right through the lot"). NO em dashes.',
      recreational_prompt: 'Write a 70-110 word teaser about the recreational_feature. Sensory, specific, but don\'t spoil everything. This is the hook that makes readers say "send me the info". Blank line between paragraphs. NO em dashes.',
      signoff_prompt: 'Write a 30-50 word closing. Soft ask: reply for the info drop early OR wait for public launch. Warm close. One warmth marker (:) or 💛) is fine. NO em dashes.',

      subject: '', preheader: '', body_intro: '',
      recreational_heading: '', recreational: '',
      signoff: '',
    },
    {
      id: 'just-listed-blast',
      stage: 'just-listed',
      hero_graphic: 'graphics/just-listed.png',
      area_photo_field: 'area_photo',
      recreational_photo_field: 'recreational_photo',
      scheduled_at_iso: atLocal(goLive, 9),
      contacts_list_key: 'whole_list',
      cta_text: 'See the full listing',
      cta_url_template: rc.agent_website_url,

      subject_prompt: 'Write a just-listed email subject line from the realtor. Max 60 characters. Must include price OR a standout feature from unique_features. Tone: warm, direct, not salesy. NO "Don\'t miss out", NO "Dream home", NO "Stunning". Good examples: "Just listed: creekfront acreage under $600K", "New listing: creek frontage, $539,900".',
      preheader_prompt: 'Write a 90-110 character email preheader. Complements the subject line, adds one more hook the subject did not cover. Reference open house day/time if open_house_display is set. NO em dashes.',
      body_intro_prompt: 'Write the opening body of a just-listed email blast from the realtor. This is a real email to her full list, not a social caption. Open with a greeting ("Hey you guys,"). Then an energy line about the listing going live. Walk through 3-4 features from features_bullets + unique_features like she is showing the place to a friend. Name the price naturally. Set up the rest of the email (there are three more sections below about the area, the creek, and the infrastructure). Length: 180-260 words. Blank line between paragraphs. the realtor\'s voice, 2-3 signature phrases max. NO em dashes. NO "nestled", "oasis", "stunning", "dream home", "act fast".',
      setting_heading_prompt: 'Write an H2 heading for "The Setting" section. Max 10 words. Specific to the location (drive times, proximity to hubs, setting type). E.g. "Five minutes from town, forty from the city". NO em dashes.',
      setting_prompt: 'Write a 120-180 word block about the area / setting. Insider read on the location: town, drive times to bigger hubs (from the listing detail file or address), nearby recreation (lakes, ski hills, trails), the vibe. Specific beats generic. Blank line between paragraphs. NO "hidden gem", NO "tucked away", NO em dashes.',
      recreational_heading_prompt: 'Write an H2 heading for the recreational feature section. Max 10 words. Specific to the feature (e.g. "the creek, right through the lot"). NO em dashes.',
      recreational_prompt: 'Write a 100-150 word block about the recreational_feature. Sensory detail: what you hear, see, do with it. Reference property-specific details. Make it feel like she has stood on the lot. Blank line between paragraphs. NO em dashes, NO AI cliches.',
      infrastructure_heading_prompt: 'Write an H2 heading for the infrastructure / extras section. Max 10 words. Frame as "why this lot works" rather than specs (e.g. "The stuff that is not on the MLS line"). NO em dashes.',
      infrastructure_prompt: 'Write a 140-200 word block about the practical extras that make this property unusual. Pull from the listing detail: gazebos, decks, RV hookups, powered sheds, wells, amp service, zoning, B&B potential, etc. Frame as "what makes this lot work" not a spec sheet. the realtor\'s voice: she is telling you why it is clever, not just listing things. 1-2 signature phrases max. Blank line between paragraphs. NO em dashes.',
      signoff_prompt: 'Write a 40-70 word closing. Invite DMs, replies, or a site visit. Mention the open house day/time again (from open_house_display). Warm close, one of her warmth markers (:) or 💛) is fine. No hard sell. NO em dashes.',

      subject: '', preheader: '', body_intro: '',
      setting_heading: '', setting: '',
      recreational_heading: '', recreational: '',
      infrastructure_heading: '', infrastructure: '',
      signoff: '',
    },
    {
      id: 'open-house-blast',
      stage: 'open-house',
      hero_graphic: 'graphics/open-house.png',
      area_photo_field: null,
      recreational_photo_field: 'recreational_photo',
      scheduled_at_iso: atLocal(addDays(ohDate, -3), 9),
      contacts_list_key: 'whole_list',
      cta_text: 'RSVP or get directions',
      cta_url_template: `mailto:${rc.agent_email}?subject=Open%20house%20-%20{address_short}`,

      subject_prompt: 'Write an open-house email subject from the realtor. Max 60 characters. Lead with the day (Saturday, etc.) + time. Reference the recreational_feature or a standout hook. NO "Don\'t miss out". Good examples: "Saturday 12-2pm: come see the creek in person", "Open house Saturday at the creek".',
      preheader_prompt: 'Write a 90-110 character email preheader for an open house invite. Adds a second reason to come (the lot, the creek, the setting). NO em dashes.',
      body_intro_prompt: 'Write an open-house email body from the realtor. Invite tone, "come see this in person, photos do not do it" energy. Lead with the day + time (from open_house_display). Short address only. Remind them of price + 2 standout features. Say she will be on-site the whole time, bring a friend who is house-hunting, happy to answer questions. Length: 160-230 words. Blank line between paragraphs. the realtor\'s voice, 2-3 signature phrases max. NO em dashes. NO "act fast". NO "don\'t miss".',
      recreational_heading_prompt: 'Write an H2 heading for the "why come in person" section. Max 10 words. Captures what photos cannot convey about the recreational_feature. NO em dashes.',
      recreational_prompt: 'Write a 90-130 word block about the recreational_feature with "this is why you have to come in person" framing. Sensory, specific. Reference property-specific details. End with a soft pull to come Saturday. Blank line between paragraphs. NO em dashes.',
      signoff_prompt: 'Write a 40-70 word closing. Directions ask (DM for exact location), RSVP ask (let her know you are coming), private walk-through option if they cannot make Saturday. Warm close. One warmth marker (:) or 💛) is fine. NO em dashes.',

      subject: '', preheader: '', body_intro: '',
      recreational_heading: '', recreational: '',
      signoff: '',
    },
  ];

  const out = {
    run_id: inputs.run_id,
    address: inputs.address,
    address_short: inputs.address_short,
    price: inputs.price,
    features_line: inputs.features_line,
    features_bullets: inputs.features_bullets,
    unique_features: inputs.unique_features,
    recreational_feature: inputs.recreational_feature,
    open_house_display: inputs.open_house_display,
    voice_rules,
    hashtag_rules,
    posts,
    emails,
    generated_at: new Date().toISOString(),
    _doc: 'Skeleton: Claude fills each post.caption (per post.prompt length target, the realtor\'s voice per voice_rules) and post.hashtags (per hashtag_rules). For emails[]: Claude fills each *_prompt field into the corresponding blank string field (subject, preheader, body_intro, *_heading, *, signoff). Body fields are plain text with blank lines between paragraphs -- the renderer wraps them in <p> blocks for HTML. scheduled_at_iso is already computed -- do not modify. Each prompt is self-contained; read voice_rules + the prompt and write the copy to the target length.',
  };

  const outPath = path.join(runDir, 'posts.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(`timing (posts):`);
  for (const p of posts) {
    console.log(`  ${p.id.padEnd(18)} ${p.scheduled_at_iso}`);
  }
  console.log(`timing (emails):`);
  for (const e of emails) {
    console.log(`  ${e.id.padEnd(18)} ${e.scheduled_at_iso}`);
  }
}

main();

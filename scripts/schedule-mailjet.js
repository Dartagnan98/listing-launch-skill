#!/usr/bin/env node
/**
 * Schedule listing emails to Mailjet from posts.json#emails[].
 *
 * Uses Mailjet's v3 REST API with HTTP Basic auth (MAILJET_API_KEY:MAILJET_SECRET_KEY).
 *
 * Flow per email:
 *   1. POST /v3/REST/campaigndraft             -> create draft shell
 *   2. POST /v3/REST/campaigndraft/{id}/detailcontent -> set HTML + text body
 *   3. POST /v3/REST/campaigndraft/{id}/schedule      -> lock in send time from
 *                                                        scheduled_at_iso (skipped with --draft)
 *
 * The HTML body is assembled by a template renderer that fills:
 *   - hero graphic (Drive URL shared with Buffer step)
 *   - area_photo + recreational_photo (from inputs.json)
 *   - subject / preheader / body_intro / setting_section / recreational_section
 *     / infrastructure_section / signoff (all filled by Claude per the prompts
 *     in emails[] before this step runs)
 *
 * Usage:
 *   node schedule-mailjet.js <run-dir>
 *   node schedule-mailjet.js <run-dir> --draft         # create+populate only, skip /schedule
 *   node schedule-mailjet.js <run-dir> --test <email>  # also fire /test after schedule
 *
 * Required env:
 *   MAILJET_API_KEY
 *   MAILJET_SECRET_KEY
 *
 * Channel config read from .claude/skills/marketing/config/mailjet-lists.json
 * (maps contacts_list_key -> {id, name}).
 *
 * Writes:  <run-dir>/mailjet-drafts.json  {drafts: [{id, status, date, ...}]}
 *
 * Failure handling: a single email failing does NOT kill the pipeline. Per-email
 * status is captured in mailjet-drafts.json and the script exits 0 so downstream
 * steps (Lofty log, active-listings update) run regardless.
 */
const fs = require('fs');
const realtorConfig = require('./realtor-config');
const path = require('path');

const MJ_API = 'https://api.mailjet.com';
const LISTS_CONFIG = path.resolve(__dirname, '..', 'config', 'mailjet-lists.json');

function die(msg) { console.error(msg); process.exit(1); }

function env(name, required = true) {
  const v = process.env[name];
  if (!v && required) die(`missing env var: ${name}`);
  return v || '';
}

function basicAuth(key, secret) {
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

async function mj(authHeader, method, urlPath, body) {
  const res = await fetch(MJ_API + urlPath, {
    method,
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, body: json };
}

function loadLists() {
  if (!fs.existsSync(LISTS_CONFIG)) die(`mailjet-lists.json not found at ${LISTS_CONFIG}`);
  return JSON.parse(fs.readFileSync(LISTS_CONFIG, 'utf8'));
}

function driveUrlFromId(id, width = 1600) {
  // lh3 CDN form — reliable in email clients, supports =w<px> size hint
  return `https://lh3.googleusercontent.com/d/${id}=w${width}`;
}

/**
 * Render the per-stage email HTML. The templates live alongside the
 * marketing skill at templates/email-<stage>.html. Placeholders use
 * {{field}} syntax; optional sections with {{#field}}...{{/field}} render
 * only when the field is truthy. This is a deliberately tiny templating
 * layer — no dependency on mustache or handlebars — because the shape
 * is fixed and we want zero surprise.
 */
function renderTemplate(template, data) {
  // No webfont configured: drop the stylesheet link rather than shipping an
  // empty href to every inbox.
  if (!data.google_fonts_url) {
    template = template.replace(/<link[^>]*\{\{google_fonts_url\}\}[^>]*>/g, '');
  }
  // Block sections: {{#field}}...{{/field}} keep body if data[field] truthy.
  let out = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (m, key, inner) => {
    return data[key] ? inner : '';
  });
  // Simple {{field}} substitution (escapes NOT applied — copy comes from
  // Claude + inputs.json, we trust it).
  out = out.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (m, key) => {
    const parts = key.split('.');
    let val = data;
    for (const p of parts) {
      if (val == null) return '';
      val = val[p];
    }
    return val == null ? '' : String(val);
  });
  return out;
}

/** Convert plain-text paragraphs (separated by blank lines) into <p> blocks. */
function textToHtmlParagraphs(text, style = 'margin:0 0 16px 0;') {
  if (!text) return '';
  return text.trim().split(/\n\s*\n/).map(p => {
    const inner = p.trim().replace(/\n/g, '<br>');
    return `<p style="${style}">${inner}</p>`;
  }).join('\n');
}

/** Parse features_bullets into {label, value} pairs for the 4-column feature row. */
function splitFeature(bullet) {
  // "2 Bed" -> {value:"2", label:"Bed"}
  // "864 sqft" -> {value:"864", label:"Sqft"}
  // "1.15 acres" -> {value:"1.15", label:"Acres"}
  // "Creekfront" -> {value:"", label:"Creekfront"} (skip; caller filters)
  const m = String(bullet).match(/^([\d.]+)\s+(.+)$/);
  if (!m) return { value: '', label: bullet };
  const label = m[2].replace(/\bsqft\b/i, 'Sqft')
                    .replace(/\bacres?\b/i, 'Acres')
                    .replace(/\bbeds?\b/i, 'Bed')
                    .replace(/\bbaths?\b/i, 'Bath');
  return { value: m[1], label };
}

/** Pick the 4 numeric feature bullets (drop "Creekfront" etc. that have no number). */
function featureRow(bullets) {
  const numeric = (bullets || []).map(splitFeature).filter(f => f.value !== '');
  const picks = numeric.slice(0, 4);
  while (picks.length < 4) picks.push({ value: '', label: '' });
  return picks;
}

function cityFromAddress(full) {
  // "1234 Example Road, Springfield, BC" -> "Springfield, BC"
  const parts = (full || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.slice(1).join(', ');
}

/** Coming-soon hero headline is listing-specific but stage-constant pattern. */
function comingSoonHeadline(inputs) {
  const goLive = inputs.go_live_date ? new Date(inputs.go_live_date + 'T12:00:00Z') : null;
  const day = goLive ? goLive.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Vancouver' }) : 'soon';
  const feature = (inputs.recreational_feature || inputs.unique_features || 'listing')
    .split('.')[0].toLowerCase();
  return `A ${feature} listing, hitting ${day}`;
}

function buildRenderData({ inputs, email, hostListing }) {
  const areaPhoto = email.area_photo_field ? inputs[email.area_photo_field] : null;
  const recPhoto  = email.recreational_photo_field ? inputs[email.recreational_photo_field] : null;
  const features = featureRow(inputs.features_bullets);

  // Fallback: if no dedicated area/recreational photo is provided in inputs.json,
  // reuse one of the listing photos so the section still renders visually.
  // Priority: main_photo -> secondary_photo -> interior_photo -> blank.
  function fallbackListingPhoto() {
    for (const k of ['secondary_photo', 'main_photo', 'interior_photo']) {
      if (inputs[k]) return inputs[k];
    }
    return '';
  }

  // Hero image: the graphic rendered in step 2, uploaded to Drive in step 4
  // (schedule-buffer.js caches it and writes the id to buffer-updates.json).
  // Step 5 reuses those Drive IDs -- pull from hostListing.buffer_updates if present.
  const heroDriveId = email.hero_drive_id ||
    findHeroDriveId(hostListing, email.stage) ||
    null;

  // CTA URL template supports {address_short} tokens
  const ctaUrl = (email.cta_url_template || email.cta_url || realtorConfig.flat().agent_website_url)
    .replace(/\{address_short\}/g, encodeURIComponent(inputs.address_short || ''));

  return {
    ...realtorConfig.flat(),
    address: inputs.address,
    address_short: inputs.address_short,
    address_city: cityFromAddress(inputs.address),
    price: inputs.price,
    mls: inputs.mls_number || hostListing.mls_number || '',
    open_house_display: inputs.open_house_display || '',

    hero_image_url: heroDriveId ? driveUrlFromId(heroDriveId) : (email.hero_image_url || ''),
    hero_headline: comingSoonHeadline(inputs),   // coming-soon only
    hero_subhead: `${cityFromAddress(inputs.address)} · Early info available now`,

    // Area + recreational photos: prefer a dedicated photo from inputs.json
    // (e.g. `area_photo: {drive_id, caption}`) but fall back to a listing
    // photo so the section still ships with a visual. The section itself
    // renders whenever the COPY exists (see _hasArea/_hasRecreational below).
    area_photo_url: areaPhoto ? driveUrlFromId(areaPhoto.drive_id) : fallbackListingPhoto(),
    area_photo_caption: areaPhoto ? (areaPhoto.caption || '') : '',
    recreational_photo_url: recPhoto ? driveUrlFromId(recPhoto.drive_id) : fallbackListingPhoto(),
    recreational_photo_caption: recPhoto ? (recPhoto.caption || '') : '',

    feature_1_value: features[0].value, feature_1_label: features[0].label,
    feature_2_value: features[1].value, feature_2_label: features[1].label,
    feature_3_value: features[2].value, feature_3_label: features[2].label,
    feature_4_value: features[3].value, feature_4_label: features[3].label,

    cta_text: email.cta_text || 'See the full listing',
    cta_url: ctaUrl,
    subject: email.subject || '',
    preheader: email.preheader || '',

    // Plain text -> HTML <p> blocks for body sections
    body_intro_html: textToHtmlParagraphs(email.body_intro),
    setting_html: textToHtmlParagraphs(email.setting),
    recreational_html: textToHtmlParagraphs(email.recreational),
    infrastructure_html: textToHtmlParagraphs(email.infrastructure),
    signoff_html: textToHtmlParagraphs(email.signoff),

    // Plaintext fallthrough for text templates
    body_intro: email.body_intro || '',
    setting: email.setting || '',
    recreational: email.recreational || '',
    infrastructure: email.infrastructure || '',
    signoff: email.signoff || '',

    // Section headings (plain strings)
    setting_heading: email.setting_heading || '',
    recreational_heading: email.recreational_heading || '',
    infrastructure_heading: email.infrastructure_heading || '',

    // Conditionals used by {{#_hasX}} blocks. Section renders when the COPY
    // exists -- photo is optional. If no photo is configured the template
    // will reuse a listing photo via fallbackListingPhoto(). The fields are
    // keyed on email copy, not photo presence, because the prompts always
    // produce copy for every section the email supports.
    _hasArea: !!(email.setting && email.setting_heading),
    _hasRecreational: !!(email.recreational && email.recreational_heading),
    _hasInfrastructure: !!(email.infrastructure && email.infrastructure_heading),
  };
}

/**
 * Pull the uploaded-to-Drive hero graphic ID out of buffer-updates.json so
 * the email reuses the same image Buffer is posting. If Buffer step has not
 * run yet (e.g. dry run), fall back to email.hero_drive_id on the emails[]
 * entry or an empty URL (email renders with a broken hero image, which is
 * the signal to run Buffer step first).
 */
function findHeroDriveId(hostListing, stage) {
  const updates = hostListing.buffer_updates;
  if (!updates || !Array.isArray(updates.results)) return null;
  const match = updates.results.find(r => r.id && r.id.startsWith(stage));
  if (!match || !match.media) return null;
  return match.media.drive_file_id || null;
}

async function createDraft(authHeader, { subject, senderEmail, senderName, listId, title }) {
  return mj(authHeader, 'POST', '/v3/REST/campaigndraft', {
    Locale: 'en_US',
    Sender: senderName || realtorConfig.flat().agent_name,
    SenderEmail: senderEmail,
    Subject: subject,
    ContactsListID: listId,
    Title: title,
    EditMode: 'html2',
  });
}

async function setContent(authHeader, draftId, { html, text }) {
  return mj(authHeader, 'POST', `/v3/REST/campaigndraft/${draftId}/detailcontent`, {
    'Html-part': html,
    'Text-part': text,
  });
}

async function scheduleSend(authHeader, draftId, dateIso) {
  return mj(authHeader, 'POST', `/v3/REST/campaigndraft/${draftId}/schedule`, {
    Date: dateIso,
  });
}

async function testSend(authHeader, draftId, email) {
  return mj(authHeader, 'POST', `/v3/REST/campaigndraft/${draftId}/test`, {
    Recipients: [{ Email: email, Name: 'Test' }],
  });
}

async function main() {
  const args = process.argv.slice(2);
  const runDir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
  const dryRun = args.includes('--dry-run');
  const draftOnly = args.includes('--draft');
  const testIdx = args.indexOf('--test');
  const testEmail = testIdx >= 0 ? args[testIdx + 1] : null;

  const postsPath = path.join(runDir, 'posts.json');
  const inputsPath = path.join(runDir, 'inputs.json');
  if (!fs.existsSync(postsPath)) die(`posts.json not found at ${postsPath}`);
  if (!fs.existsSync(inputsPath)) die(`inputs.json not found at ${inputsPath}`);

  const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
  const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));
  const emails = posts.emails || [];
  if (!emails.length) die('posts.json has no emails[] block. Run the emails skeleton step first.');

  // Load buffer-updates.json if present so we can reuse hero Drive IDs.
  const bufferUpdatesPath = path.join(runDir, 'buffer-updates.json');
  if (fs.existsSync(bufferUpdatesPath)) {
    posts.buffer_updates = JSON.parse(fs.readFileSync(bufferUpdatesPath, 'utf8'));
  }

  const unfilled = emails.filter((e) => !e.subject || !e.body_intro);
  if (unfilled.length) {
    die(`emails[] has unfilled copy: ${unfilled.map((e) => e.id).join(', ')}. ` +
        `Run the email copy generator first (fill subject, preheader, body_intro, etc.).`);
  }

  const lists = loadLists();
  const apiKey = env('MAILJET_API_KEY');
  const apiSecret = env('MAILJET_SECRET_KEY');
  const authHeader = basicAuth(apiKey, apiSecret);

  const results = [];
  for (const email of emails) {
    const listCfg = lists.lists[email.contacts_list_key];
    if (!listCfg) {
      results.push({ id: email.id, status: 'failed', stage: 'list-lookup', error: `unknown contacts_list_key: ${email.contacts_list_key}` });
      continue;
    }

    const templatePath = path.resolve(__dirname, '..', 'templates', `email-${email.stage}.html`);
    const textTemplatePath = path.resolve(__dirname, '..', 'templates', `email-${email.stage}.txt`);
    if (!fs.existsSync(templatePath)) {
      results.push({ id: email.id, status: 'failed', stage: 'template', error: `missing template: ${templatePath}` });
      continue;
    }

    const renderData = buildRenderData({ inputs, email, hostListing: posts, baseRunDir: runDir });
    const html = renderTemplate(fs.readFileSync(templatePath, 'utf8'), renderData);
    const text = fs.existsSync(textTemplatePath)
      ? renderTemplate(fs.readFileSync(textTemplatePath, 'utf8'), renderData)
      : '';

    if (dryRun) {
      results.push({ id: email.id, status: 'dry-run', stage: email.stage, list: listCfg, bytes_html: html.length });
      continue;
    }

    const rc = realtorConfig.flat();
    const sender = lists.default_sender || { email: rc.agent_email, name: rc.agent_name };
    const title = `${(email.scheduled_at_iso || '').slice(0, 10)} ${posts.address_short || inputs.address_short} ${email.stage}`.trim();

    // 1. create draft
    const create = await createDraft(authHeader, {
      subject: email.subject, senderEmail: sender.email, senderName: sender.name,
      listId: listCfg.id, title,
    });
    if (!create.ok) {
      results.push({ id: email.id, status: 'failed', stage: 'create', error: create.body });
      continue;
    }
    const draftId = create.body.Data[0].ID;

    // 2. set content
    const content = await setContent(authHeader, draftId, { html, text });
    if (!content.ok) {
      results.push({ id: email.id, draft_id: draftId, status: 'failed', stage: 'content', error: content.body });
      continue;
    }

    // 3. schedule (unless --draft)
    let scheduled = null;
    if (!draftOnly && email.scheduled_at_iso) {
      const sched = await scheduleSend(authHeader, draftId, email.scheduled_at_iso);
      if (!sched.ok) {
        results.push({ id: email.id, draft_id: draftId, status: 'failed', stage: 'schedule', error: sched.body });
        continue;
      }
      scheduled = sched.body.Data[0];
    }

    // 4. optional test send
    let tested = null;
    if (testEmail) {
      const t = await testSend(authHeader, draftId, testEmail);
      tested = { ok: t.ok, status: t.status, body: t.body };
    }

    results.push({
      id: email.id,
      stage: email.stage,
      draft_id: draftId,
      status: scheduled ? 'scheduled' : 'draft',
      send_at: scheduled ? scheduled.Date : null,
      list: { id: listCfg.id, name: listCfg.name },
      subject: email.subject,
      html_bytes: html.length,
      text_bytes: text.length,
      tested,
    });
    console.log(`${email.id} -> draft ${draftId} [${scheduled ? 'scheduled ' + scheduled.Date : 'draft'}]`);
  }

  const summary = {
    run_id: posts.run_id,
    api: MJ_API,
    draft_only: draftOnly,
    dry_run: dryRun,
    test_recipient: testEmail,
    scheduled_count: results.filter((r) => r.status === 'scheduled').length,
    draft_count: results.filter((r) => r.status === 'draft').length,
    failed_count: results.filter((r) => r.status === 'failed').length,
    total: results.length,
    drafts: results,
    scheduled_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runDir, 'mailjet-drafts.json'), JSON.stringify(summary, null, 2));
  console.log(`\nwrote mailjet-drafts.json`);
  console.log(`scheduled ${summary.scheduled_count}/${summary.total}  draft ${summary.draft_count}  failed ${summary.failed_count}`);
}

// Export helpers for unit tests. main() only runs when invoked as script.
module.exports = {
  renderTemplate, buildRenderData, textToHtmlParagraphs,
  featureRow, splitFeature, cityFromAddress, driveUrlFromId,
};

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

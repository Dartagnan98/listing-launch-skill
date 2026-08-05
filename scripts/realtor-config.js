#!/usr/bin/env node
/**
 * Loads config/realtor.json -- the single source of truth for everything
 * realtor-specific (name, brokerage, contact, branding, hashtags, domains).
 *
 * Written by Phase 0 onboarding on first run. Every other script reads it
 * through here so no realtor detail is ever hardcoded.
 *
 * Also exports flat() -- the token map that templates fill from.
 */
const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(SKILL_DIR, 'config', 'realtor.json');

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `config/realtor.json not found.\n` +
      `Run Phase 0 onboarding (see SKILL.md), or copy config/realtor.example.json ` +
      `to config/realtor.json and fill it in.`
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * Voice fingerprint + hashtag policy. Falls back to the shipped example so a
 * fresh clone can still draft copy before the realtor's profile is mined.
 */
function loadVoice() {
  const live = path.join(SKILL_DIR, 'config', 'voice.json');
  const example = path.join(SKILL_DIR, 'config', 'voice.example.json');
  const src = fs.existsSync(live) ? live : example;
  if (src === example) {
    console.warn('warning: config/voice.json not found, using generic defaults from voice.example.json');
  }
  return JSON.parse(fs.readFileSync(src, 'utf8'));
}

/** Resolve a config-relative asset path (e.g. "assets/logo-light.png") to file://. */
function assetUrl(relPath) {
  if (!relPath) return '';
  if (/^(https?|file|data):/.test(relPath)) return relPath;
  return 'file://' + path.resolve(SKILL_DIR, relPath);
}

/**
 * Google Fonts stylesheet URL for the configured heading + body faces.
 * Returns '' when branding.google_fonts is false, which is the default --
 * system fonts need no fetch, and a webfont the realtor is not licensed for
 * has no business being baked into her graphics.
 */
function googleFontsUrl(br, heading, body) {
  if (!br.google_fonts) return '';
  const fam = (n, w) => `family=${n.trim().replace(/\s+/g, '+')}:wght@${w}`;
  return 'https://fonts.googleapis.com/css2?' +
    [fam(heading, '400;500;600;700'), fam(body, '300;400;600;700')].join('&') +
    '&display=swap';
}

/**
 * Flat {{token}} map used by graphic templates and email templates.
 * Brokerage line collapses to "Example Realty . <designation>" when a
 * designation is set, otherwise just the brokerage name.
 */
function flat(cfg = load()) {
  const a = cfg.agent || {};
  const b = cfg.brokerage || {};
  const br = cfg.branding || {};
  const headingFont = br.heading_font || 'Georgia';
  const bodyFont = br.body_font || 'Helvetica';
  const brokerageLine = b.designation
    ? `${b.name} &middot; ${b.designation}`
    : (b.name || '');
  return {
    agent_name: a.name || '',
    agent_title: a.title || '',
    agent_email: a.email || '',
    agent_phone: a.phone_display || '',
    agent_phone_href: a.phone_href || '',
    agent_website: a.website_display || '',
    agent_website_url: a.website_url || '',
    brokerage_name: b.name || '',
    brokerage_designation: b.designation || '',
    brokerage_line: brokerageLine,
    brokerage_line_text: brokerageLine.replace(/&middot;/g, ','),
    team_name: b.team_name || b.name || '',
    team_title_line: [a.title, b.team_name].filter(Boolean).join(' &middot; '),
    team_title_line_text: [a.title, b.team_name].filter(Boolean).join(', '),
    footer_location: [b.team_name || b.name, b.city, b.region].filter(Boolean).join(', '),
    // How the realtor describes her market in prose, e.g. the email footer's
    // "new listings in <service_area>". Falls back to city + region.
    service_area: b.service_area || [b.city, b.region].filter(Boolean).join(', '),
    brand_logo: assetUrl(br.logo_light),
    brand_logo_dark: assetUrl(br.logo_dark || br.logo_light),
    // Palette. Defaults are deliberately neutral greys -- a missing config
    // should look unbranded, never like someone else's brand.
    primary_color: br.primary_color || '#1F2933',
    primary_soft_color: br.primary_soft_color || '#6B7A85',
    accent_color: br.accent_color || '#8A7B6B',
    text_color: br.text_color || '#2B2B2B',
    muted_color: br.muted_color || '#6A6A6A',
    muted_light_color: br.muted_light_color || '#9A9A9A',
    surface_color: br.surface_color || '#F5F3F0',
    surface_alt_color: br.surface_alt_color || '#F7F7F7',
    // Full-canvas tint for the templates that sit on a coloured ground.
    surface_tint_color: br.surface_tint_color || '#EAE9E5',
    border_color: br.border_color || '#E4E1DC',
    // Type. Fallbacks are system fonts so a fresh clone renders with no
    // webfont fetch at all.
    heading_font: headingFont,
    body_font: bodyFont,
    heading_font_stack: `'${headingFont}',${br.heading_font_fallback || 'Georgia, serif'}`,
    body_font_stack: `'${bodyFont}',${br.body_font_fallback || 'Helvetica, Arial, sans-serif'}`,
    google_fonts_url: googleFontsUrl(br, headingFont, bodyFont),
    // Short aliases the graphic templates use for the contact strip.
    phone: a.phone_display || '',
    email: a.email || '',
    website: a.website_display || '',
    city: b.city || '',
  };
}

/**
 * IANA timezone every scheduled time is computed in. All post and email times
 * are local to the realtor's market, so this must be her market's zone, not the
 * machine's. Falls back to the host system.
 */
function timezone(cfg = load()) {
  return (cfg.brokerage || {}).timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC';
}

module.exports = { load, loadVoice, flat, timezone, assetUrl, CONFIG_PATH, SKILL_DIR };

// ponytail: self-check. `node realtor-config.js --check` validates the example.
if (require.main === module && process.argv[2] === '--check') {
  const example = JSON.parse(
    fs.readFileSync(path.join(SKILL_DIR, 'config', 'realtor.example.json'), 'utf8')
  );
  const t = flat(example);
  const required = ['agent_name', 'agent_email', 'brokerage_name', 'brand_logo', 'agent_website_url'];
  const missing = required.filter((k) => !t[k]);
  if (missing.length) throw new Error(`flat() missing: ${missing.join(', ')}`);
  if (!t.brand_logo.startsWith('file://')) throw new Error('brand_logo must resolve to file://');
  console.log('ok', JSON.stringify(t, null, 2));
}

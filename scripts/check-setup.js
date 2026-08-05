#!/usr/bin/env node
/**
 * Setup preflight. Reports what is configured and what is still missing, so
 * Phase 0 can finish with a verified install instead of a hopeful one.
 *
 * Usage:
 *   node scripts/check-setup.js            # human-readable
 *   node scripts/check-setup.js --json     # machine-readable
 *
 * Env vars are reported PRESENT or MISSING only. Values are never printed,
 * never logged, and never written anywhere.
 *
 * Exit codes: 0 all green, 1 something required is missing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const cfg = (f) => path.join(SKILL_DIR, 'config', f);

// Load the host repo's .env the same way the pipeline does, so a key set there
// counts as present even when it is not exported in this shell.
function dotenvKeys() {
  const p = path.resolve(SKILL_DIR, '..', '..', '..', '.env');
  if (!fs.existsSync(p)) return new Set();
  return new Set(
    fs.readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.match(/^\s*([A-Z_]+)\s*=/))
      .filter(Boolean)
      .map((m) => m[1])
  );
}

function hasBinary(name) {
  return spawnSync('which', [name], { encoding: 'utf8' }).status === 0;
}

function jsonHasBlankIds(file, pick) {
  if (!fs.existsSync(file)) return null;
  try { return pick(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return 'unparseable'; }
}

function main() {
  const envKeys = dotenvKeys();
  const isSet = (k) => Boolean(process.env[k]) || envKeys.has(k);

  const checks = [];
  const add = (name, ok, required, fix) => checks.push({ name, ok, required, fix });

  // --- config files ---
  add('config/realtor.json', fs.existsSync(cfg('realtor.json')), true,
    'Run Phase 0, or copy config/realtor.example.json and fill it in.');
  add('config/voice.json', fs.existsSync(cfg('voice.json')), false,
    'Copy config/voice.example.json. Without it, copy uses generic defaults.');

  const bufIds = jsonHasBlankIds(cfg('buffer-channels.json'),
    (d) => Object.values(d.channels || {}).every((c) => c.id));
  add('config/buffer-channels.json', bufIds === true, true,
    bufIds === null
      ? 'Copy config/buffer-channels.example.json, then fill IDs from: node scripts/schedule-buffer.js --list-channels'
      : 'Channel IDs are blank. Fill them from: node scripts/schedule-buffer.js --list-channels');

  const mjIds = jsonHasBlankIds(cfg('mailjet-lists.json'),
    (d) => Object.values(d.lists || {}).every((l) => l.id));
  add('config/mailjet-lists.json', mjIds === true, true,
    mjIds === null
      ? 'Copy config/mailjet-lists.example.json and add your Mailjet list IDs.'
      : 'List IDs are blank or 0. Get them from the Mailjet contacts UI.');

  // A wrong timezone sends the whole campaign at the wrong hour, and it fails
  // silently, so surface it rather than trusting the default.
  let tz = null;
  if (fs.existsSync(cfg('realtor.json'))) {
    try { tz = (JSON.parse(fs.readFileSync(cfg('realtor.json'), 'utf8')).brokerage || {}).timezone; }
    catch { /* reported above */ }
  }
  add(`timezone${tz ? ` (${tz})` : ''}`, Boolean(tz), true,
    'Set brokerage.timezone in config/realtor.json to the realtor market\'s IANA zone.');

  // --- brand assets ---
  let logosOk = false, logoFix = 'Set branding.logo_light in config/realtor.json.';
  if (fs.existsSync(cfg('realtor.json'))) {
    try {
      const r = JSON.parse(fs.readFileSync(cfg('realtor.json'), 'utf8'));
      const rel = (r.branding || {}).logo_light;
      const abs = rel && path.resolve(SKILL_DIR, rel);
      logosOk = Boolean(abs && fs.existsSync(abs));
      if (!logosOk && rel) logoFix = `Logo file not found at ${rel}. Drop it in assets/.`;
    } catch { /* realtor.json check above already reports this */ }
  }
  add('brand logo', logosOk, false, logoFix);

  // --- credentials (presence only, values never read or printed) ---
  add('BUFFER_TOKEN', isSet('BUFFER_TOKEN'), true,
    'Buffer Publish > Account > Apps > Create Access Token. Add to .env yourself.');
  add('MAILJET_API_KEY', isSet('MAILJET_API_KEY'), true,
    'Mailjet > Account > API Key Management. Add to .env yourself.');
  add('MAILJET_SECRET_KEY', isSet('MAILJET_SECRET_KEY'), true,
    'Same Mailjet page as the API key. Add to .env yourself.');
  add('LOFTY_API_KEY', isSet('LOFTY_API_KEY'), false,
    'Optional. Only used for the Phase 6 CRM note.');

  // --- tooling ---
  add('gws CLI', hasBinary('gws'), true,
    'Install and log in with Drive + Docs scopes. Used to stage graphics.');
  let pw = false;
  try { require.resolve('playwright'); pw = true; } catch { /* not installed */ }
  add('playwright', pw, true, 'npm install playwright && npx playwright install chromium');

  const missingRequired = checks.filter((c) => c.required && !c.ok);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: missingRequired.length === 0, checks }, null, 2));
    return process.exit(missingRequired.length ? 1 : 0);
  }

  for (const c of checks) {
    const mark = c.ok ? 'ok      ' : (c.required ? 'MISSING ' : 'optional');
    console.log(`${mark} ${c.name}`);
    if (!c.ok) console.log(`         -> ${c.fix}`);
  }
  console.log(
    missingRequired.length
      ? `\n${missingRequired.length} required item(s) missing. Phases 1-3 still run; ` +
        `Buffer/Mailjet scheduling does not.`
      : '\nSetup complete.'
  );
  process.exit(missingRequired.length ? 1 : 0);
}

main();

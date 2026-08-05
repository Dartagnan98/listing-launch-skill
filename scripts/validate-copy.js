#!/usr/bin/env node
/**
 * Pre-flight validator for posts.json before Steps 4/5 push to Buffer + Mailjet.
 *
 * Checks:
 *   1. Every post has a non-empty `caption` and `hashtags` array.
 *   2. Every email has non-empty values for its prompt-backed fields
 *      (subject, preheader, body_intro, *_heading, *_body-ish, signoff).
 *   3. Word counts for each copy field fall within the target range parsed
 *      out of the matching *_prompt field's "Length: N-M words" line.
 *      Rule enforced (per 2026-04-21 correction): aim for the UPPER HALF
 *      of each range. The validator flags anything below the midpoint as
 *      a soft warning, below the floor as a hard failure.
 *   4. No banned phrases (em dashes, AI cliches from realtor-profile.md).
 *
 * Usage:
 *   node validate-copy.js <run-dir>
 *
 * Exit codes:
 *   0 = pass (all hard constraints met, ready for Buffer + Mailjet push)
 *   1 = file/structural error (missing fields, malformed JSON)
 *   2 = copy fails (under-length, banned phrases, empty fields)
 *
 * Also writes <run-dir>/copy-validation.json with the full report so later
 * steps + audits can see what was checked.
 */
const fs = require('fs');
const path = require('path');

const BANNED = [
  '—',                              // em dash
  'at the end of the day',          // podcast phrase, not writing
  'grain of salt',                  // podcast phrase
  'would you be opposed to',        // not her voice
  'nestled', 'oasis', 'stunning',   // AI real estate cliches
  'dream home', "don't miss", 'act fast',
  'hidden gem', 'tucked away',
];

function wc(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

function parseRange(promptText) {
  // Parse a length constraint out of the prompt. Supported forms (first match wins):
  //   "Length: 150-220 words"        -> words range
  //   "Max 60 characters"            -> chars with implicit floor of 1
  //   "Max 10 words"                 -> words with implicit floor of 1
  //   "90-110 character"             -> chars range
  //   "150-220 word"                 -> words range (fallback if "Length:" prefix missing)
  // Every prompt-backed field should have a detectable range -- if it doesn't,
  // add the range to the prompt in build-posts-skeleton.js.
  if (!promptText) return null;

  const wordsRange = promptText.match(/Length:\s*(\d+)\s*[-\u2013]\s*(\d+)\s*words?/i)
    || promptText.match(/(\d+)\s*[-\u2013]\s*(\d+)\s*word/i);
  if (wordsRange) return { kind: 'words', lo: +wordsRange[1], hi: +wordsRange[2] };

  const charsRange = promptText.match(/(\d+)\s*[-\u2013]\s*(\d+)\s*character/i);
  if (charsRange) return { kind: 'chars', lo: +charsRange[1], hi: +charsRange[2] };

  const wordsMax = promptText.match(/Max\s*(\d+)\s*word/i);
  if (wordsMax) return { kind: 'words', lo: 1, hi: +wordsMax[1], ceilingOnly: true };

  const charsMax = promptText.match(/Max\s*(\d+)\s*character/i);
  if (charsMax) return { kind: 'chars', lo: 1, hi: +charsMax[1], ceilingOnly: true };

  return null;
}

function check(content, range) {
  if (range == null) return { skipped: true };
  const count = range.kind === 'words' ? wc(content) : (content || '').length;
  // For ceilingOnly constraints ("Max N words/chars"), short is fine -- a short
  // heading is often better than a long one. Only flag OVER as hard fail.
  if (range.ceilingOnly) {
    const status = count > range.hi ? 'OVER' : 'OK';
    return { count, range, status };
  }
  const mid = (range.lo + range.hi) / 2;
  const status = count < range.lo ? 'UNDER'
    : count > range.hi ? 'OVER'
    : count < mid ? 'LOW-END'
    : 'OK';
  return { count, range, mid, status };
}

function runBannedCheck(blobs) {
  const text = blobs.join(' ').toLowerCase();
  return BANNED.filter(b => text.includes(b.toLowerCase()));
}

function main() {
  const runDir = path.resolve(process.argv[2] || '.');
  const postsPath = path.join(runDir, 'posts.json');
  if (!fs.existsSync(postsPath)) {
    console.error(`posts.json not found at ${postsPath}`);
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(postsPath, 'utf8'));

  const report = { run_id: d.run_id, posts: [], emails: [], banned: [], summary: {} };
  let hardFail = false;
  let softWarn = false;

  // --- Posts ---
  for (const p of (d.posts || [])) {
    const r = { id: p.id, checks: {} };
    if (!p.caption || !p.caption.trim()) {
      r.checks.caption = { status: 'MISSING' }; hardFail = true;
    } else {
      const range = parseRange(p.prompt);
      r.checks.caption = check(p.caption, range);
      if (r.checks.caption.status === 'UNDER' || r.checks.caption.status === 'OVER') hardFail = true;
      else if (r.checks.caption.status === 'LOW-END') softWarn = true;
    }
    if (!Array.isArray(p.hashtags) || p.hashtags.length === 0) {
      r.checks.hashtags = { status: 'MISSING' }; hardFail = true;
    } else {
      r.checks.hashtags = { status: 'OK', count: p.hashtags.length };
    }
    report.posts.push(r);
  }

  // --- Emails ---
  // Mapping: prompt field -> copy field. Matches the convention from
  // build-posts-skeleton.js.
  const PROMPT_FIELD_MAP = [
    ['subject_prompt', 'subject'],
    ['preheader_prompt', 'preheader'],
    ['body_intro_prompt', 'body_intro'],
    ['setting_heading_prompt', 'setting_heading'],
    ['setting_prompt', 'setting'],
    ['recreational_heading_prompt', 'recreational_heading'],
    ['recreational_prompt', 'recreational'],
    ['infrastructure_heading_prompt', 'infrastructure_heading'],
    ['infrastructure_prompt', 'infrastructure'],
    ['signoff_prompt', 'signoff'],
  ];

  for (const e of (d.emails || [])) {
    const r = { id: e.id, checks: {} };
    for (const [promptKey, fieldKey] of PROMPT_FIELD_MAP) {
      if (!(promptKey in e)) continue; // stage has no such prompt
      const content = e[fieldKey];
      if (!content || !content.toString().trim()) {
        r.checks[fieldKey] = { status: 'MISSING' };
        hardFail = true;
        continue;
      }
      const range = parseRange(e[promptKey]);
      if (!range) {
        r.checks[fieldKey] = { status: 'OK-no-range', count: wc(content) };
        continue;
      }
      const c = check(content, range);
      r.checks[fieldKey] = c;
      if (c.status === 'UNDER' || c.status === 'OVER') hardFail = true;
      else if (c.status === 'LOW-END') softWarn = true;
    }
    report.emails.push(r);
  }

  // --- Banned phrase scan ---
  const copyBlobs = [];
  for (const p of (d.posts || [])) copyBlobs.push(p.caption || '');
  for (const e of (d.emails || [])) {
    for (const [, fieldKey] of PROMPT_FIELD_MAP) copyBlobs.push(e[fieldKey] || '');
  }
  const hits = runBannedCheck(copyBlobs);
  report.banned = hits;
  if (hits.length) hardFail = true;

  report.summary = {
    hard_fail: hardFail,
    soft_warn: softWarn && !hardFail,
    posts_total: report.posts.length,
    emails_total: report.emails.length,
    banned_hits: hits.length,
  };

  // Write report
  fs.writeFileSync(path.join(runDir, 'copy-validation.json'), JSON.stringify(report, null, 2));

  // Human summary
  console.log(`validate-copy: run ${d.run_id}`);
  for (const p of report.posts) {
    const statuses = Object.entries(p.checks).map(([k, v]) => `${k}=${v.status}${v.count!=null ? '/'+v.count : ''}`).join(' ');
    console.log(`  post  ${p.id.padEnd(18)} ${statuses}`);
  }
  for (const e of report.emails) {
    const statuses = Object.entries(e.checks).map(([k, v]) => `${k}=${v.status}${v.count!=null ? '/'+v.count : ''}`).join(' ');
    console.log(`  email ${e.id.padEnd(20)} ${statuses}`);
  }
  if (hits.length) console.log(`  BANNED: ${hits.join(', ')}`);

  if (hardFail) {
    console.error('\nHARD FAIL: fix UNDER/OVER/MISSING/BANNED before Step 4 or 5.');
    process.exit(2);
  }
  if (softWarn) {
    console.warn('\nSOFT WARN: some sections sit in the bottom half of their prompt range. Rule is to target the UPPER HALF -- consider lengthening.');
  } else {
    console.log('\nall copy in target range, no banned phrases. ready for Buffer + Mailjet push.');
  }
}

main();

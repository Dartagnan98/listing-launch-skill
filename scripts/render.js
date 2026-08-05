#!/usr/bin/env node
/**
 * Render a marketing template HTML to PNG using Playwright.
 *
 * Usage:
 *   node render.js <template-name> <data-json-path> <output-png-path>
 *
 * Example:
 *   node render.js coming-soon-A /tmp/listing.json /tmp/out.png
 *
 * The data JSON holds canonical field values:
 *   {
 *     "main_photo": "https://...",
 *     "interior_photo": "https://...",
 *     "secondary_photo": "https://...",
 *     "address": "1234 Example Road",
 *     "price": "$539,900",
 *     "features": "2 Bed | 1 Bath | 864 sqft",
 *     "status_text": "Coming Soon",
 *     "open_house_datetime": "Saturday, May 4 | 12-2 PM"
 *   }
 * Contact fields (phone/email/website) keep their static Templated values unless you override.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const realtorConfig = require('./realtor-config');

async function main() {
  const [templateName, dataPath, outPath] = process.argv.slice(2);
  if (!templateName || !dataPath || !outPath) {
    console.error('usage: node render.js <template-name> <data-json> <output-png>');
    process.exit(1);
  }

  const skillDir = path.resolve(__dirname, '..');
  const htmlPath = path.join(skillDir, 'templates', 'html', `${templateName}.html`);
  if (!fs.existsSync(htmlPath)) {
    console.error(`template not found: ${htmlPath}`);
    process.exit(1);
  }

  const fileData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  // Brand tokens ({{brand_logo}}, colors, agent details) come from
  // config/realtor.json. Per-run data wins on any collision.
  const data = { ...realtorConfig.flat(), ...fileData };
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Drop the logo <img> entirely if the configured logo file is missing, rather
  // than rendering a broken-image box into a finished graphic.
  for (const token of ['brand_logo', 'brand_logo_dark']) {
    const local = String(data[token] || '').replace(/^file:\/\//, '');
    if (local && fs.existsSync(local)) continue;
    console.warn(`warning: ${token} not found (${local || 'unset'}), omitting logo`);
    html = html.replace(new RegExp(`<img[^>]*\\{\\{${token}\\}\\}[^>]*/?>`, 'g'), '');
  }

  // No webfont configured: drop the stylesheet link rather than leaving an
  // empty href for Playwright to resolve.
  if (!data.google_fonts_url) {
    html = html.replace(/<link[^>]*\{\{google_fonts_url\}\}[^>]*>/g, '');
  }

  // Rewrite broken Drive URL formats. The `drive.google.com/uc?id=X&export=download`
  // and `drive.google.com/open?id=X` forms return a virus-scan HTML interstitial
  // for files > ~25 MB, so Playwright fetches HTML instead of image bytes and
  // renders empty placeholders. `lh3.googleusercontent.com/d/<id>=w<px>` is the
  // direct CDN form that returns image bytes. Works after a single
  // `gws drive permissions create` with role:reader type:anyone.
  // Lesson: 2026-04-20 in listing-marketing/lessons.md.
  function rewriteDriveUrl(value) {
    if (typeof value !== 'string') return value;
    const driveIdMatch = value.match(
      /drive\.google\.com\/(?:uc\?id=|open\?id=|file\/d\/)([a-zA-Z0-9_-]+)/
    );
    if (!driveIdMatch) return value;
    return `https://lh3.googleusercontent.com/d/${driveIdMatch[1]}=w2000`;
  }

  // Inline file:// image URLs as base64 data URIs. Playwright's setContent uses
  // about:blank as the document origin, which blocks file:// fetches for CORS
  // reasons, so any photo passed in as file:// would render as a broken image.
  // Rewrite them before placeholder substitution.
  function maybeInline(value) {
    value = rewriteDriveUrl(value);
    if (typeof value !== 'string') return value;
    if (!value.startsWith('file://')) return value;
    const local = value.replace(/^file:\/\//, '');
    if (!fs.existsSync(local)) {
      console.warn(`file:// photo missing, leaving as-is: ${local}`);
      return value;
    }
    const ext = path.extname(local).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : 'application/octet-stream';
    const b64 = fs.readFileSync(local).toString('base64');
    return `data:${mime};base64,${b64}`;
  }

  // fill {{canonical_name}} placeholders
  for (const [k, v] of Object.entries(data)) {
    const re = new RegExp(`\\{\\{${k}\\}\\}`, 'g');
    const inlined = maybeInline(v);
    html = html.replace(re, String(inlined).replace(/"/g, '&quot;'));
  }

  // inline any file:// refs hardcoded into the template itself (e.g. brand logo)
  html = html.replace(/file:\/\/[^\s"'<>()]+/g, (m) => {
    const inlined = maybeInline(m);
    return inlined;
  });

  // warn on any placeholders left unfilled
  const remaining = [...html.matchAll(/\{\{([a-zA-Z_][\w-]*)\}\}/g)].map(m => m[1]);
  if (remaining.length) {
    const unique = [...new Set(remaining)];
    console.warn(`warning: unfilled placeholders: ${unique.join(', ')}`);
  }

  // read dimensions from meta
  const metaPath = path.join(skillDir, 'templates', 'source', `${templateName}.meta.json`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  // Target output: always 1080x1350 (IG 4:5 portrait), regardless of template's
  // native canvas size. Compute scale factor and apply it to #canvas via CSS
  // transform so baked layer coordinates render correctly at the target size.
  const TARGET_W = 1080, TARGET_H = 1350;
  const scale = Math.min(TARGET_W / meta.width, TARGET_H / meta.height);
  if (Math.abs(scale - 1) > 0.001) {
    // inject transform into #canvas inline style
    html = html.replace(
      /#canvas \{[^}]*\}/,
      (m) => m.replace('{', `{ transform: scale(${scale}); transform-origin: top left; `)
    );
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: TARGET_W, height: TARGET_H },
    deviceScaleFactor: 2, // 2x for crisp text
  });
  const page = await ctx.newPage();

  // Track every network response. We inspect these after setContent to catch
  // silent image failures (HTTP 200 HTML interstitial, 403, 404, etc.) that
  // would otherwise render as empty placeholders and ship bad graphics.
  const imageResponses = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    // Data URIs and about:blank are not interesting. We only care about http(s)
    // image requests from <img> tags.
    if (!/^https?:\/\//.test(url)) return;
    if (resp.request().resourceType() !== 'image') return;
    imageResponses.push({
      url,
      status: resp.status(),
      contentType: (resp.headers()['content-type'] || '').toLowerCase(),
    });
  });

  await page.setContent(html, { waitUntil: 'networkidle' });
  // give fonts a final tick
  await page.evaluateHandle('document.fonts.ready');

  // Verify every image actually loaded as image bytes. Fail loud on any of:
  //   - HTTP status >= 400
  //   - Content-Type is HTML (virus-scan interstitial is the classic failure)
  //   - <img>.naturalWidth === 0 (didn't decode)
  // Silent "broken placeholder" rendering is the bug that shipped the
  // 2026-04-20 a live listing graphics. This check prevents that class of bug.
  const brokenImgs = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#canvas img'));
    return imgs
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.src);
  });
  const badResponses = imageResponses.filter(
    (r) => r.status >= 400 || r.contentType.includes('text/html')
  );
  if (brokenImgs.length || badResponses.length) {
    await browser.close();
    console.error('BROKEN PHOTOS in render:');
    for (const src of brokenImgs) console.error(`  empty img: ${src}`);
    for (const r of badResponses) console.error(`  bad resp : ${r.status} ${r.contentType} ${r.url}`);
    console.error('\nLikely cause: Drive URLs in the `uc?id=X&export=download` or `open?id=X` format');
    console.error('hit the virus-scan interstitial (HTML, not image bytes). The render.js auto-rewriter');
    console.error('should catch most of these -- if you see this, inputs.json has a URL format we have not');
    console.error('mapped yet. Use lh3.googleusercontent.com/d/<id>=w2000 directly in inputs.json.');
    process.exit(2);
  }

  // autofit: Templated shrinks text to fit the bounding box. Replicate that
  // by iterating each text layer, measuring overflow, scaling font-size down
  // until the inner span fits in both axes. Min floor = 40% of original.
  await page.evaluate(() => {
    const nodes = document.querySelectorAll('#canvas [data-field], #canvas [data-layer]');
    const fits = (box, span) =>
      span.scrollWidth <= box.clientWidth + 1 &&
      span.scrollHeight <= box.clientHeight + 1;
    for (const box of nodes) {
      const span = box.querySelector(':scope > span');
      if (!span) continue;
      const cs = getComputedStyle(box);
      const start = parseFloat(cs.fontSize);
      if (!start) continue;
      let size = start;
      const floor = Math.max(8, start * 0.4);
      // fast shrink loop
      while (!fits(box, span) && size > floor) {
        size -= 1;
        box.style.fontSize = size + 'px';
      }
    }
  });

  // screenshot the viewport clip, not the element box -- because the element
  // may be transform-scaled and its reported box differs from the visible area.
  await page.screenshot({
    path: outPath,
    clip: { x: 0, y: 0, width: TARGET_W, height: TARGET_H },
    omitBackground: false,
  });
  await browser.close();
  console.log(`wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });

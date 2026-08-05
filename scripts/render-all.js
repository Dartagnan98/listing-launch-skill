#!/usr/bin/env node
/**
 * Render all 3 campaign graphics (coming-soon / just-listed / open-house)
 * for a single marketing run.
 *
 * Usage:
 *   node render-all.js <inputs-json-path> [--counter <N>]
 *
 * Reads data/marketing/counter.json (or --counter override) to pick A/B/C.
 * Writes:
 *   <run-dir>/data-coming-soon.json
 *   <run-dir>/data-just-listed.json
 *   <run-dir>/data-open-house.json
 *   <run-dir>/graphics/coming-soon.png
 *   <run-dir>/graphics/just-listed.png
 *   <run-dir>/graphics/open-house.png
 *
 * Does NOT increment the counter - that happens in step 7 after everything else succeeds.
 */
const fs = require('fs');
const realtorConfig = require('./realtor-config');
const path = require('path');
const { spawnSync } = require('child_process');

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node render-all.js <inputs-json-path> [--counter <N>]');
    process.exit(1);
  }
  const inputsPath = path.resolve(args[0]);
  const counterIdx = args.indexOf('--counter');
  const counterOverride = counterIdx >= 0 ? parseInt(args[counterIdx + 1], 10) : null;

  const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));
  const runDir = path.dirname(inputsPath);
  const graphicsDir = path.join(runDir, 'graphics');
  fs.mkdirSync(graphicsDir, { recursive: true });

  // pick A/B/C + load realtor config
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const counterPath = path.join(repoRoot, 'data', 'marketing', 'counter.json');
  const configPath = path.join(repoRoot, 'data', 'marketing', 'config.json');
  // config/realtor.json is the source of truth; the legacy host-repo
  // data/marketing/config.json only overrides it if it exists.
  const config = { ...realtorConfig.flat(),
    ...(fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}) };
  let counter = counterOverride;
  if (counter == null) {
    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8')).counter || 0;
  }
  // Rotation set 2026-04-21: D and E only, the two approved template sets.
  // Rotation keeps consecutive listings from looking identical.
  const ROTATION = ['D', 'E'];
  const variant = process.env.MARKETING_VARIANT_OVERRIDE || ROTATION[counter % ROTATION.length];
  console.log(`using variant ${variant} (counter=${counter}, rotation=${ROTATION.join('/')})`);

  const stages = [
    { key: 'coming-soon', status: 'Coming Soon' },
    { key: 'just-listed', status: 'Just Listed' },
    { key: 'open-house', status: 'Open House' },
  ];

  const renderScript = path.join(__dirname, 'render.js');
  const htmlDir = path.join(__dirname, '..', 'templates', 'html');

  const results = [];
  for (const s of stages) {
    const dataJson = {
      main_photo: inputs.main_photo,
      interior_photo: inputs.interior_photo,
      secondary_photo: inputs.secondary_photo,
      address: inputs.address_short || inputs.address,
      price: inputs.price,
      features: inputs.features_line,
      status_text: s.status,
      open_house_datetime: inputs.open_house_display,
      phone: config.phone || '',
      email: config.email || '',
      website: config.website || '',
    };
    const dataPath = path.join(runDir, `data-${s.key}.json`);
    fs.writeFileSync(dataPath, JSON.stringify(dataJson, null, 2));

    const templateName = `${s.key}-${variant}`;
    const htmlExists = fs.existsSync(path.join(htmlDir, `${templateName}.html`));
    if (!htmlExists) {
      console.error(`missing template html: ${templateName}.html`);
      results.push({ stage: s.key, ok: false, error: 'template not found' });
      continue;
    }

    const outPng = path.join(graphicsDir, `${s.key}.png`);
    console.log(`rendering ${templateName} -> ${outPng}`);
    const r = spawnSync('node', [renderScript, templateName, dataPath, outPng], { stdio: 'inherit' });
    if (r.status !== 0) {
      // Render failed -- fall back to the OTHER variant in the rotation
      // (D <-> E). We deliberately do NOT fall back to A/B/C; those are
      // archived per 2026-04-21.
      const fallbackVariant = ROTATION[(ROTATION.indexOf(variant) + 1) % ROTATION.length];
      const fallbackName = `${s.key}-${fallbackVariant}`;
      console.warn(`retry with fallback variant ${fallbackVariant}`);
      const r2 = spawnSync('node', [renderScript, fallbackName, dataPath, outPng], { stdio: 'inherit' });
      results.push({
        stage: s.key,
        ok: r2.status === 0,
        template: r2.status === 0 ? fallbackName : templateName,
        fallback: r2.status === 0,
        error: r2.status === 0 ? null : `exit ${r2.status}`,
      });
    } else {
      results.push({ stage: s.key, ok: true, template: templateName, fallback: false });
    }
  }

  const summary = { variant, counter, results };
  fs.writeFileSync(path.join(runDir, 'render-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (results.some(r => !r.ok)) process.exit(2);
}

main();

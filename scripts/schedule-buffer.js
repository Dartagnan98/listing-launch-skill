#!/usr/bin/env node
/**
 * Schedule posts to Buffer from posts.json.
 *
 * Uses Buffer's GraphQL API at https://api.buffer.com/ with OIDC Bearer token.
 * The legacy v1 REST (`bufferapp.com`) rejects OIDC tokens -- do NOT use it.
 *
 * Per post per channel: one createPost mutation with customScheduled mode +
 * dueAt timestamp from posts.json's scheduled_at_iso.
 *
 * Flow per post:
 *   1. Upload graphic to Drive (cached -- open-house graphic used twice).
 *   2. Set Drive permission to anyone-with-link reader.
 *   3. For each channel the post targets, call createPost with the Drive URL.
 *   4. Collect post IDs.
 *
 * Usage:
 *   node schedule-buffer.js <run-dir>
 *
 * Required env:
 *   BUFFER_TOKEN               OIDC token from Buffer Publish > Account > Apps
 *   LISTING_DRIVE_PARENT       Drive folder to stage graphics (fallback: drive.listing_parent in config/realtor.json)
 *
 * Channel config read from .claude/skills/marketing/config/buffer-channels.json.
 * posts.json `platforms: ["instagram", "facebook"]` maps to the brand-scoped
 * channels -- defaults to default_listing_targets in config/buffer-channels.json. Override per-post
 * with `channels: ["primary_ig", "secondary_ig"]` or similar.
 *
 * Reads:   <run-dir>/posts.json   (captions must be filled)
 *          <run-dir>/graphics/*.png
 * Writes:  <run-dir>/buffer-updates.json
 *
 * Failure handling: per SKILL.md "don't abort the pipeline" rule, a Buffer
 * rejection for one (post, channel) pair is recorded as status=failed and the
 * script exits 0 so step 5 (emails) can still run.
 */
const fs = require('fs');
const realtorConfig = require('./realtor-config');
const path = require('path');
const { spawnSync } = require('child_process');


const BUFFER_API = 'https://api.buffer.com/';
const CHANNELS_CONFIG = path.resolve(
  __dirname,
  '..',
  'config',
  'buffer-channels.json',
);

function die(msg) { console.error(msg); process.exit(1); }

function env(name, required = true) {
  const v = process.env[name];
  if (!v && required) die(`missing env var: ${name}`);
  return v || '';
}

function loadChannels() {
  if (!fs.existsSync(CHANNELS_CONFIG)) die(`buffer-channels.json not found at ${CHANNELS_CONFIG}`);
  return JSON.parse(fs.readFileSync(CHANNELS_CONFIG, 'utf8'));
}

function runGws(args, opts = {}) {
  const r = spawnSync('gws', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`gws ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function driveUpload(localPath, parentId) {
  const name = path.basename(localPath);
  const params = JSON.stringify({
    uploadType: 'multipart',
    fields: 'id,name,webContentLink,webViewLink',
  });
  const body = JSON.stringify({ name, parents: [parentId] });
  const out = runGws([
    'drive', 'files', 'create',
    '--params', params,
    '--json', body,
    '--upload', localPath,
    '--upload-content-type', 'image/png',
  ]);
  return JSON.parse(out);
}

function drivePublicLink(fileId) {
  const body = JSON.stringify({ role: 'reader', type: 'anyone' });
  runGws([
    'drive', 'permissions', 'create',
    '--params', JSON.stringify({ fileId }),
    '--json', body,
  ]);
  return `https://drive.google.com/uc?id=${fileId}&export=download`;
}

async function gql(token, query, variables) {
  const res = await fetch(BUFFER_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  return { ok: res.ok && !json.errors, status: res.status, body: json };
}

const CREATE_POST_MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      __typename
      ... on PostActionSuccess {
        post { id status dueAt channel { id service name } }
      }
      ... on MutationError {
        message
      }
    }
  }
`;

// Per-service metadata. Buffer requires a `type` on IG + FB posts (values from
// PostType / PostTypeFacebook enums). Defaults everything we care about here to
// "post" -- graphics are single-image feed posts, not reels/stories.
function buildMetadata(service) {
  if (service === 'instagram') {
    return { instagram: { type: 'post', shouldShareToFeed: true } };
  }
  if (service === 'facebook') {
    return { facebook: { type: 'post' } };
  }
  return undefined;
}

async function createPost({ token, channelId, service, text, imageUrl, dueAtIso, schedulingType, saveToDraft }) {
  const input = {
    channelId,
    text,
    schedulingType,                  // "automatic" for FB + IG business accounts
    mode: 'customScheduled',         // always customScheduled -- we compute dueAt from posts.json
    dueAt: dueAtIso,
    assets: { images: [{ url: imageUrl }] },
    source: 'marketing-skill',
    saveToDraft: !!saveToDraft,      // when true, lands in Drafts folder with the same dueAt as target
  };
  const metadata = buildMetadata(service);
  if (metadata) input.metadata = metadata;
  return gql(token, CREATE_POST_MUTATION, { input });
}

function composeText(post) {
  const tags = (post.hashtags || []).join(' ');
  return tags ? `${post.caption}\n\n${tags}` : post.caption;
}

function resolveChannels(post, channelsCfg) {
  // Prefer explicit channel keys on the post; else map platforms -> defaults.
  if (Array.isArray(post.channels) && post.channels.length) {
    return post.channels
      .map((key) => channelsCfg.channels[key])
      .filter(Boolean);
  }
  const platforms = post.platforms || [];
  const defaults = channelsCfg.default_listing_targets || [];
  return defaults
    .map((key) => channelsCfg.channels[key])
    .filter((c) => c && platforms.includes(c.service));
}

async function main() {
  // Onboarding helper: dump the account's channel IDs so Phase 0 can fill in
  // config/buffer-channels.json without hunting through the Buffer UI.
  if (process.argv.includes('--list-channels')) {
    const res = await gql(env('BUFFER_TOKEN'), '{ account { channels { id name service } } }', {});
    const channels = res.body?.data?.account?.channels;
    if (!channels) {
      console.error('could not read channels from Buffer:');
      console.error(JSON.stringify(res.body, null, 2));
      console.error('\nFallback: Buffer Publish > channel settings, the id is in the URL.');
      process.exit(2);
    }
    for (const c of channels) console.log(`${c.id}  ${c.service.padEnd(10)} ${c.name}`);
    return;
  }

  const runDir = path.resolve(process.argv[2] || '.');
  const postsPath = path.join(runDir, 'posts.json');
  if (!fs.existsSync(postsPath)) die(`posts.json not found at ${postsPath}`);

  const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
  const unfilled = posts.posts.filter((p) => !p.caption || p.caption.trim() === '');
  if (unfilled.length) {
    die(`posts.json has unfilled captions: ${unfilled.map((p) => p.id).join(', ')}. Run copy generator first.`);
  }

  const token = env('BUFFER_TOKEN');
  const driveParent = process.env.LISTING_DRIVE_PARENT ||
    (realtorConfig.load().drive || {}).listing_parent ||
    die('no Drive parent: set LISTING_DRIVE_PARENT or drive.listing_parent in config/realtor.json');
  const channelsCfg = loadChannels();
  const dryRun = process.argv.includes('--dry-run');
  const saveToDraft = process.argv.includes('--draft');

  // Pre-flight rate-limit probe. Buffer's rate limit is a 24h window -- if we
  // are locked, every subsequent createPost will fail. Skipping this check
  // wastes Drive uploads (each graphic gets uploaded before the first Buffer
  // call) and leaves orphan Drive files. Fail fast instead.
  if (!dryRun) {
    console.log('preflight: checking Buffer rate limit...');
    const probe = await gql(token, '{ account { id } }', {});
    if (probe.body && probe.body.errors) {
      const rateLimited = probe.body.errors.some((e) =>
        e.extensions?.code === 'RATE_LIMIT_EXCEEDED' || /too many requests|rate limit/i.test(e.message || '')
      );
      if (rateLimited) {
        const window = probe.body.errors[0].extensions?.window || 'unknown';
        die(`Buffer is rate-limited (window: ${window}). Aborting before Drive uploads.\n` +
            `No graphics will be uploaded. Retry after the window clears.\n` +
            `To continue now, promote drafts manually in the Buffer UI.`);
      }
      die(`Buffer API returned errors on preflight: ${JSON.stringify(probe.body.errors)}`);
    }
    console.log('preflight: Buffer OK, proceeding.');
  }
  // Instagram business + FB page + Buffer paid plan = automatic. All three required.
  // Fallback to notification for the first live test if automatic errors -- set via flag.
  const schedulingType = process.argv.includes('--notification') ? 'notification' : 'automatic';

  // upload graphics once, cache by local file path
  const mediaCache = new Map();
  async function uploadGraphic(relPath) {
    const abs = path.join(runDir, relPath);
    if (!fs.existsSync(abs)) throw new Error(`graphic missing: ${abs}`);
    if (mediaCache.has(abs)) return mediaCache.get(abs);
    if (dryRun) {
      const rec = { drive_file_id: 'DRY_RUN', drive_url: `file://${abs}`, web_view_link: null };
      mediaCache.set(abs, rec);
      return rec;
    }
    console.log(`uploading ${relPath} to Drive...`);
    const meta = driveUpload(abs, driveParent);
    const url = drivePublicLink(meta.id);
    const rec = { drive_file_id: meta.id, drive_url: url, web_view_link: meta.webViewLink };
    mediaCache.set(abs, rec);
    return rec;
  }

  const results = [];
  for (const post of posts.posts) {
    const dueAtIso = post.scheduled_at_iso;
    const text = composeText(post);
    const targets = resolveChannels(post, channelsCfg);

    if (!targets.length) {
      results.push({
        id: post.id, status: 'failed', stage: 'resolve-channels',
        error: `no channels resolved for platforms=${JSON.stringify(post.platforms)}`,
      });
      continue;
    }

    let media;
    try {
      media = await uploadGraphic(post.graphic);
    } catch (e) {
      console.error(`upload failed for ${post.id}: ${e.message}`);
      results.push({ id: post.id, status: 'failed', stage: 'upload', error: e.message });
      continue;
    }

    const perChannel = [];
    for (const ch of targets) {
      console.log(`scheduling ${post.id} -> ${ch.service}/${ch.name} at ${dueAtIso}${saveToDraft ? ' [DRAFT]' : ''}${dryRun ? ' [DRY]' : ''}`);
      if (dryRun) {
        perChannel.push({
          channel_key: Object.keys(channelsCfg.channels).find((k) => channelsCfg.channels[k].id === ch.id),
          channel_id: ch.id, service: ch.service, name: ch.name,
          status: 'dry-run', dueAt: dueAtIso,
        });
        continue;
      }
      // Retry up to 4x on transient Buffer-side errors:
      //   1. image-dimension fetch (502/503) -- just-uploaded graphic not yet
      //      indexed by Drive, short backoff lets it catch up
      //   2. rate limit ("Too many requests") -- can happen after many
      //      create/delete cycles in a short window, needs a longer cool-off
      // We classify both as transient but apply very different backoffs.
      const IMG_TRANSIENT = [
        /bad gateway/i, /service unavailable/i, /gateway timeout/i,
        /failed to fetch image dimensions/i,
      ];
      const RATE_LIMIT = [
        /too many requests/i, /rate limit/i, /throttle/i, /429/,
      ];
      const kind = (msg) => {
        if (RATE_LIMIT.some((re) => re.test(msg || ''))) return 'rate-limit';
        if (IMG_TRANSIENT.some((re) => re.test(msg || ''))) return 'img-transient';
        return null;
      };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const backoffMs = (k, attempt) => {
        // attempt is 1-indexed
        if (k === 'rate-limit') return [30000, 60000, 90000, 120000][attempt - 1] || 120000;
        if (k === 'img-transient') return [2000, 5000, 10000, 15000][attempt - 1] || 15000;
        return 1000;
      };

      let resp, result, lastErr;
      const MAX_ATTEMPTS = 4;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          resp = await createPost({
            token, channelId: ch.id, service: ch.service, text,
            imageUrl: media.drive_url, dueAtIso, schedulingType, saveToDraft,
          });
        } catch (e) {
          lastErr = { stage: 'network', error: e.message };
          if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
          break;
        }
        if (!resp.ok) {
          const errMsg = resp.body.errors ? resp.body.errors.map((e) => e.message).join('; ') : `http ${resp.status}`;
          const k = kind(errMsg);
          lastErr = { stage: 'gql', error: errMsg, raw: resp.body };
          if (k && attempt < MAX_ATTEMPTS) {
            const backoff = backoffMs(k, attempt);
            console.log(`  retry ${attempt+1}/${MAX_ATTEMPTS} after ${k} (${Math.round(backoff/1000)}s): ${errMsg}`);
            await sleep(backoff);
            continue;
          }
          break;
        }
        result = resp.body.data && resp.body.data.createPost;
        if (!result) {
          lastErr = { stage: 'empty-result', raw: resp.body };
          break;
        }
        if (result.__typename !== 'PostActionSuccess') {
          const k = kind(result.message);
          lastErr = { stage: 'mutation-error', typename: result.__typename, error: result.message };
          if (k && attempt < MAX_ATTEMPTS) {
            const backoff = backoffMs(k, attempt);
            console.log(`  retry ${attempt+1}/${MAX_ATTEMPTS} after ${k} (${Math.round(backoff/1000)}s): ${result.message}`);
            await sleep(backoff);
            continue;
          }
          break;
        }
        // Success -- clear error and break
        lastErr = null;
        break;
      }
      if (lastErr) {
        perChannel.push({
          channel_id: ch.id, service: ch.service,
          status: 'failed', ...lastErr,
        });
        continue;
      }
      perChannel.push({
        channel_id: ch.id, service: ch.service, name: ch.name,
        status: 'scheduled',
        post_id: result.post && result.post.id,
        dueAt: result.post && result.post.dueAt,
        post_status: result.post && result.post.status,
      });
    }

    const anyOk = perChannel.some((r) => r.status === 'scheduled' || r.status === 'dry-run');
    results.push({
      id: post.id,
      status: anyOk ? (perChannel.every((r) => r.status === 'scheduled' || r.status === 'dry-run') ? 'scheduled' : 'partial') : 'failed',
      scheduled_at_iso: dueAtIso,
      channels: perChannel,
      media,
    });
  }

  const summary = {
    run_id: posts.run_id,
    api: BUFFER_API,
    scheduling_type: schedulingType,
    save_to_draft: saveToDraft,
    dry_run: dryRun,
    scheduled_count: results.filter((r) => r.status === 'scheduled').length,
    partial_count: results.filter((r) => r.status === 'partial').length,
    failed_count: results.filter((r) => r.status === 'failed').length,
    total_posts: results.length,
    results,
    scheduled_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runDir, 'buffer-updates.json'), JSON.stringify(summary, null, 2));
  console.log(`\nwrote buffer-updates.json`);
  console.log(`scheduled ${summary.scheduled_count}/${summary.total_posts}  partial ${summary.partial_count}  failed ${summary.failed_count}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

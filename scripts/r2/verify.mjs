// The report to read before anything is deleted from Supabase or the plan is changed.
//
//   node verify.mjs                 everything below, printed and saved to logs/report-<time>.md
//   node verify.mjs --since <ISO>   when the app started uploading to R2 (default: first such post)
//
// It reads and never writes: object counts and sizes on both sides, every row that says its
// file is on R2 checked with a HEAD for the file and its still, sizes before and after,
// whatever failed, and the newest uploads from the app looked at with ffprobe to say whether
// they are what every phone plays (H.264, AAC, 8-bit 4:2:0, index at the front). Whether
// they actually play on an iPhone and an Android phone is for a person with both to say.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { config, supabase, r2, r2Endpoint, probe, mb, enc, LOGS, STATE, VIDEO, STORY_PREFIX } from './lib.mjs';

const argv = process.argv.slice(2);
const since = (() => { const i = argv.indexOf('--since'); return i >= 0 ? argv[i + 1] : null; })();
const cfg = config();
const sb = supabase(cfg), store = r2(cfg);
const aws = new AwsClient({ accessKeyId: cfg.R2_ACCESS_KEY_ID, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
const objUrl = key => `${r2Endpoint(cfg)}/${cfg.R2_BUCKET}/${enc(key)}`;
const getUrl = async key => (await aws.sign(`${objUrl(key)}?X-Amz-Expires=600`, { aws: { signQuery: true } })).url;

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const sum = xs => xs.reduce((a, x) => a + x, 0);

// Is the index at the front? The first 'moov' box has to come before the first 'mdat'.
async function faststart(key) {
  const res = await aws.fetch(objUrl(key), { headers: { Range: 'bytes=0-262143' } });
  const b = Buffer.from(await res.arrayBuffer());
  for (let at = 0; at + 8 <= b.length;) {
    const size = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (size < 8) return null;
    at += size;
  }
  return null;
}

async function main() {
  const [posts, stories, proofObjs, storyObjs, onR2] = await Promise.all([
    sb.rows('posts', 'id,video_path,video_store,legacy_video_path,created_at'),
    sb.rows('stories', 'id,media_path,media_store,legacy_media_path,created_at').catch(() => []),
    sb.list('proof'), sb.list('stories').catch(() => []), store.list(),
  ]);
  const sup = new Map([...proofObjs.map(o => [`proof|${o.path}`, o]), ...storyObjs.map(o => [`stories|${o.path}`, o])]);
  const r2map = new Map(onR2.map(o => [o.key, o]));
  say(`# Proof on R2: verification report`);
  say(`${new Date().toISOString()}`);
  say();
  say(`## Objects`);
  say(`- Supabase \`proof\`: ${proofObjs.length} objects, ${mb(sum(proofObjs.map(o => o.size)))}` + (storyObjs.length ? `; \`stories\`: ${storyObjs.length}, ${mb(sum(storyObjs.map(o => o.size)))}` : ''));
  const r2stories = onR2.filter(o => o.key.startsWith(STORY_PREFIX));
  say(`- R2 \`${cfg.R2_BUCKET}\`: ${onR2.length} objects, ${mb(sum(onR2.map(o => o.size)))}` + (r2stories.length ? ` (${r2stories.length} of them stories)` : ''));

  // Every row that says R2, checked object by object.
  const rows = [
    ...posts.filter(r => r.video_store === 'r2').map(r => ({ t: 'posts', id: r.id, key: r.video_path, legacy: r.legacy_video_path, bucket: 'proof', at: r.created_at })),
    ...stories.filter(r => r.media_store === 'r2').map(r => ({ t: 'stories', id: r.id, key: r.media_path, legacy: r.legacy_media_path, bucket: 'stories', at: r.created_at })),
  ];
  const missing = [];
  for (const r of rows) {
    const h = r2map.get(r.key) || await store.head(r.key);
    if (!h) missing.push(`${r.t} ${r.id}: ${r.key} (the file)`);
    if (VIDEO.test(r.key) && r.bucket === 'proof' && !(r2map.get(`${r.key}.jpg`) || await store.head(`${r.key}.jpg`))) missing.push(`${r.t} ${r.id}: ${r.key}.jpg (its still)`);
  }
  const left = [
    ...posts.filter(r => r.video_store !== 'r2' && r.video_path).map(r => ({ t: 'posts', id: r.id, path: r.video_path, has: sup.has(`proof|${r.video_path}`) })),
    ...stories.filter(r => r.media_store !== 'r2' && r.media_path).map(r => ({ t: 'stories', id: r.id, path: r.media_path, has: sup.has(`stories|${r.media_path}`) })),
  ];
  say();
  say(`## Rows`);
  say(`- posts: ${posts.length} · on R2: ${posts.filter(r => r.video_store === 'r2').length} · still on Supabase: ${posts.filter(r => r.video_store !== 'r2' && r.video_path).length}`);
  say(`- stories: ${stories.length} · on R2: ${stories.filter(r => r.media_store === 'r2').length} · still on Supabase: ${stories.filter(r => r.media_store !== 'r2' && r.media_path).length}`);
  say(`- every R2 row has its file${'s'} and still in R2 (HEAD): ${missing.length ? `NO — ${missing.length} missing` : 'yes'} (${rows.length} rows checked)`);
  for (const m of missing) say(`  - missing: ${m}`);

  // Before and after, for what the copy moved.
  const moved = rows.filter(r => r.legacy);
  const before = sum(moved.map(r => (sup.get(`${r.bucket}|${r.legacy}`) || { size: 0 }).size));
  const beforeStills = sum(moved.map(r => (sup.get(`${r.bucket}|${r.legacy}.jpg`) || { size: 0 }).size));
  const after = sum(moved.map(r => (r2map.get(r.key) || { size: 0 }).size));
  const afterStills = sum(moved.map(r => (r2map.get(`${r.key}.jpg`) || { size: 0 }).size));
  say();
  say(`## Size`);
  say(`- copied by the script: ${moved.length} files, ${mb(before)} on Supabase -> ${mb(after)} on R2${before ? ` (${Math.round((1 - after / before) * 100)}% smaller)` : ''}`);
  say(`- their stills: ${mb(beforeStills)} -> ${mb(afterStills)} (stills made for clips that had none are in the second figure)`);

  // What went wrong.
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { done: {}, failed: {} };
  const kept = Object.entries(state.done || {}).filter(([, d]) => d.kept === 'original');
  say();
  say(`## Failures`);
  if (!left.length && !Object.keys(state.failed || {}).length) say('- none');
  for (const r of left) say(`- ${r.t} ${r.id}: ${r.path} not copied${r.has ? '' : ' — the file is not in the bucket at all'}${state.failed?.[`${r.t}:${r.id}`] ? ` (${state.failed[`${r.t}:${r.id}`].error})` : ''}`);
  if (kept.length) say(`- copied as the original bytes rather than re-encoded: ${kept.length} (${kept.slice(0, 10).map(([k, d]) => `${k}: ${d.why}`).join('; ')}${kept.length > 10 ? '; …' : ''})`);

  // New uploads from the app: rows on R2 the script did not make.
  const fresh = posts.filter(r => r.video_store === 'r2' && !r.legacy_video_path).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const from = since || fresh[0]?.created_at;
  const after0 = from ? posts.filter(r => Date.parse(r.created_at) >= Date.parse(from)) : [];
  say();
  say(`## New uploads`);
  if (!from) say('- none from the app yet');
  else {
    say(`- since ${from}: ${after0.length} posts, ${after0.filter(r => r.video_store === 'r2').length} on R2, ${after0.filter(r => r.video_store !== 'r2').length} not`);
    for (const r of fresh.slice(-5).filter(r => VIDEO.test(r.video_path))) {
      const p = await probe(await getUrl(r.video_path));
      const v = p?.video, a = p?.audio, h = r2map.get(r.video_path) || await store.head(r.video_path);
      const fs = await faststart(r.video_path).catch(() => null);
      say(`- post ${r.id} (${r.created_at}): ${h ? mb(h.size) : 'MISSING'} · ${v ? `${v.codec_name} ${v.profile || ''} ${v.width}x${v.height} ${v.pix_fmt}` : 'no video'} · ${a ? `${a.codec_name} ${Math.round((+a.bit_rate || 0) / 1000)}k` : 'no audio'} · ${p ? `${p.duration.toFixed(1)}s` : ''} · index ${fs === true ? 'at the front' : fs === false ? 'AT THE END' : 'unknown'}`);
    }
    say('- plays on iPhone Safari / Android Chrome: to be confirmed on the phones themselves');
  }

  mkdirSync(LOGS, { recursive: true });
  const out = join(LOGS, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nSaved to ${out}`);
  if (missing.length) process.exitCode = 1;
}
main().catch(e => { console.error(e.message || e); process.exit(1); });

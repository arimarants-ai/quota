// Copies every clip and picture behind a post (and a story) from the Supabase `proof`
// bucket to R2, shrinking the clips on the way, and points the rows at the copies.
//
//   node migrate.mjs --dry-run          what it would do, and roughly what it would save
//   node migrate.mjs --limit 5          the first five rows, for real
//   node migrate.mjs                    everything left
//   node migrate.mjs --concurrency 3    more at once (default 2)
//   node migrate.mjs --no-probe         a dry run without reading any clip's index
//
// Nothing in Supabase is deleted or overwritten. A row is only touched once its copy (and
// the still beside it) is in R2 and reads back at the right size, and then only if it still
// points where it did. Run it again and it picks up where it stopped: a row already on R2
// is skipped, and one whose copy is already up is only re-pointed. Every step goes to
// logs/migrate-<time>.log, and what has been done to state.json.
//
// Each clip becomes H.264 + AAC in an MP4 under the same name with .mp4 on the end: 720 on
// its short side at most, about 1.8 Mbps, AAC at 96k, at most 30 frames a second, index at
// the front, and no metadata carried over (an iPhone clip carries where it was filmed). If
// ffmpeg fails, or the result is no smaller, the original bytes go up instead. A clip with
// no still gets one made from the copy, the way the app makes them.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config, supabase, r2, haveFfmpeg, run, probe, logger, retry, mb, WORK, STATE, VIDEO, IMAGE, STORY_PREFIX, ENCODE } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DRY = flag('--dry-run'), PROBE = !flag('--no-probe');
const LIMIT = opt('--limit') ? Math.max(0, parseInt(opt('--limit'), 10)) : Infinity;
const CONC = Math.max(1, parseInt(opt('--concurrency', '2'), 10) || 2);

const cfg = config();
const sb = supabase(cfg), store = r2(cfg);
const ff = haveFfmpeg();
if (!ff) { console.error('ffmpeg and ffprobe have to be installed and on the PATH.'); process.exit(2); }
const { file: LOG, log } = logger(DRY ? 'dry-run' : 'migrate');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { done: {}, failed: {} };
const save = () => { if (!DRY) writeFileSync(STATE, JSON.stringify(state, null, 1)); };

const typeOf = p => /\.mov$/i.test(p) ? 'video/quicktime' : /\.webm$/i.test(p) ? 'video/webm' : VIDEO.test(p) ? 'video/mp4'
  : /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : /\.gif$/i.test(p) ? 'image/gif'
  : /\.(heic|heif)$/i.test(p) ? 'image/heic' : /\.avif$/i.test(p) ? 'image/avif' : 'image/jpeg';
// A clip keeps its name with .mp4 in place of whatever it had. A story keeps its name
// under stories/, which is where the media function looks for a story's rules.
const newKey = (bucket, path) => {
  const k = VIDEO.test(path) ? path.replace(VIDEO, '.mp4') : path;
  return bucket === 'stories' ? `${STORY_PREFIX}${k}` : k;
};
// What ten seconds at the target rates comes to, so the dry run can say what it expects.
const expected = (secs, size) => Math.min(size, Math.round(secs * (ENCODE.videoKbps + ENCODE.audioKbps) * 1000 / 8 * 1.04 + 40000));

// The scale (and, for an HDR iPhone clip, the tone-map to ordinary video) as one filter.
const isHdr = p => ['arib-std-b67', 'smpte2084'].includes(p?.video?.color_transfer);
function filterFor(p, plain) {
  const s = ENCODE.shortSide;
  const scale = `scale=w='if(lte(iw,ih),trunc(min(${s},iw)/2)*2,-2)':h='if(lte(iw,ih),-2,trunc(min(${s},ih)/2)*2)'`;
  return isHdr(p) && ff.tonemap && !plain
    ? `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,${scale}`
    : `${scale},format=yuv420p`;
}
async function reencode(src, out, p, plain = false) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
    '-vf', filterFor(p, plain), '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high',
    '-b:v', `${ENCODE.videoKbps}k`, '-maxrate', `${ENCODE.maxKbps}k`, '-bufsize', `${ENCODE.maxKbps * 2}k`,
    ...(ff.fpsmax ? ['-fpsmax', String(ENCODE.fps)] : []),
    '-c:a', 'aac', '-b:a', `${ENCODE.audioKbps}k`, '-movflags', '+faststart', out];
  const r = await run('ffmpeg', args);
  if (r.code !== 0) throw new Error(`ffmpeg: ${r.err.trim().split('\n').slice(-2).join(' ')}`);
  const q = await probe(out);
  if (!q || !q.video) throw new Error('ffmpeg wrote something ffprobe cannot read');
  if (p?.duration && Math.abs(q.duration - p.duration) > Math.max(0.5, p.duration * 0.1)) throw new Error(`length changed ${p.duration}s -> ${q.duration}s`);
  if (p?.audio && !q.audio) throw new Error('the sound was lost');
  return readFileSync(out);
}
// A still the way the app makes one: a few frames in, at most 720 on its long side.
async function still(src, out, secs) {
  const s = ENCODE.poster;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', secs > 0.6 ? '0.3' : '0', '-i', src, '-frames:v', '1',
    '-vf', `scale=w='if(gte(iw,ih),min(${s},iw),-2)':h='if(gte(iw,ih),-2,min(${s},ih))'`, '-q:v', '5', out]);
  return r.code === 0 && existsSync(out) ? readFileSync(out) : null;
}

// One row, start to finish. Returns what happened, for the totals.
async function migrate(job, objects) {
  const { table, row, bucket, path } = job;
  const key = newKey(bucket, path), video = VIDEO.test(path);
  const col = table === 'posts' ? { path: 'video_path', store: 'video_store', legacy: 'legacy_video_path' }
    : { path: 'media_path', store: 'media_store', legacy: 'legacy_media_path' };
  const src = objects.get(`${bucket}|${path}`);
  if (!src) throw new Error(`the file is not in the ${bucket} bucket`);
  // The same test the media function puts a key to before it will sign it: a copy under a
  // name it refuses would be on R2 and unwatchable.
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(key) || key.split('/').some(x => x === '.' || x === '..')
      || (bucket === 'proof' && !/^[0-9]{1,18}\/[^/]+\//.test(key))) throw new Error(`${key} is not a name the media function will sign`);
  const done = state.done[`${table}:${row.id}`];
  let up = done && done.key === key ? done : null;
  // Already copied on an earlier run: make sure it is really there before trusting it.
  if (up) { const h = await retry(() => store.head(key), 'head'); if (!h || h.size !== up.after) up = null; }
  if (!up) {
    const dir = join(WORK, `${table}-${row.id}`);
    mkdirSync(dir, { recursive: true });
    try {
      const orig = await retry(() => sb.download(bucket, path), 'download');
      const inFile = join(dir, `in${path.slice(path.lastIndexOf('.'))}`);
      writeFileSync(inFile, orig);
      let bytes = orig, type = src.type || typeOf(path), kept = video ? 'original' : 'as is', why = '';
      if (video) {
        const p = await probe(inFile);
        try {
          // A tone-map that will not run is not a reason to send an HEVC original that Android
          // cannot play: the same encode without it is still a clip every phone can.
          const out = await reencode(inFile, join(dir, 'out.mp4'), p).catch(e => {
            if (!isHdr(p) || !ff.tonemap) throw e;
            log('tonemap-skipped', { table, id: row.id, error: e.message });
            return reencode(inFile, join(dir, 'out.mp4'), p, true);
          });
          // Smaller wins. Bigger only loses to an original every phone already plays (H.264 in
          // an MP4); an HEVC .mov has to become H.264 to play on Android whatever it weighs.
          const fine = /\.mp4$/i.test(path) && p?.video?.codec_name === 'h264' && (!p.audio || p.audio.codec_name === 'aac');
          if (out.length < orig.length || !fine) { bytes = out; type = 'video/mp4'; kept = 'reencoded'; }
          else why = `re-encoded was no smaller (${mb(out.length)} vs ${mb(orig.length)})`;
        } catch (e) { why = e.message; }
      }
      // The still: the one already beside it if there is one, otherwise made now.
      let poster = null, posterFrom = null;
      if (video && bucket === 'proof') {
        if (objects.has(`proof|${path}.jpg`)) { poster = await retry(() => sb.download('proof', `${path}.jpg`), 'download still'); posterFrom = 'copied'; }
        else {
          writeFileSync(join(dir, 'final.mp4'), bytes);
          poster = await still(join(dir, 'final.mp4'), join(dir, 'still.jpg'), 1);
          posterFrom = poster ? 'made' : null;
        }
      }
      await retry(() => store.put(key, bytes, type), 'put');
      if (poster) await retry(() => store.put(`${key}.jpg`, poster, 'image/jpeg'), 'put still');
      // Read back before anything points at it.
      const h = await retry(() => store.head(key), 'head');
      if (!h || h.size !== bytes.length) throw new Error(`R2 has ${h ? h.size : 'nothing'} bytes for ${key}, expected ${bytes.length}`);
      if (poster) { const hp = await retry(() => store.head(`${key}.jpg`), 'head still'); if (!hp || hp.size !== poster.length) throw new Error('the still did not land'); }
      up = { key, before: orig.length, after: bytes.length, kept, why, poster: posterFrom, type };
      state.done[`${table}:${row.id}`] = up; save();
      log('copied', { table, id: row.id, from: `${bucket}/${path}`, to: key, ...up });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  await retry(() => sb.repoint(table, row.id, { [col.path]: key, [col.store]: 'r2', [col.legacy]: path }, path), 'update row');
  delete state.failed[`${table}:${row.id}`]; save();
  log('repointed', { table, id: row.id, to: key });
  return up;
}

async function main() {
  console.log(`${DRY ? 'Dry run' : 'Migrating'} · ${ff.version}${ff.tonemap ? '' : ' (no zscale: HDR clips are not tone-mapped)'} · log: ${LOG}`);
  const [posts, stories, proofObjs, storyObjs] = await Promise.all([
    sb.rows('posts', 'id,video_path,video_store,legacy_video_path,created_at'),
    sb.rows('stories', 'id,media_path,media_store,legacy_media_path,created_at').catch(() => []),
    sb.list('proof'),
    sb.list('stories').catch(() => []),
  ]);
  const objects = new Map([...proofObjs.map(o => [`proof|${o.path}`, o]), ...storyObjs.map(o => [`stories|${o.path}`, o])]);
  const jobs = [
    ...posts.filter(r => r.video_path && r.video_store !== 'r2').map(row => ({ table: 'posts', row, bucket: 'proof', path: row.video_path })),
    ...stories.filter(r => r.media_path && r.media_store !== 'r2').map(row => ({ table: 'stories', row, bucket: 'stories', path: row.media_path })),
  ].sort((a, b) => Date.parse(a.row.created_at) - Date.parse(b.row.created_at)).slice(0, LIMIT);
  const already = posts.filter(r => r.video_store === 'r2').length + stories.filter(r => r.media_store === 'r2').length;
  // Objects no row points at, before or after a copy. Reported, never copied or touched.
  const referenced = new Set([
    ...posts.flatMap(r => [r.video_path, r.legacy_video_path].filter(Boolean).flatMap(x => [`proof|${x}`, `proof|${x}.jpg`])),
    ...stories.flatMap(r => [r.media_path, r.legacy_media_path].filter(Boolean).map(x => `stories|${x}`)),
  ]);
  const orphans = [...objects.keys()].filter(k => !referenced.has(k));
  console.log(`${posts.length} posts, ${stories.length} stories · ${objects.size} objects in Supabase (${mb([...objects.values()].reduce((a, o) => a + o.size, 0))})`);
  console.log(`${already} rows already on R2 · ${jobs.length} to do${LIMIT < Infinity ? ` (--limit ${LIMIT})` : ''} · ${orphans.length} objects no row points at (left alone)`);
  log('start', { dry: DRY, posts: posts.length, stories: stories.length, objects: objects.size, todo: jobs.length, already, orphans });
  if (orphans.length) console.log(`  not referenced: ${orphans.slice(0, 20).map(k => k.replace('|', '/')).join(', ')}${orphans.length > 20 ? ' …' : ''}`);

  if (DRY) {
    let before = 0, after = 0, unknown = 0, missing = 0;
    for (const [i, j] of jobs.entries()) {
      const src = objects.get(`${j.bucket}|${j.path}`);
      const key = newKey(j.bucket, j.path);
      if (!src) { missing++; console.log(`  ${j.table} ${j.row.id}: ${j.path} — FILE MISSING, would fail`); log('plan', { ...j, row: j.row.id, missing: true }); continue; }
      let est = src.size, secs = null;
      if (VIDEO.test(j.path) && PROBE) {
        const p = await probe(await sb.signed(j.bucket, j.path)).catch(() => null);
        secs = p?.duration || null;
        if (secs) est = expected(secs, src.size); else unknown++;
      }
      const still = VIDEO.test(j.path) && j.bucket === 'proof' ? (objects.has(`proof|${j.path}.jpg`) ? 'copy still' : 'make still') : '';
      before += src.size; after += est;
      console.log(`  ${String(i + 1).padStart(3)} ${j.table} ${j.row.id}: ${j.bucket}/${j.path} (${mb(src.size)}${secs ? `, ${secs.toFixed(1)}s` : ''}) -> ${key} ~${mb(est)}${still ? ` + ${still}` : ''}`);
      log('plan', { table: j.table, id: j.row.id, from: j.path, to: key, size: src.size, estimate: est, secs, still });
    }
    console.log(`\nWould copy ${jobs.length - missing} files: ${mb(before)} now, about ${mb(after)} after (${before ? Math.round((1 - after / before) * 100) : 0}% smaller).`);
    if (unknown) console.log(`${unknown} clips could not be probed and are counted at their full size.`);
    if (missing) console.log(`${missing} rows point at a file that is not there and would be reported as failures.`);
    console.log('Nothing was changed.');
    return;
  }

  let i = 0, ok = 0, bad = 0, before = 0, after = 0;
  const next = async () => {
    while (i < jobs.length) {
      const j = jobs[i++], n = i;
      try {
        const up = await migrate(j, objects);
        ok++; before += up.before; after += up.after;
        console.log(`  ${String(n).padStart(3)}/${jobs.length} ${j.table} ${j.row.id}: ${mb(up.before)} -> ${mb(up.after)} ${up.kept}${up.why ? ` (${up.why})` : ''}${up.poster ? `, still ${up.poster}` : ''}`);
      } catch (e) {
        bad++;
        state.failed[`${j.table}:${j.row.id}`] = { path: j.path, error: e.message, at: new Date().toISOString() }; save();
        log('failed', { table: j.table, id: j.row.id, path: j.path, error: e.message });
        console.log(`  ${String(n).padStart(3)}/${jobs.length} ${j.table} ${j.row.id}: FAILED — ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, next));
  log('end', { ok, failed: bad, before, after });
  console.log(`\n${ok} copied, ${bad} failed. ${mb(before)} -> ${mb(after)}${before ? ` (${Math.round((1 - after / before) * 100)}% smaller)` : ''}.`);
  console.log(bad ? 'Run it again to retry the failures; anything already done is skipped.' : 'Next: node verify.mjs');
  if (bad) process.exitCode = 1;
}
main().catch(e => { log('crashed', { error: String(e && e.stack || e) }); console.error(e.message || e); process.exit(1); });

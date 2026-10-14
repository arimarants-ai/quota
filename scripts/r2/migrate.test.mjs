// node scripts/r2/migrate.test.mjs     (needs ffmpeg, and `npm ci` in scripts/r2)
//
// The copy runs once, against the real thing, and nobody wants to find out then. So it is
// run here first against a stand-in for both sides — Supabase's REST and storage APIs, and
// R2's S3 API — with real clips made by ffmpeg: an iPhone-style HEVC .mov filmed sideways,
// a big H.264 one, a small clip that re-encoding would only make bigger, the same kind of
// clip in a .mov, a picture, and a post whose file is gone.
import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('SKIP: the migration test needs ffmpeg'); process.exit(0); }
try { await import('aws4fetch'); } catch { console.log('SKIP: run npm ci in scripts/r2 first'); process.exit(0); }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`); if (!ok) failed++; };
const tmp = mkdtempSync(join(tmpdir(), 'r2-migrate-'));
const make = (name, args) => { const out = join(tmp, name); const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]); if (r.status) throw new Error(String(r.stderr)); return readFileSync(out); };
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'];
const noise = (w, h) => ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=60:duration=4,noise=alls=40:allf=t`];
// Filmed upright on a phone: stored 1920x1080 with a flag saying turn it a quarter.
make('a0.mov', [...noise(1920, 1080), ...tone, '-c:v', 'libx265', '-x265-params', 'log-level=error', '-b:v', '12M', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest']);
const hevc = make('a.mov', ['-display_rotation', '90', '-i', join(tmp, 'a0.mov'), '-c', 'copy']);
const big = make('b.mp4', [...noise(1920, 1080), ...tone, '-c:v', 'libx264', '-b:v', '10M', '-c:a', 'aac', '-shortest']);
const tiny = make('c.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:size=320x240:rate=15:duration=4', ...tone, '-c:v', 'libx264', '-b:v', '60k', '-c:a', 'aac', '-b:a', '32k', '-shortest']);
// What the old in-app recorder left behind: H.264 at well under a megabit, in a .mov.
const lean = make('f.mov', [...noise(640, 360), ...tone, '-c:v', 'libx264', '-b:v', '150k', '-c:a', 'aac', '-b:a', '32k', '-shortest']);
const pic = make('d.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=800x1000', '-frames:v', '1']);
const still = make('e.jpg', ['-f', 'lavfi', '-i', 'color=c=red:size=360x640', '-frames:v', '1']);

const G = '7', U = '11111111-1111-1111-1111-111111111111';
const at = n => new Date(Date.UTC(2026, 8, n)).toISOString();
const objects = new Map([            // the Supabase bucket, which must come out exactly as it went in
  [`${G}/${U}/1.mov`, hevc], [`${G}/${U}/2.mp4`, big], [`${G}/${U}/2.mp4.jpg`, still], [`${G}/${U}/3.mp4`, tiny], [`${G}/${U}/4.jpg`, pic], [`${G}/${U}/6.mov`, lean],
]);
const original = new Map([...objects].map(([k, v]) => [k, Buffer.from(v)]));
const posts = [
  { id: 1, video_path: `${G}/${U}/1.mov`, created_at: at(1) }, { id: 2, video_path: `${G}/${U}/2.mp4`, created_at: at(2) },
  { id: 3, video_path: `${G}/${U}/3.mp4`, created_at: at(3) }, { id: 4, video_path: `${G}/${U}/4.jpg`, created_at: at(4) },
  { id: 5, video_path: `${G}/${U}/gone.mov`, created_at: at(5) }, { id: 6, video_path: `${G}/${U}/6.mov`, created_at: at(6) },
].map(p => ({ video_store: null, legacy_video_path: null, ...p }));
const r2 = new Map();
const supabaseWrites = [];

const body = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const ranged = (req, res, buf, type) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'accept-ranges': 'bytes' }); return res.end(req.method === 'HEAD' ? undefined : buf); }
  const a = +m[1], b = m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1;
  res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
  res.end(buf.subarray(a, b + 1));
};
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  // --- Supabase
  if (p === '/rest/v1/posts' && req.method === 'GET') return res.end(JSON.stringify(posts));
  if (p === '/rest/v1/stories' && req.method === 'GET') return res.end('[]');
  if (p === '/rest/v1/posts' && req.method === 'PATCH') {
    const id = +u.searchParams.get('id').slice(3), was = u.searchParams.get('video_path').slice(3), row = posts.find(x => x.id === id);
    const set = JSON.parse(await body(req));
    if (!row || row.video_path !== was) return res.end('[]');
    Object.assign(row, set);
    return res.end(JSON.stringify([row]));
  }
  if (p.startsWith('/storage/v1/object/list/') && req.method === 'POST') {
    const { prefix } = JSON.parse(await body(req)), pre = prefix ? `${prefix}/` : '';
    const kids = new Map();
    for (const [k, v] of objects) if (k.startsWith(pre)) {
      const rest = k.slice(pre.length), [first, ...more] = rest.split('/');
      kids.set(first, more.length ? { name: first, id: null } : { name: first, id: k, metadata: { size: v.length, mimetype: /jpg$/.test(k) ? 'image/jpeg' : /mov$/.test(k) ? 'video/quicktime' : 'video/mp4' } });
    }
    return res.end(JSON.stringify(p.endsWith('/proof') ? [...kids.values()] : []));
  }
  if (p.startsWith('/storage/v1/object/sign/proof/') && req.method === 'POST') return res.end(JSON.stringify({ signedURL: `/object/sign/proof/${p.slice(30)}?token=t` }));
  if (p.startsWith('/storage/v1/object/sign/proof/') && req.method === 'GET') { const b = objects.get(p.slice(30)); return b ? ranged(req, res, b, 'video/mp4') : (res.writeHead(404), res.end()); }
  if (p.startsWith('/storage/v1/object/proof/') && req.method === 'GET') { const b = objects.get(p.slice(25)); return b ? ranged(req, res, b, 'application/octet-stream') : (res.writeHead(404), res.end()); }
  if (p.startsWith('/storage/') || p.startsWith('/rest/')) { supabaseWrites.push(`${req.method} ${p}`); res.writeHead(405); return res.end(); }
  // --- R2
  if (p === '/quota-proof' && req.method === 'GET') {
    const xml = [...r2].map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.body.length}</Size></Contents>`).join('');
    return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${xml}</ListBucketResult>`);
  }
  if (p.startsWith('/quota-proof/')) {
    const key = p.slice(13);
    if (!/AWS4-HMAC-SHA256/.test(req.headers.authorization || '') && !u.searchParams.get('X-Amz-Signature')) { res.writeHead(403); return res.end(); }
    if (req.method === 'PUT') { r2.set(key, { body: await body(req), type: req.headers['content-type'], cache: req.headers['cache-control'] }); res.writeHead(200); return res.end(); }
    const o = r2.get(key);
    if (!o) { res.writeHead(404); return res.end(); }
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': o.body.length, 'content-type': o.type, 'cache-control': o.cache }); return res.end(); }
    return ranged(req, res, o.body, o.type);
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-the-test', R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKTEST',
  R2_SECRET_ACCESS_KEY: 'secret-for-the-test', R2_BUCKET: 'quota-proof', R2_ENDPOINT: base, R2_MIGRATE_DIR: tmp };
const node = (script, args) => new Promise(r => {
  const c = spawn(process.execPath, [join(HERE, script), ...args], { env });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  c.on('close', code => r({ code, out }));
});
const probe = buf => { const f = join(tmp, `p${Math.random()}.mp4`); require_write(f, buf);
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f], { encoding: 'utf8' }); return JSON.parse(r.stdout); };
import { writeFileSync as require_write } from 'node:fs';
const secretless = out => !/service-key-for-the-test|secret-for-the-test/.test(out);

try {
  // 1. The dry run says what it would do and does none of it.
  const dry = await node('migrate.mjs', ['--dry-run']);
  check('a dry run plans every row', dry.code === 0 && /6 to do/.test(dry.out) && /FILE MISSING/.test(dry.out), dry.out);
  check('  estimates what it would save', /about [\d.]+ [KM]B after \(\d+% smaller\)/.test(dry.out), dry.out.split('\n').slice(-6).join(' | '));
  check('  and changes nothing anywhere', r2.size === 0 && posts.every(p => !p.video_store), `${r2.size} objects on R2`);

  // 2. --limit takes the oldest first, and only that many.
  const one = await node('migrate.mjs', ['--limit', '1']);
  check('--limit 1 does one row', one.code === 0 && posts[0].video_store === 'r2' && !posts[1].video_store, one.out);

  // 3. The rest. The gone file fails, the others go.
  const all = await node('migrate.mjs', []);
  check('the full run copies what there is and reports what is missing', all.code === 1 && /4 copied, 1 failed/.test(all.out), all.out);
  const k1 = `${G}/${U}/1.mp4`, k2 = `${G}/${U}/2.mp4`, k3 = `${G}/${U}/3.mp4`, k4 = `${G}/${U}/4.jpg`;
  check('  every row points at its copy and remembers where it was',
    posts[0].video_path === k1 && posts[0].legacy_video_path === `${G}/${U}/1.mov` && posts[3].video_path === k4 && posts[3].legacy_video_path === k4
    && posts.slice(0, 4).every(p => p.video_store === 'r2') && posts[4].video_store === null && posts[5].video_store === 'r2', JSON.stringify(posts));
  const a = probe(r2.get(k1).body), av = a.streams.find(s => s.codec_type === 'video');
  check('  the sideways HEVC .mov is now H.264 in an MP4, upright at 720 wide',
    av.codec_name === 'h264' && av.width === 720 && av.height === 1280 && av.pix_fmt === 'yuv420p', `${av.codec_name} ${av.width}x${av.height} ${av.pix_fmt}`);
  check('    with its sound, as AAC', a.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
  check('    at no more than 30 frames a second', eval(av.avg_frame_rate) <= 30.5, av.avg_frame_rate);
  check('    the same length', Math.abs(+a.format.duration - 4) < 0.3, a.format.duration);
  check('    and far smaller', r2.get(k1).body.length < hevc.length / 2, `${hevc.length} -> ${r2.get(k1).body.length}`);
  const head = r2.get(k1).body, moov = head.indexOf('moov'), mdat = head.indexOf('mdat');
  check('    with the index at the front', moov > 0 && moov < mdat, `moov ${moov} mdat ${mdat}`);
  check('    and no metadata carried over', !(a.format.tags && (a.format.tags.location || a.format.tags['com.apple.quicktime.location.ISO6709'])));
  check('  a clip that would only grow goes up as it was', r2.get(k3).body.equals(tiny), `${tiny.length} vs ${r2.get(k3).body.length}`);
  const k6 = `${G}/${U}/6.mp4`, six = r2.get(k6) && probe(r2.get(k6).body), sixv = six && six.streams.find(x => x.codec_type === 'video');
  check('  an H.264 .mov that would only grow is moved into an MP4 as it was',
    six && /mp4/.test(six.format.format_name) && sixv.codec_name === 'h264' && sixv.width === 640
    && Math.abs(r2.get(k6).body.length - lean.length) < lean.length * 0.1 && r2.get(k6).type === 'video/mp4',
    six ? `${six.format.format_name} ${sixv.codec_name} ${sixv.width} ${lean.length} -> ${r2.get(k6).body.length}` : 'not on R2');
  const sixHead = r2.get(k6).body, sixMoov = sixHead.indexOf('moov'), sixMdat = sixHead.indexOf('mdat');
  check('    with the index at the front', sixMoov > 0 && sixMoov < sixMdat, `moov ${sixMoov} mdat ${sixMdat}`);
  check('  a picture goes up as it was', r2.get(k4).body.equals(pic) && r2.get(k4).type === 'image/jpeg');
  check('  a still already beside a clip is copied', r2.get(`${k2}.jpg`) && r2.get(`${k2}.jpg`).body.equals(still));
  const made = r2.get(`${k1}.jpg`);
  check('  one that had none is made, as a JPEG', made && made.body[0] === 0xff && made.body[1] === 0xd8 && made.type === 'image/jpeg');
  check('  every object on R2 carries the long cache header',
    [...r2.values()].every(o => o.cache === 'private, max-age=31536000, immutable'), [...r2.values()].map(o => o.cache).join(', '));
  check('  nothing in Supabase storage was written, moved or deleted',
    !supabaseWrites.length && [...original].every(([k, v]) => objects.get(k) && objects.get(k).equals(v)) && objects.size === original.size, supabaseWrites.join(', '));

  // 4. Again: nothing left but the one that cannot be done.
  const again = await node('migrate.mjs', []);
  check('a second run only retries the failure', /1 to do/.test(again.out) && /0 copied, 1 failed/.test(again.out), again.out);

  // 5. The report.
  const rep = await node('verify.mjs', []);
  check('the report counts both sides', /Supabase `proof`: 6 objects/.test(rep.out) && /R2 `quota-proof`: 9 objects/.test(rep.out), rep.out);
  check('  says every R2 row has its file and still', /every R2 row has its files and still in R2 \(HEAD\): yes \(5 rows checked\)/.test(rep.out), rep.out);
  check('  says what got smaller', /copied by the script: 5 files/.test(rep.out), rep.out);
  check('  and names the failure', /posts 5: .*gone\.mov not copied — the file is not in the bucket at all/.test(rep.out), rep.out);
  r2.delete(`${k1}.jpg`);
  const broken = await node('verify.mjs', []);
  check('  and a still that has gone is caught', broken.code === 1 && /missing: posts 1: .*1\.mp4\.jpg/.test(broken.out), broken.out);
  check('no key or secret is ever printed', [dry, one, all, again, rep, broken].every(r => secretless(r.out)) && secretless(readFileSync(join(tmp, 'state.json'), 'utf8')));
  // As the GitHub workflow runs it, whose logs anyone can read.
  const quiet = (script, args) => new Promise(r => {
    const c = spawn(process.execPath, [join(HERE, script), ...args], { env: { ...env, R2_QUIET: '1' } });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    c.on('close', () => r(out));
  });
  const quietOuts = [await quiet('migrate.mjs', ['--dry-run']), await quiet('migrate.mjs', []), await quiet('verify.mjs', [])];
  check('  and with R2_QUIET, nobody\'s user id either', quietOuts.every(o => !o.includes(U)) && quietOuts.some(o => o.includes(`${G}/…/`)),
    quietOuts.join('\n---\n').slice(0, 2000));
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\nFAIL: ${failed} migration check(s)` : '\nPASS: the copy to R2 does what it says and touches nothing in Supabase');
process.exit(failed ? 1 : 0);

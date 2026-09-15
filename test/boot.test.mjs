// npx playwright@1.56 install --with-deps chromium   (once)
// node test/boot.test.mjs
//
// One rule, and every check here is a way of breaking it: whatever goes wrong, the app
// must never end up showing an empty page. It used to. render() ran only on the last
// line of load(), so a failed query alerted "JWT expired" and left nothing behind, and
// an installed app hits that far more than a browser tab does — it opens with a token
// that expired days ago, often before the phone has a connection.
//
// The page runs for real, against test/stub-supabase.js in place of the library.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('SKIP: boot tests need playwright (npx playwright install --with-deps chromium)'); process.exit(0); }

const STUB = await readFile(join(HERE, 'stub-supabase.js'), 'utf8');
const LIB = '**/vendor/**/supabase.js';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Playwright's request interception suppresses xhr.upload.onprogress, so an upload
// answered by route.fulfill() reports nothing and would prove nothing. Instead the page
// is served with its SUPABASE_URL pointed back here, and this server answers the storage
// endpoint for real, so the upload runs the whole way through a real XHR.
let base = '';
let uploadReply = { status: 200, body: '{}', hold: null };
let lastUpload = null;                  // the file bytes as they actually went over the wire
// The body is multipart; the file is the part between the blank line after its own
// headers and the boundary that follows. Anchored on the filename rather than on a
// content type, since proof is a clip or a picture and both come through here.
function filePart(buf, contentType) {
  const b = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!b) return null;
  const mark = Buffer.from(`--${b[1] || b[2]}`);
  const named = buf.indexOf(Buffer.from('filename="'));
  if (named < 0) return null;
  const start = buf.indexOf(Buffer.from('\r\n\r\n'), named);
  if (start < 0) return null;
  const end = buf.indexOf(mark, start);
  return buf.subarray(start + 4, end < 0 ? buf.length : end - 2);
}
const server = createServer(async (req, res) => {
  let p = req.url.split(/[?#]/)[0];
  if (p === '/last-upload.mp4') {       // served back so the bytes can be decoded and checked
    res.writeHead(lastUpload ? 200 : 404, { 'content-type': 'video/mp4' });
    return res.end(lastUpload || '');
  }
  if (req.method === 'POST' && p.startsWith('/storage/v1/object/')) {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', async () => {
      lastUpload = filePart(Buffer.concat(parts), req.headers['content-type']);
      if (uploadReply.hold) await uploadReply.hold;
      res.writeHead(uploadReply.status, { 'content-type': 'application/json' });
      res.end(uploadReply.body);
    });
    return;
  }
  if (p === '/') p = '/index.html';
  try {
    let body = await readFile(join(ROOT, p));
    if (p === '/index.html' && req.url.includes('local')) body = String(body).replace(/const SUPABASE_URL = '[^']+'/, `const SUPABASE_URL = '${base}'`);
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, r));
base = `http://127.0.0.1:${server.address().port}`;
// A fake camera and microphone, so the in-app recorder can be driven for real: chromium
// synthesises a moving picture and a tone rather than needing hardware.
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failed++;
};

// Every case gets a clean context: the app keeps its session in localStorage.
// With a mode, the stub is installed and the page is loaded ready to inspect. With null,
// the real library is used and the case navigates itself, so it can add routes first.
async function withPage(mode, body) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.dismiss(); });
  await page.addInitScript(() => {
    self.__btn = [];
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const b = document.querySelector('#dlg button.primary');
        if (b && self.__btn.at(-1) !== b.textContent) self.__btn.push(b.textContent);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
  await page.route('**fonts.googleapis.com**', r => r.abort());   // not reachable from CI either
  if (mode) {
    await page.route(LIB, r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript(m => { self.__MODE = m; }, mode);
    await page.goto(`${base}/?local`, { waitUntil: 'domcontentloaded' });
  }
  try { await body(page, alerts); } finally { await ctx.close(); }
}

const SIGNED_IN = { session: { user: { id: 'u1' } } };
// Posting is gated on having spun, so the cases that are about uploading use a group with
// no wheel on it rather than spinning one first every time.
const NO_WHEEL = { ...SIGNED_IN, wheel: false };
const settle = p => p.waitForTimeout(700);

// The session read never coming back is the one that showed nothing at all: no alert to
// dismiss, no screen, no way to tell whether it was working.
await withPage({ hang: true }, async (page, alerts) => {
  await settle(page);
  check('a session read that never returns still shows a screen', (await page.innerHTML('#app')).includes('splash'));
  check('  and does not open a modal over it', alerts.length === 0, alerts.join(' | '));
});

// The exact bug that was reported: expired token, refresh cannot save it.
await withPage({ ...SIGNED_IN, queryError: 'JWT expired', refreshOk: false }, async (page, alerts) => {
  await settle(page);
  const html = await page.innerHTML('#app');
  check('an expired token that cannot be refreshed lands on sign-in', html.includes('auth'), `#app was ${html.length} chars`);
  check('  and never leaves a blank page', html.trim().length > 50);
  check('  and does not alert "JWT expired" first', alerts.length === 0, alerts.join(' | '));
});

// The same token, when a refresh does save it: the app should recover on its own.
await withPage({ ...SIGNED_IN, queryError: 'JWT expired', refreshOk: true }, async (page, alerts) => {
  await settle(page);
  check('an expired token that refreshes recovers into the app', await page.isVisible('#bar'));
  check('  with no error banner left behind', await page.isHidden('#err'));
  check('  and no modal', alerts.length === 0, alerts.join(' | '));
});

// Anything that is not an auth problem: say so, offer a way out, keep the app on screen.
await withPage({ ...SIGNED_IN, queryError: 'network is down' }, async (page, alerts) => {
  await settle(page);
  check('a failed load explains itself in the banner', (await page.innerText('#err')).includes('network is down'));
  check('  with a retry', await page.isVisible('#err button'));
  check('  and no modal', alerts.length === 0, alerts.join(' | '));
});

// No session at all: the sign-in screen, and not the splash it started on.
await withPage({ session: null }, async page => {
  await settle(page);
  const html = await page.innerHTML('#app');
  check('no session goes to the sign-in screen', html.includes('auth') && !html.includes('splash'));
});

// Resuming an installed app fires visibilitychange constantly; each one used to refetch
// every table in the database.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const before = await page.evaluate(() => self.__calls.loads);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      for (const hidden of [true, false]) {
        Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
  }
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => self.__calls.loads);
  check('resuming repeatedly does not refetch every time', after === before, `${before} -> ${after} loads`);
});

// The caption sits under the clip with the username in front of it, the way every feed
// writes one, and the clip carries nothing but the clip, the badge and the player.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const cap = page.locator('.post .cap').first();
  check('a post shows its caption', await cap.isVisible() && (await cap.innerText()).includes('fifty in the bag'));
  check('  under the clip, not over it', await page.evaluate(() => {
    const c = document.querySelector('.post .cap'), r = document.querySelector('.post .reel');
    return c.getBoundingClientRect().top >= r.getBoundingClientRect().bottom - 1;
  }));
  check('  with the username in front of it', /^ari/.test((await cap.innerText()).trim()), await cap.innerText());
  // The player is the clip and a pause. Nothing native, nothing that says Safari.
  const v = page.locator('.post video').first();
  check('the clip has no native controls', await v.evaluate(el => !el.controls));
  check('  and one glyph over it', await page.locator('.post .reel .play').first().count() === 1);
  check('  and a line for time rather than numbers', await page.locator('.post .reel .prg').first().count() === 1
    && !/\d:\d\d/.test(await page.locator('.post .reel').first().innerText()));
  await page.evaluate(() => clipState(document.querySelector('.post video'), 'play'));
  check('  playing hides the glyph', await page.locator('.post .reel').first().evaluate(r => r.classList.contains('playing')
    && getComputedStyle(r.querySelector('.play i')).opacity !== '1' || r.classList.contains('flash')));
  await page.evaluate(() => clipState(document.querySelector('.post video'), 'pause'));
  check('  and pausing brings it straight back', await page.locator('.post .reel').first().evaluate(r => !r.classList.contains('playing')));
  check('  the sound toggle is a speaker, not a menu', await page.locator('.post .reel .sound').first().count() === 1);
});

// A post with no caption simply has no caption line.
await withPage({ ...SIGNED_IN, noCaption: true }, async page => {
  await settle(page);
  check('a post without a caption still renders', await page.locator('.reel').count() >= 1);
  check('  but with no empty caption line', await page.locator('.post .cap').count() === 0);
});

// Uploading a phone video is the longest thing the app does, and supabase-js sends it
// through fetch, which reports nothing at all. A motionless "Uploading…" is how a slow
// connection and a stuck one look identical.
async function submitProof(page) {
  await page.locator('.bar .add').click();
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg input[name=video]').setInputFiles({
    name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4 * 1048576, 7),
  });
  await page.locator('#dlg button.primary').click();
}
const labels = page => page.evaluate(() => self.__btn);

await withPage(NO_WHEEL, async page => {
  await settle(page);
  let release;
  uploadReply = { status: 200, body: '{}', hold: new Promise(r => { release = r; }) };
  await submitProof(page);
  await page.waitForFunction(() => self.__btn.some(t => /Uploading… \d+%/.test(t)), null, { timeout: 5000 }).catch(() => {});
  const seen = await labels(page);
  check('the upload button reports a percentage', seen.some(t => /Uploading… \d+%/.test(t)), seen.join(' -> '));
  check('  and the progress bar fills', await page.locator('#uprog').evaluate(el => el.style.getPropertyValue('--w')) !== '');
  check('  and the size line counts MB sent', /of 4\.0 MB/.test(await page.locator('#vsize').textContent()),
    await page.locator('#vsize').textContent());
  release();
  await page.waitForTimeout(700);
  // dlg() closes the dialog but leaves its markup in place, so ask whether it is open.
  const open = await page.locator('#dlg').evaluate(d => d.open);
  check('  then posts and closes the dialog', (await labels(page)).includes('Posting…') && !open,
    `${(await labels(page)).join(' -> ')} | dialog open: ${open}`);
});

// A rejected upload has to repeat what the server said, not fail silently.
await withPage(NO_WHEEL, async (page, alerts) => {
  await settle(page);
  uploadReply = { status: 413, body: JSON.stringify({ message: 'The object exceeded the maximum allowed size' }), hold: null };
  await submitProof(page);
  await page.waitForTimeout(900);
  check('a rejected upload repeats the reason', alerts.some(a => a.includes('exceeded the maximum allowed size')), alerts.join(' | '));
  check('  and the form can be used again', await page.locator('#dlg button.primary').isEnabled());
  check('  and the progress bar is cleared away', await page.locator('#uprog').isHidden());
});
uploadReply = { status: 200, body: '{}', hold: null };

// The real reason posting felt slow: the camera's own file went up untouched. A minute of
// 1080p is about 65 MB by Apple's figures, so the app now re-encodes to 720p first. This
// records an actual 1080p clip, posts it through the dialog, and checks the bytes that
// reached the wire — not just that a function returned something.
// A clip the browser can actually decode, so a case about what the feed does with its
// videos is not really a case about a URL that was never a video.
async function realClip(page) {
  return page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 160, height: 200 });
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: mp4Type() || 'video/webm' });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.start();
    const iv = setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360},70%,50%)`; g.fillRect(0, 0, 160, 200); }, 60);
    await new Promise(r => setTimeout(r, 900));
    clearInterval(iv);
    rec.stop();
    await new Promise(r => { rec.onstop = r; });
    return URL.createObjectURL(new Blob(chunks, { type: rec.mimeType.split(';')[0] }));
  });
}

async function record1080p(page) {
  return page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
    const g = c.getContext('2d');
    const stream = c.captureStream(30);
    const ac = new AudioContext(), dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); osc.frequency.value = 440; osc.connect(dest); osc.start();
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const rec = new MediaRecorder(stream, { mimeType: 'video/mp4', videoBitsPerSecond: 16e6 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.start();
    // Noise, so the encoder actually has to spend the bits a real camera would.
    const iv = setInterval(() => {
      const img = g.createImageData(1920, 1080);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 255; img.data[i + 1] = Math.random() * 255;
        img.data[i + 2] = Math.random() * 255; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }, 100);
    await new Promise(r => setTimeout(r, 7000));
    clearInterval(iv);
    rec.stop();
    await new Promise(r => { rec.onstop = r; });
    osc.stop(); ac.close();
    const blob = new Blob(chunks, { type: 'video/mp4' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
}

await withPage(NO_WHEEL, async page => {
  await settle(page);
  const clip = Buffer.from(await record1080p(page));
  check('the fixture is a real 1080p clip over the compression threshold',
    clip.length > 6 * 1048576 && clip.subarray(4, 8).toString() === 'ftyp', `${(clip.length / 1048576).toFixed(1)} MB`);

  lastUpload = null;
  uploadReply = { status: 200, body: '{}', hold: null };
  await page.locator('.bar .add').click();
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg input[name=video]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: clip });
  await page.locator('#dlg button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#dlg').open, null, { timeout: 90000 }).catch(() => {});

  const seen = await labels(page);
  check('  it says it is compressing, with a percentage', seen.some(t => /Compressing… \d+%/.test(t)), seen.join(' -> '));
  check('  the upload carried the re-encoded file, not the original', lastUpload && lastUpload.length < clip.length / 2,
    `sent ${lastUpload ? (lastUpload.length / 1048576).toFixed(2) : 'nothing'} MB of ${(clip.length / 1048576).toFixed(1)} MB`);
  if (lastUpload) console.log(`        ${(clip.length / 1048576).toFixed(1)} MB in, ${(lastUpload.length / 1048576).toFixed(2)} MB out (${(clip.length / lastUpload.length).toFixed(1)}x smaller)`);
});

// Re-encoding costs about the length of the clip before a byte moves. On a connection
// fast enough to have sent the original in less time than that, the whole wait is the
// app's own doing, so it does not happen. The rate is what this phone's uploads managed.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  const clip = Buffer.from(await record1080p(page));
  await page.evaluate(() => localStorage.setItem('quota.uprate', String(40 * 1048576)));  // 40 MB/s
  lastUpload = null;
  uploadReply = { status: 200, body: '{}', hold: null };
  await page.locator('.bar .add').click();
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg input[name=video]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: clip });
  await page.locator('#dlg button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#dlg').open, null, { timeout: 90000 }).catch(() => {});
  const seen = await labels(page);
  check('a connection quick enough makes re-encoding a waste, so it is skipped',
    !seen.some(t => /Compressing/.test(t)), seen.join(' -> '));
  check('  and the original goes up untouched', lastUpload && lastUpload.length === clip.length,
    `sent ${lastUpload && lastUpload.length} of ${clip.length}`);

  // The same clip on a connection that would take minutes is worth the wait.
  await page.evaluate(() => localStorage.setItem('quota.uprate', String(0.05 * 1048576)));  // 50 KB/s
  lastUpload = null;
  await page.locator('.bar .add').click();
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg input[name=video]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: clip });
  await page.locator('#dlg button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#dlg').open, null, { timeout: 90000 }).catch(() => {});
  check('  a slow one still gets the smaller file', lastUpload && lastUpload.length < clip.length / 2,
    `sent ${lastUpload && lastUpload.length} of ${clip.length}`);
});

// An upload that worked is the only honest measure of the connection, so that is where
// the rate comes from.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  const before = await page.evaluate(() => localStorage.getItem('quota.uprate'));
  await page.evaluate(() => noteRate(20 * 1048576, 4));       // 20 MB in 4s
  await page.evaluate(() => noteRate(1000, 4));               // too small to learn from
  await page.evaluate(() => noteRate(20 * 1048576, 0.2));     // too quick to learn from
  const after = await page.evaluate(() => upRate());
  check('the upload rate is remembered from uploads that finished', before === null && Math.round(after / 1048576) === 5,
    `${before} -> ${after}`);
});

// What was sent has to be a video people can actually watch, at the size we intended.
await withPage(SIGNED_IN, async page => {
  const meta = await page.evaluate(async src => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.src = src;
    return await new Promise(res => {
      v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
      v.onerror = () => res(null);
      setTimeout(() => res(null), 10000);
    });
  }, `${base}/last-upload.mp4`);
  check('the uploaded file decodes', !!meta, 'it did not load at all');
  check('  at 720p', meta && meta.h === 720 && meta.w === 1280, JSON.stringify(meta));
  check('  and keeps the full length', meta && Math.abs(meta.d - 7) < 2.5, JSON.stringify(meta));

  // Re-encoding routes the audio through WebAudio so nothing plays aloud. That is exactly
  // the sort of plumbing that silently drops the sound, so check for actual signal.
  const audio = await page.evaluate(async src => {
    try {
      const buf = await (await fetch(src)).arrayBuffer();
      const decoded = await new AudioContext().decodeAudioData(buf);
      const d = decoded.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      return { channels: decoded.numberOfChannels, seconds: decoded.duration, peak };
    } catch (e) { return { error: String(e) }; }
  }, `${base}/last-upload.mp4`);
  check('  with the audio still on it', audio.peak > 0.01, JSON.stringify(audio));
});

// A file the browser cannot decode must not become a failed post: it goes up untouched.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  lastUpload = null;
  const junk = Buffer.alloc(7 * 1048576, 3);          // over the threshold, but not a video
  await page.locator('.bar .add').click();
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg input[name=video]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: junk });
  await page.locator('#dlg button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#dlg').open, null, { timeout: 60000 }).catch(() => {});
  check('an undecodable file falls back to the original', lastUpload && lastUpload.length === junk.length,
    `sent ${lastUpload ? lastUpload.length : 'nothing'} of ${junk.length} bytes`);
});

// The leaderboard: current streak first, with how typical that is beside it.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(200);
  const rows = await page.locator('#app .rank').evaluateAll(els => els.map(e => e.closest('.row').innerText.replace(/\n/g, ' | ')));
  check('the group has a leaderboard', rows.length === 2, rows.join(' // '));
  // Sam has three days running, Ari has today only, so Sam is first.
  check('  ranked by streak', /Sam/.test(rows[0] || '') && /Ari/.test(rows[1] || ''), rows.join(' // '));
  check('  with the completion rate beside it', /hit the quota \d+% of the last \d+ days/.test(rows[0] || ''), rows[0]);
  check('  and the streak in days', /3 days/.test(rows[0] || ''), rows[0]);
});

// ---- wheels
// The wheel is a gate, so the first thing to prove is that it actually gates: you cannot
// reach the post form with a spin outstanding, and you meet the wheel instead of an error.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  check('spin day is announced on the feed', (await page.innerText('#app')).includes('Today is wheel spin day'));
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  const dlgText = await page.locator('#dlg').innerText();
  check('  trying to post opens the wheel, not the form', dlgText.includes('Challenge') && !dlgText.includes('Video proof'), dlgText.slice(0, 120));
  check('  and the wheel is drawn with a slice per option', await page.locator('#dlg .wheel-face path').count() === 4);
});

// The result is the database's, and the wheel is turned to it. A second call must return
// the same row rather than rolling again, which is what stops a force-quit re-spin.
await withPage({ ...SIGNED_IN, pick: 2 }, async page => {
  await settle(page);
  await page.locator('#app button:has-text("Spin the wheel")').first().click();
  await page.locator('#dlg button.primary').click();          // Spin
  await page.waitForFunction(() => document.querySelector('#lt0')?.textContent, null, { timeout: 15000 });
  check('the wheel lands on what the database picked', (await page.locator('#lt0').innerText()) === 'plank 3 min',
    await page.locator('#lt0').innerText());

  // The face is rotated so that slice sits under the pointer at the top.
  const deg = await page.locator('#sw0').evaluate(el => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return ((Math.atan2(m.b, m.a) * 180 / Math.PI) % 360 + 360) % 360;
  });
  const wanted = ((5 * 360 - (2 + 0.5) * 360 / 4) % 360 + 360) % 360;
  check('  with the wheel actually turned to that slice', Math.abs(deg - wanted) < 2, `${deg.toFixed(1)}° vs ${wanted}°`);

  // The chained day wheel follows on its own.
  await page.waitForFunction(() => document.querySelector('#lt1')?.textContent, null, { timeout: 15000 });
  check('  then the day wheel follows without being asked', /On \d+ days?|No days/.test(await page.locator('#lt1').innerText()),
    await page.locator('#lt1').innerText());

  const spins = await page.evaluate(() => self.__spins.length);
  check('  and only one spin was recorded', spins === 1, `${spins} spins`);
});

// Once spun, the group shows what you got, everyone else's, and the days to tick off.
await withPage({ ...SIGNED_IN, pick: 0 }, async page => {
  await settle(page);
  await page.locator('#app button:has-text("Spin the wheel")').first().click();
  await page.locator('#dlg button.primary').click();          // Spin
  await page.waitForFunction(() => document.querySelector('#lt1')?.textContent, null, { timeout: 20000 });
  await page.locator('#dlg button.primary').click();          // Got it
  await page.waitForTimeout(500);
  const text = await page.innerText('#app');
  check('the group shows your result', text.includes('100 burpees'), text.slice(0, 300));
  check('  and says who has not spun', text.includes('Sam: not spun yet'));
  check('  and posting is no longer blocked', await page.evaluate(() => dueIn(S.groups[0]).length) === 0);

  // The days are no longer ticked by hand: each one shows, and fills when that day's
  // quota has been met with the challenge. Nothing has been posted here yet, so none are.
  check('  with a day shown for each day of the cycle so far', await page.locator('.tick').count() >= 1,
    `${await page.locator('.tick').count()} days`);
  check('  none of them filled in yet', await page.locator('.tick.on').count() === 0);
});

// The builder: what goes on the wheel, how often, and the day wheel it chains to.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => { S.spins = [{ wheel_id: 7, user_id: 'u1', cycle: 2, id: 1, results: [], days_required: 0 }]; render(); openGroup(1); });
  await page.waitForTimeout(200);
  await page.locator('button:has-text("+ add a wheel")').click();
  await page.locator('#dlg textarea[name=segments]').fill('cold plunge\nsauna\nrun');
  await page.locator('#dlg input[name=name]').fill('Recovery');
  await page.locator('#dlg input[name=every]').fill('4');
  await page.locator('#dlg input[name=days]').fill('1, 2');
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => self.__saved);
  check('the builder saves a chain of two wheels', saved && saved.p_stages.length === 2, JSON.stringify(saved));
  check('  with the slices typed in', saved && saved.p_stages[0].segments.join('|') === 'cold plunge|sauna|run', JSON.stringify(saved && saved.p_stages[0]));
  check('  and the cadence', saved && saved.p_every === 4, String(saved && saved.p_every));
});

// A day wheel cannot ask for more days than the cycle has. The database refuses it too;
// this is so it is caught before anyone waits on a round trip.
await withPage(SIGNED_IN, async (page, alerts) => {
  await settle(page);
  await page.evaluate(() => { S.spins = [{ wheel_id: 7, user_id: 'u1', cycle: 2, id: 1, results: [], days_required: 0 }]; render(); openGroup(1); });
  await page.waitForTimeout(200);
  await page.locator('button:has-text("+ add a wheel")').click();
  await page.locator('#dlg input[name=name]').fill('Bad');
  await page.locator('#dlg textarea[name=segments]').fill('a\nb');
  await page.locator('#dlg input[name=every]').fill('3');
  await page.locator('#dlg input[name=days]').fill('1, 9');
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(300);
  check('a day wheel longer than the cycle is refused', alerts.some(a => /cannot ask for more than 3/.test(a)), alerts.join(' | '));
});

// breaks_streak: a cycle that closed with the challenge unfinished ends the streak on the
// day it closed. Sam has hit the quota three days running, so the streak is only about the
// challenge here.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const before = await page.evaluate(() => streak(S.groups[0], 'u2'));
  check('a wheel that does not break the streak leaves it alone', before === 3, `streak ${before}`);

  // Turn it on, with a cycle that closed yesterday and no spin against it.
  const after = await page.evaluate(() => {
    const w = S.wheels[0];
    w.breaks_streak = true;
    w.every_days = 1;                       // so every day is a cycle that closes
    w.starts_on = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
    return streak(S.groups[0], 'u2');
  });
  check('  and one that does breaks it', after === 0, `streak ${after}`);

  // Finishing it keeps the streak. A day is finished by posting the day's quota with the
  // challenge, so that is what this puts there.
  const kept = await page.evaluate(() => {
    const w = S.wheels[0], y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const c = cycleOf(w, y);
    S.spins = [...S.spins, {id: 99, wheel_id: w.id, user_id: 'u2', cycle: c, days_required: 1,
      results: [{seq: 0, kind: 'challenge', value: 'decline', i: 0, segs: ['decline']}]}];
    S.totals.push({g: 1, u: 'u2', d: y, m: 'pushups', n: 50, sp: 99, ch: 'decline'});
    return streak(S.groups[0], 'u2');
  });
  check('  and finishing the challenge keeps it', kept >= 1, `streak ${kept}`);

  // The quota chips and the completion rate stay about the quota alone.
  const rate = await page.evaluate(() => window.rate(S.groups[0], 'u2').n);
  check('  while the completion rate still counts quota days only', rate === 3, `${rate} days`);
});

// A wheel belongs to whoever made it. Everyone else has to spin it, so everyone else can
// look at it — they just cannot change it.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(200);
  await page.locator('.wh .top').first().click();
  await page.waitForTimeout(300);
  const text = await page.locator('#dlg').innerText();
  check('opening a wheel shows what is on it', /100 burpees/.test(text) && /5k run/.test(text), text.slice(0, 200));
  check('  and how often it is spun', /every 5 days/.test(text), text.slice(0, 200));
  check('  drawn as the wheel itself', await page.locator('#dlg .wheel-face').count() === 2);
  check('  and the maker gets an Edit button', await page.locator('#dlg button:has-text("Edit")').count() === 1);
  await page.locator('#dlg button:has-text("Edit")').click();
  await page.waitForTimeout(200);
  check('  which opens the editor', await page.locator('#dlg textarea[name=segments]').count() === 1);
});

await withPage({ ...SIGNED_IN, theirWheel: true }, async page => {
  await settle(page);
  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(200);
  await page.locator('.wh .top').first().click();
  await page.waitForTimeout(300);
  const text = await page.locator('#dlg').innerText();
  check('someone else\'s wheel still shows its options', /100 burpees/.test(text), text.slice(0, 200));
  check('  but offers no Edit', await page.locator('#dlg button:has-text("Edit")').count() === 0, text.slice(0, 200));
  check('  and says who to ask', /Only Sam can change this/.test(text), text.slice(0, 200));
  // Even reached directly, the editor refuses and falls back to the read-only view.
  await page.evaluate(() => wheelDlg(1, S.wheels[0]));
  await page.waitForTimeout(200);
  check('  and the editor cannot be opened around it', await page.locator('#dlg textarea[name=segments]').count() === 0);
});

// Sitting a cycle out: you can post without spinning, nothing is held against you, and
// the wheel is back next time.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  page.on('dialog', () => {});                      // the confirm is auto-dismissed by withPage
  await page.locator('#app button:has-text("Spin the wheel")').first().click();
  await page.waitForTimeout(300);
  check('the wheel offers a way out', await page.locator('#dlg button:has-text("Sit this one out")').count() === 1);
  check('  and says when it comes back', /It comes back/.test(await page.locator('#dlg').innerText()));
});

await withPage(SIGNED_IN, async page => {
  await settle(page);
  // Take the choice directly: the confirm() in front of it is dismissed by the harness.
  await page.evaluate(async () => { await sb.rpc('sit_out', {p_wheel: 7, p_day: today()}); await load(); });
  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(300);
  const text = await page.innerText('#app');
  check('sitting out shows on your own wheel', /Sitting this one out/.test(text), text.slice(0, 400));
  check('  with no days to tick off', await page.locator('.tick').count() === 0);
  check('  and posting is no longer blocked', await page.evaluate(() => dueIn(S.groups[0]).length) === 0);

  // The obligation goes with it. Checked both ways round on the same closed cycle, or
  // "does not break the streak" would pass just as well if nothing ever broke it.
  const res = await page.evaluate(() => {
    const w = S.wheels[0];
    w.breaks_streak = true;
    w.every_days = 1;                     // so yesterday is a cycle that has closed
    w.starts_on = daysAgo(10);
    const y = daysAgo(1), c = cycleOf(w, y);
    const row = extra => [{id: 900, wheel_id: w.id, user_id: 'u1', cycle: c, results: [], days_required: 1, ...extra}];
    S.spins = row({sat_out: false});
    const unfinished = brokeStreak(S.groups[0], 'u1', y);
    S.spins = row({sat_out: true});
    return {unfinished, sat: brokeStreak(S.groups[0], 'u1', y)};
  });
  check('  an unfinished challenge still breaks the streak', res.unfinished === true, JSON.stringify(res));
  check('  and a cycle sat out does not', res.sat === false, JSON.stringify(res));
});

// A result already seen cannot be walked away from: the app does not offer it, and the
// database refuses it. The schema tests cover the refusal; this is that the UI agrees.
await withPage({ ...SIGNED_IN, pick: 0 }, async page => {
  await settle(page);
  await page.evaluate(async () => { await sb.rpc('spin', {p_wheel: 7, p_day: today()}); await load(); openGroup(1); });
  await page.waitForTimeout(300);
  check('once spun, there is nothing left to sit out', await page.locator('#dlg button:has-text("Sit this one out")').count() === 0);
  const after = await page.evaluate(async () => {
    const {data} = await sb.rpc('sit_out', {p_wheel: 7, p_day: today()});
    return data.sat_out;
  });
  check('  and asking anyway leaves the result standing', after === false, String(after));
});

// ---- the challenge on a post
// The wheel gives you a modifier; the post says you did the group's exercise with it, and
// the day fills itself from that rather than from a tick.
await withPage({ ...SIGNED_IN, pick: 0, samSpun: true }, async page => {
  await settle(page);
  await page.evaluate(async () => { await sb.rpc('spin', {p_wheel: 7, p_day: today()}); await load(); });
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  // Off to begin with. A box that arrives ticked gets posted ticked by people who never
  // read it, and a challenge day nobody decided to claim is worth nothing.
  check('posting offers the challenge, unticked', await page.locator('#dlg input[name=chal]').count() === 1
    && !await page.locator('#dlg input[name=chal]').isChecked());
  const chal = page.locator('#dlg .chal');
  const label = await chal.innerText();
  check('  naming the one that is yours', /100 burpees/.test(label), label);
  check('    and saying what ticking it would mean', /did this with your challenge/i.test(label), label);
  check('  with nothing to choose between', await page.locator('#dlg select[name=chal]').count() === 0);
  // Fine print gets scrolled past. This has to be something you cannot miss on the way
  // to Post: a box of its own, as wide as the form, the height of a control.
  const box = await chal.boundingBox(), sheet = await page.locator('#dlg').boundingBox();
  check('  standing out rather than sitting in the small print',
    box && sheet && box.width > sheet.width * 0.8 && box.height >= 48, JSON.stringify(box));

  await page.locator('#dlg input[name=chal]').check();
  await page.locator('#dlg input[name=amount]').fill('50');
  await page.locator('#dlg input[name=video]').setInputFiles({ name: 'c.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1024, 5) });
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(900);

  const sent = await page.evaluate(() => self.__posts.at(-1));
  check('  and the post records the challenge', sent && sent.challenge === '100 burpees', JSON.stringify(sent));
  const mySpin = await page.evaluate(() => S.spins.find(sp => sp.user_id === 'u1').id);
  check('  pinned to your own spin, not the one it was borrowed from',
    sent && sent.spin_id === mySpin, `post ${JSON.stringify(sent)} vs own spin ${mySpin}`);
});

// Left unticked, a post carries no challenge — which is what happens if nobody touches it.
await withPage({ ...SIGNED_IN, pick: 0 }, async page => {
  await settle(page);
  await page.evaluate(async () => { await sb.rpc('spin', {p_wheel: 7, p_day: today()}); await load(); });
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  // Left alone, which is now the default rather than something to undo.
  await page.locator('#dlg input[name=amount]').fill('50');
  await page.locator('#dlg input[name=video]').setInputFiles({ name: 'c.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1024, 5) });
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(900);
  const sent = await page.evaluate(() => self.__posts.at(-1));
  check('  and the post carries no challenge', sent && sent.challenge === null, JSON.stringify(sent));
});

// Today's reps say whether today is in hand; the challenge days say how the cycle is
// going. Both belong on the feed, together, or the days are somewhere nobody looks.
await withPage({ ...SIGNED_IN, pick: 0, noDayWheel: true }, async page => {
  await settle(page);
  const need = await page.evaluate(async () => {
    await sb.rpc('spin', {p_wheel: 7, p_day: today()});
    await load();
    const sp = S.spins.find(x => x.user_id === 'u1'), g = S.groups[0];
    S.totals.push({g: g.id, u: 'u1', d: today(), m: 'pushups', n: 50, sp: sp.id, ch: effChallenge(sp)});
    render();
    return requiredDays(S.wheels[0], sp);
  });
  const head = await page.innerText('.hdr');
  check('the feed counts the quota and the challenge days side by side',
    /\/50\b/.test(head) && need > 1 && new RegExp(`1/${need} challenge days`).test(head), head);
  check('  naming the challenge, not just calling it one',
    head.includes(await page.evaluate(() => effChallenge(S.spins.find(x => x.user_id === 'u1')))), head);
});

// Sitting the cycle out leaves nothing to count, so nothing is claimed on the feed either.
await withPage({ ...SIGNED_IN, pick: 0 }, async page => {
  await settle(page);
  await page.evaluate(async () => { await sb.rpc('sit_out', {p_wheel: 7, p_day: today()}); await load(); });
  check('  and sitting out shows no challenge tile at all',
    !/challenge day/.test(await page.innerText('.hdr')), await page.innerText('.hdr'));
});

// The feed and the tracker read off the same thing.
await withPage({ ...SIGNED_IN, pick: 0 }, async page => {
  await settle(page);
  const view = await page.evaluate(async () => {
    await sb.rpc('spin', {p_wheel: 7, p_day: today()});
    await load();
    const sp = S.spins[0], g = S.groups[0];
    // a full day's quota, all of it with the challenge that is actually theirs
    S.totals.push({g: g.id, u: 'u1', d: today(), m: 'pushups', n: 50, sp: sp.id, ch: effChallenge(sp)});
    S.posts.unshift({id: 999, groupId: g.id, userId: 'u1', metric: 'pushups', amount: 50,
      caption: '', path: 'x', day: today(), ts: Date.now(), challenge: 'decline', spinId: sp.id});
    openGroup(1);
    return {days: challengeDays(g, sp).length, required: sp.days_required, done: challengeDone(g, sp)};
  });
  check('a full day with the challenge fills a day', view.days === 1, JSON.stringify(view));
  await page.waitForTimeout(200);
  const text = await page.innerText('#app');
  check('  the tracker counts it', new RegExp(`1 of ${view.required} day`).test(text), text.slice(0, 600));
  // The badge is uppercased by CSS, and innerText reports it that way, so match loosely.
  const badges = await page.locator('#app .badge').allInnerTexts();
  check('  and the feed says what was done', badges.some(b => /^\+50 DECLINE PUSHUPS$/i.test(b)), badges.join(' | '));

  // The same amount of the same exercise, done without the challenge, adds nothing.
  const without = await page.evaluate(() => {
    const g = S.groups[0], sp = S.spins[0], d = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    S.totals.push({g: g.id, u: 'u1', d, m: 'pushups', n: 50, sp: null, ch: null});
    return challengeDays(g, sp).length;
  });
  check('  but the same work without it does not', without === 1, String(without));

});

// Only your own challenge counts. Posting something labelled as a different one — one
// somebody else got, or one you swapped away from — does nothing for your days.
await withPage({ ...SIGNED_IN, pick: 0 }, async page => {
  await settle(page);
  const r = await page.evaluate(async () => {
    await sb.rpc('spin', {p_wheel: 7, p_day: today()});
    await load();
    const g = S.groups[0], sp = S.spins.find(x => x.user_id === 'u1');
    const mine = effChallenge(sp);
    // a full day's quota, but labelled with somebody else's challenge
    S.totals.push({g: g.id, u: 'u1', d: today(), m: 'pushups', n: 50, sp: sp.id, ch: 'knuckle'});
    const wrong = challengeDays(g, sp).length;
    // the same work, labelled with the one that is actually theirs
    S.totals.push({g: g.id, u: 'u1', d: today(), m: 'pushups', n: 50, sp: sp.id, ch: mine});
    return {mine, wrong, right: challengeDays(g, sp).length};
  });
  check('a day labelled with the wrong challenge does not count', r.wrong === 0, JSON.stringify(r));
  check('  and the same work with your own does', r.right === 1, JSON.stringify(r));
});

// You can only take somebody else's when the wheel sent you there.
await withPage({ ...SIGNED_IN, borrowWheel: true, samSpun: true }, async page => {
  await settle(page);
  await page.evaluate(async () => { await sb.rpc('spin', {p_wheel: 7, p_day: today()}); await load(); openGroup(1); });
  await page.waitForTimeout(300);
  check('landing on the borrow slice asks whose', /Pick whose you are doing/.test(await page.innerText('#app')),
    (await page.innerText('#app')).slice(0, 400));
  check('  and nothing can count until then', await page.evaluate(() => effChallenge(S.spins.find(x => x.user_id === 'u1'))) === '');

  await page.locator('#app button:has-text("Choose whose")').click();
  await page.waitForTimeout(300);
  const offered = await page.locator('#dlg .list b').allInnerTexts();
  check('  offering what the others got', offered.includes('5k run'), offered.join(' | '));
  check('  and never the borrow slice itself', !offered.some(t => /Someone else/.test(t)), offered.join(' | '));

  await page.locator('#dlg button:has-text("Take it")').first().click();
  await page.waitForTimeout(400);
  check('  taking one makes it yours', await page.evaluate(() => effChallenge(S.spins.find(x => x.user_id === 'u1'))) === '5k run');
  check('  and the group says it was borrowed', /borrowed/.test(await page.innerText('#app')));
});

// A wheel with no day wheel on it means every day it is running, not one day. Read off
// the wheel rather than the spin, so it is right for spins taken before the rule existed.
await withPage({ ...SIGNED_IN, pick: 0, noDayWheel: true }, async page => {
  await settle(page);
  const r = await page.evaluate(async () => {
    await sb.rpc('spin', {p_wheel: 7, p_day: today()});
    await load();
    const w = S.wheels[0], sp = S.spins.find(x => x.user_id === 'u1');
    // the spin still says 1, because that is what a wheel with no day stage stores
    return {stored: sp.days_required, need: requiredDays(w, sp), cycle: w.every_days};
  });
  check('with no day wheel, the whole cycle is the target', r.need === r.cycle, JSON.stringify(r));
  check('  not the 1 the spin recorded', r.stored === 1 && r.need !== r.stored, JSON.stringify(r));

  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(200);
  const text = await page.innerText('#app');
  check('  and the tracker says so', new RegExp(`0 of ${r.cycle} days done`).test(text), text.slice(0, 500));
});

// With a day wheel, what it landed on still governs.
await withPage({ ...SIGNED_IN, pick: 0 }, async page => {
  await settle(page);
  const r = await page.evaluate(async () => {
    await sb.rpc('spin', {p_wheel: 7, p_day: today()});
    await load();
    const w = S.wheels[0], sp = S.spins.find(x => x.user_id === 'u1');
    return {stored: sp.days_required, need: requiredDays(w, sp), cycle: w.every_days};
  });
  check('with a day wheel, the wheel still decides', r.need === r.stored && r.need !== r.cycle, JSON.stringify(r));
});

// ---- recording in the app
// Handing off to the phone's own camera is what lost recordings and cut them short: iOS
// is free to evict the app while its camera sheet is up. This records in the page instead.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  check('posting offers to record', await page.locator('#dlg button:has-text("Record")').count() === 1);
  check('  and to choose a file instead', await page.locator('#dlg button:has-text("Choose a file")').count() === 1);

  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForSelector('#cam[open]', { timeout: 5000 });
  check('  the camera opens in the app, not a separate sheet', await page.locator('#cam').isVisible());
  // Opening the camera is not instant. A shutter that can be pressed before there is a
  // stream behind it is exactly the tap that did nothing, so it has to be dead until then.
  check('  the shutter cannot be pressed before the camera is up',
    await page.evaluate(() => $('#camgo').disabled && !camStream));
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  const live = await page.evaluate(() => !!(camStream && camStream.getVideoTracks().length));
  check('  and once it can, there is a live stream behind it', live);

  await page.locator('#camgo').click();
  await page.waitForTimeout(2500);
  check('  the shutter shows it is running', await page.locator('#camgo.on').count() === 1);
  check('  and counts the seconds', /0:0\d/.test(await page.locator('#camtime').innerText()),
    await page.locator('#camtime').innerText());
  await page.locator('#camgo').click();
  await page.waitForTimeout(800);

  const rec = await page.evaluate(() => recorded && {size: recorded.size, type: recorded.type, cam: !!recorded.fromCamera});
  check('  stopping keeps the recording', rec && rec.size > 1024, JSON.stringify(rec));
  check('  marked as ours, so it is never re-encoded', rec && rec.cam === true, JSON.stringify(rec));
  check('  and it is offered back to watch before it goes anywhere', await page.locator('#camrev').isVisible());
  // Parked rather than stopped: letting every track end is what made the phone ask for
  // the camera again on the very next open. Nothing is being watched or heard while it
  // waits, and it goes out on its own.
  check('  with the preview let go of while you watch', await page.evaluate(() => $('#campre').srcObject === null));
  check('    and nothing listening', await page.evaluate(() => camStream.getAudioTracks().every(t => !t.enabled)));
  check('    but the camera not handed back, so it is not asked for twice',
    await page.evaluate(() => camStream.getVideoTracks().some(t => t.readyState === 'live')));
  check('    and it goes out when the app does', await page.evaluate(() => { dropCam(); return camStream === null; }));
  check('  and the form says what it has', /Recorded/.test(await page.locator('#vsize').innerText()),
    await page.locator('#vsize').innerText());
  await page.locator('#camrev button:has-text("Use this")').click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  check('  keeping it closes the camera', await page.locator('#cam').isHidden());
});

// A camera people already know how to use: point it the other way, count yourself in,
// cut the sound, watch it back. Chromium's fake device reports one camera and ignores
// facingMode, so the device list is stood in for where the count is what is being read.
const twoCameras = page => page.evaluate(() => {
  const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = async () => {
    const ds = await real();
    return [...ds, {kind: 'videoinput', deviceId: 'front', label: 'front', groupId: 'g'}];
  };
});

await withPage(NO_WHEEL, async page => {
  await settle(page);
  await twoCameras(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });

  check('the camera offers to point the other way', await page.locator('#camflip').isVisible());
  check('  starting on the back one', await page.evaluate(() => facing()) === 'environment');
  check('  which is not mirrored', !(await page.locator('#campre').evaluate(v => v.classList.contains('mirror'))));

  await page.locator('#camflip').click();
  await page.waitForFunction(() => facing() === 'user' && !$('#camgo').disabled, null, { timeout: 10000 }).catch(() => {});
  check('  flipping turns it round', await page.evaluate(() => facing()) === 'user');
  check('  and shows you mirrored, the way every phone does',
    await page.locator('#campre').evaluate(v => v.classList.contains('mirror')));
  check('  with a live stream still behind it',
    await page.evaluate(() => !!(camStream && camStream.getVideoTracks().length)));

  // The sound
  check('the microphone is on to start with', await page.evaluate(() => camStream.getAudioTracks()[0].enabled));
  check('  and does not claim otherwise', await page.locator('#micoff').isHidden());
  await page.locator('#cammic').click();
  check('  and can be cut', await page.evaluate(() => !camStream.getAudioTracks()[0].enabled)
    && await page.locator('#cammic').evaluate(b => b.classList.contains('on')));
  check('  which the icon says', await page.locator('#micoff').isVisible());
  // A light this camera does not have is not offered. The fake device reports no torch,
  // and neither does any iPhone: Safari has never exposed one.
  check('a camera with no light is not given a light button', await page.locator('#camtorch').isHidden());

  // The count-in
  check('the self timer starts off', (await page.locator('#camtimer').innerText()).trim() === 'Off');
  await page.locator('#camtimer').click();
  check('  and cycles', (await page.locator('#camtimer').innerText()).trim() === '3s');
  await page.locator('#camtimer').click();
  check('  through the usual two', (await page.locator('#camtimer').innerText()).trim() === '10s');
  await page.locator('#camtimer').click();
  check('  and back off', (await page.locator('#camtimer').innerText()).trim() === 'Off');
});

// With a timer set, the shutter counts you in rather than recording the walk back.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  await page.locator('#camtimer').click();                 // 3s
  await page.locator('#camgo').click();
  await page.waitForTimeout(400);
  check('a self timer counts you in before it records', await page.locator('#camcount').isVisible());
  check('  and has not started yet', await page.evaluate(() => !recording()));
  check('  with the timer and the flip out of reach while it counts',
    await page.locator('#camtimer').isDisabled() && await page.locator('#camflip').isDisabled());
  await page.waitForFunction(() => recording(), null, { timeout: 6000 }).catch(() => {});
  check('  then starts on its own', await page.evaluate(() => recording()));
  check('  and the count goes away', await page.locator('#camcount').isHidden());
  check('  with the flip still held while it runs', await page.locator('#camflip').isDisabled());
});

// Which way it was pointing last time is worth remembering: somebody filming themselves
// wants the front camera every time, and choosing it again on every post is the kind of
// small stupidity that makes a camera feel like not a camera.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await twoCameras(page);
  // Closing the camera puts you back on the submit sheet, which is still open, so the
  // second time round there is nothing to open — just Record again.
  const open = async () => {
    if (!await page.locator('#dlg').evaluate(d => d.open)) {
      await page.locator('.bar .add').click();
      await page.waitForTimeout(300);
    }
    await page.locator('#dlg button:has-text("Record")').click();
    await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  };
  await open();
  check('nothing remembered means the back camera', await page.evaluate(() => facing()) === 'environment');
  await page.locator('#camflip').click();
  await page.waitForFunction(() => facing() === 'user' && !$('#camgo').disabled, null, { timeout: 10000 }).catch(() => {});
  await page.locator('#camx').click().catch(() => {});
  await page.waitForTimeout(300);

  await open();
  check('  and it opens the way you left it next time', await page.evaluate(() => facing()) === 'user'
    && await page.locator('#campre').evaluate(v => v.classList.contains('mirror')));
  check('  across a reload, not just a reopen',
    await page.evaluate(() => localStorage.getItem('quota.facing')) === 'user');
});

// Watching it back is only worth having if you can say no.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  await page.locator('#camgo').click();
  await page.waitForTimeout(2000);
  await page.locator('#camgo').click();
  await page.waitForTimeout(800);
  check('the take is there to watch', await page.locator('#camrev').isVisible()
    && (await page.locator('#camplay').getAttribute('src') || '').startsWith('blob:'));
  check('  saying how long it runs and how big it is',
    /\d:\d\d · [\d.]+ MB/.test(await page.locator('#camrevw').innerText()),
    await page.locator('#camrevw').innerText());
  await page.locator('#camrev button:has-text("Retake")').click({ timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 }).catch(() => {});
  check('  turning it down throws it away', await page.evaluate(() => recorded === null));
  check('  and brings the camera back', await page.locator('#camrev').isHidden()
    && await page.evaluate(() => !!(camStream && camStream.getVideoTracks().length)));
  check('  leaving nothing behind on the form', (await page.locator('#vsize').innerText()).trim() === '');
});

// Closing on a recording in progress is a stop, not a discard: what was filmed up to
// that point is still worth keeping, and tearing the camera down first would lose the end.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  await page.locator('#camgo').click();
  await page.waitForTimeout(2000);
  await page.locator('#camx').click();
  await page.waitForTimeout(900);
  const rec = await page.evaluate(() => recorded && recorded.size);
  check('closing mid-recording keeps what was filmed', rec > 1024, `recorded: ${rec}`);
  check('  and still lets the preview go', await page.evaluate(() => $('#campre').srcObject === null));
  check('  and hands it back to watch rather than binning it', await page.locator('#camrev').isVisible());
});

// What was recorded is what gets uploaded: no compression step, nothing re-encoded.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  lastUpload = null;
  uploadReply = { status: 200, body: '{}', hold: null };
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  await page.locator('#camgo').click();
  await page.waitForTimeout(2500);
  await page.locator('#camgo').click();
  await page.waitForTimeout(800);
  await page.locator('#camrev button:has-text("Use this")').click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const size = await page.evaluate(() => recorded.size);

  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(2500);
  const seen = await labels(page);
  check('a recording posts without a compressing step', !seen.some(t => /Compressing/.test(t)), seen.join(' -> '));
  check('  and the bytes that went up are the ones recorded', lastUpload && lastUpload.length === size,
    `sent ${lastUpload && lastUpload.length} of ${size}`);
});

// ---- one bad row must not take the app down
// render() runs in runLoad's finally, so a view that throws escapes the whole load: the
// splash stays up, and Retry does exactly the same thing again. Nothing that comes out of
// the database is allowed to get that far.
await withPage({ ...SIGNED_IN, badRows: true }, async page => {
  await settle(page);
  const app = await page.innerHTML('#app');
  check('a null jsonb column still loads the app', !app.includes('splash') && !app.includes('not right'),
    app.slice(0, 200));
  check('  and the feed is the real one, not a fallback', await page.isVisible('.hdr') && await page.isVisible('#bar'));
  check('  with no error bar', await page.isHidden('#err'));
});

// And if a screen still manages to throw, it says so and leaves the rest usable.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  // If the guard is not there this throw comes straight back out, so it is caught here
  // rather than taking the whole run with it: the checks below are what should report it.
  await page.evaluate(() => { self.feedView = () => { throw new Error('boom'); }; go('feed'); }).catch(() => {});
  await page.waitForTimeout(300);
  check('a screen that cannot be drawn says so instead of freezing',
    (await page.innerText('#app')).includes('not right') && (await page.innerText('#err')).includes('boom'),
    await page.innerText('#app'));
  check('  and the other tabs still work', await page.isVisible('#bar'));
  await page.evaluate(() => go('groups'));
  await page.waitForTimeout(300);
  check('  going to one of them gets there', /my groups/i.test(await page.innerText('#app')),
    (await page.innerText('#app')).slice(0, 200));
});

// A fault on somebody's own phone is only fixable if they can hand over what it said.
await withPage({ ...SIGNED_IN, queryError: 'boom' }, async (page, alerts) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await settle(page);
  check('a failed load says so', (await page.innerText('#err')).includes('boom'), await page.innerText('#err'));
  await page.locator('#err button:has-text("Copy")').click();
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check('  and the whole thing can be copied out', /boom/.test(copied) && /quota-v/.test(copied) && /Mozilla/.test(copied),
    JSON.stringify(copied));
  check('  including where it happened', copied.split('\n').length > 3, JSON.stringify(copied));
  check('  and the build is on the profile too', await page.evaluate(() => {
    S.me = S.me || {username: 'ari'}; go('profile');
    return $('#app').innerText.includes(BUILD);
  }));
});

// A phone keeps only a handful of <video> elements loaded at once. A feed that hands a
// source to every post at once spends that budget on clips nobody is looking at, and the
// ones further down come up black — "sometimes someone else's video doesn't work".
await withPage({ ...SIGNED_IN, manyPosts: 12 }, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  // Every post gets a clip the browser can really play, so what is being watched here is
  // the feed's decision about which ones to load, not a URL that was never a video.
  const clip = await realClip(page);
  await page.evaluate(u => {
    document.querySelectorAll('.reel video').forEach(v => { v.removeAttribute('src'); v.dataset.src = u; v.load(); });
    document.querySelectorAll('.reel').forEach(r => r.classList.remove('bust'));
    watchClips();
  }, clip);
  await page.waitForTimeout(600);
  const n = await page.locator('.reel video').count();
  const loaded = () => page.locator('.reel video[src]').count();
  check('the feed has more clips than fit on a screen', n >= 12, `${n} clips`);
  check('  but only the ones near it are given a source', await loaded() < n, `${await loaded()} of ${n} loaded`);
  check('  and the first one is', await page.locator('.reel video').first().getAttribute('src') !== null);

  await page.locator('.reel').last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  check('  scrolling down loads the one you reach',
    await page.locator('.reel video').last().getAttribute('src') !== null);
  check('  and lets go of the one you left',
    await page.locator('.reel video').first().getAttribute('src') === null,
    `${await loaded()} of ${n} still loaded`);
});

// ---- clips that will not play
// A signed URL lasts an hour, and a post whose file is gone never gets one at all. Both
// used to render as a black rectangle with a play button that did nothing, which is
// exactly what a slow clip looks like: "sometimes someone else's video doesn't work".
await withPage({ ...SIGNED_IN, noSign: true }, async page => {
  await settle(page);
  const v = page.locator('.post video').first();
  check('a clip with no signed URL is not given a broken source',
    await v.getAttribute('src') === null, JSON.stringify(await v.getAttribute('src')));
  await v.click();
  await page.waitForTimeout(400);
  check('  tapping it asks for a fresh URL rather than doing nothing',
    await page.evaluate(() => self.__resigned) >= 1);
  check('  and plays what comes back', (await v.getAttribute('src') || '').startsWith('data:video/mp4'),
    JSON.stringify(await v.getAttribute('src')));
  // The stub's URL cannot actually decode, so this ends at the honest message. What
  // matters is that it asked once and stopped: a player that re-signs on every error
  // would sit in a loop hammering storage instead.
  await page.waitForTimeout(600);
  check('  and asks only once, however many times it fails',
    await page.evaluate(() => self.__resigned) === 1, `${await page.evaluate(() => self.__resigned)} times`);
});

// When the fresh URL does not help either, it says so instead of staying black.
await withPage({ ...SIGNED_IN, noSign: true, resignFails: true }, async page => {
  await settle(page);
  await page.locator('.post video').first().click();
  await page.waitForTimeout(400);
  check('a clip that cannot be loaded says so', await page.locator('.reel.bust').count() >= 1);
  check('  in words, not a black rectangle', /could not be loaded/.test(await page.locator('.reel .bust p').first().innerText()),
    await page.locator('.reel .bust p').first().innerText());
  check('  and offers to try again', await page.locator('.reel .bust button').first().isVisible());
});

// A codec this device has no decoder for is not something a new URL can fix, and saying
// "could not be loaded" would send people re-tapping forever.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => {
    const v = document.querySelector('.post video');
    Object.defineProperty(v, 'error', {value: {code: 4}, configurable: true});
    clipBust(v, S.posts[0].id, true);
  });
  await page.waitForTimeout(300);
  check('an unplayable format says that, and does not re-sign',
    /format this device cannot play/.test(await page.locator('.reel .bust p').first().innerText())
    && !(await page.evaluate(() => self.__resigned)),
    await page.locator('.reel .bust p').first().innerText());
});

// A post has two pictures in it: the proof, and the face of whoever posted it. Every
// assertion about the proof passed while the avatar was being stretched across the top of
// every post, over the name and the username, so this is about the other one.
await withPage({ ...SIGNED_IN, photos: true }, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.evaluate(() => {            // give everyone a face to draw
    Object.values(S.profiles).forEach(u => { u.avatar_path = 'x.png'; });
    render();
  });
  await page.waitForTimeout(300);
  const box = await page.locator('.post .head .av img').first().boundingBox();
  check('the poster\'s face stays the size of a face', box && box.width <= 40 && box.height <= 40,
    JSON.stringify(box));
  const reel = await page.locator('.post .reel').first().boundingBox();
  check('  rather than being stretched over the post', box && reel && box.width < reel.width / 2,
    `${JSON.stringify(box)} in ${JSON.stringify(reel)}`);
  check('  leaving the name and the username where they can be read',
    await page.locator('.post .head .who').first().isVisible()
    && await page.locator('.post .head .when').first().isVisible());
  const top = await page.locator('.post .head').first().innerText();
  check('    and actually saying them', /Ari/.test(top) && /@ari/.test(top), top);

  // The lazy loading is about the proof, not about faces: it takes the src off whatever it
  // is given once that is off screen, and an avatar it was handed would simply vanish.
  check('  and the face is not mistaken for something to unload',
    await page.evaluate(() => ![...document.querySelectorAll('.reel .proof')].some(el => el.closest('.av'))));
  await page.locator('.post').last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  check('    so it is still there after scrolling',
    await page.locator('.post .head .av img').first().getAttribute('src') !== null);
});

// ---- liking, and comments in a sheet of their own
// Under the clip and straight above the replies, so liking a post and answering it are
// the same gesture in the same place. The count moves the instant it is tapped rather
// than after a round trip.
await withPage(SIGNED_IN, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const heart = page.locator('.post .acts .lk').first();
  const bubble = page.locator('.post .acts .cc').first();
  check('a post can be liked', await heart.count() === 1);
  await page.evaluate(() => { self.__v0 = document.querySelector('.post video'); });
  check('  from under the clip, not over it', await page.evaluate(() => {
    const r = document.querySelector('.post .acts'), reel = document.querySelector('.post .reel');
    if (!r || !reel) return false;
    const a = r.getBoundingClientRect(), b = reel.getBoundingClientRect();
    return a.top >= b.bottom - 1;
  }));
  check('    and the replies sit under that again', await page.evaluate(() => {
    const acts = document.querySelector('.post .acts'), cm = document.querySelector('.post .cmts');
    return !!acts && !!cm && acts.compareDocumentPosition(cm) === Node.DOCUMENT_POSITION_FOLLOWING;
  }));
  // A blank where a number goes reads as something still loading. Zero is a number.
  check('  a post nobody has liked says nought, rather than nothing',
    (await heart.innerText()).trim() === '0', await heart.innerText());
  check('    and so does its comment count', /^0 comments$/.test((await bubble.innerText()).trim()),
    await bubble.innerText());

  // The stub's clips cannot decode, so this post is showing its failure card — which is
  // the case worth checking: a clip that would not load is still a post worth replying to.
  check('  and reachable even on a post whose clip would not load',
    await page.locator('.post .reel.bust').count() > 0);
  await heart.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
  check('  tapping it counts at once', (await heart.innerText()).trim() === '1');
  check('    and the clip is the same element it was, not a fresh black one',
    await page.evaluate(() => document.querySelector('.post video') === self.__v0));
  check('    and says it was you', await heart.evaluate(b => b.classList.contains('on')));
  check('    with the like really sent', (await page.evaluate(() => self.__likes)).length === 1,
    JSON.stringify(await page.evaluate(() => self.__likes)));

  await heart.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
  check('  and again takes it back', (await heart.innerText()).trim() === '0'
    && !await heart.evaluate(b => b.classList.contains('on'))
    && (await page.evaluate(() => self.__likes)).length === 0,
    (await heart.innerText()).trim());

  // A big count is shortened the way counts are shortened everywhere, so five digits do
  // not walk across the clip.
  const shown = await page.evaluate(() => {
    const id = S.posts[0].id;
    const put = n => { S.likes = Array.from({length: n}, (_, i) => ({p: id, u: 'x' + i})); render();
      return document.querySelector('.post .acts .lk b').textContent; };
    const out = {a: put(999), b: put(1000), c: put(1200), d: put(15400), e: put(2400000)};
    S.likes = []; render(); return out;
  });
  check('  a big count is shortened', JSON.stringify(shown) ===
    JSON.stringify({a: '999', b: '1K', c: '1.2K', d: '15K', e: '2.4M'}), JSON.stringify(shown));

  // Comments sit under the post again, with a box that is always ready: on a post you are
  // already looking at, the thing to say is the thing in front of you.
  check('the replies are under the post, not behind a sheet', await page.locator('.post .cmts').count() > 0);
  check('  with somewhere to type already there', await page.locator('.post .cin input').count() > 0);
  check('  and nothing to open first', await page.locator('#cmt').count() === 0);
  check('  the caption is under the clip, where it reads',
    await page.locator('.post .cap').first().isVisible());

  const box = page.locator('.post .cin input').first();
  const send = page.locator('.post form.cin button.primary').first();
  const list = () => page.locator('.post .clist').first().innerText();

  // Held open, so what shows here is what the page put up on its own rather than what came
  // back: a count that waits on the round trip reads as a tap that did nothing.
  await page.evaluate(() => { self.__stall = new Promise(r => { self.__go = r; }); });
  await box.fill('nice one');
  await send.click();
  await page.waitForTimeout(250);
  check('  a comment counts before the write comes back', /^1 comment$/.test((await bubble.innerText()).trim()),
    await bubble.innerText());
  check('    and shows under the post that soon too', /nice one/.test(await list()), await list());
  check('      with no delete on it until it is really saved',
    await page.locator('.post .clist .x').count() === 0);
  await page.evaluate(() => { const g = self.__go; self.__stall = null; g(); });
  await page.waitForTimeout(900);
  check('  a comment written there stays there', /nice one/.test(await list()), await list());
  check('    and it can be taken back once it is saved', await page.locator('.post .clist .x').count() === 1);

  await page.locator('.post .clist .x').first().click();
  await page.waitForTimeout(900);
  check('  taking one back drops the count with it', /^0 comments$/.test((await bubble.innerText()).trim()),
    await bubble.innerText());

  // The phone's keyboard has its own emoji key; this is the one in the box, for reaching
  // them without leaving the field.
  check('  the box has an emoji button', await page.locator('.post .cin .emo').count() > 0);
  check('    which is put away until it is asked for', await page.locator('.post .cmts .emoji').first().isHidden());
  await page.locator('.post .cin .emo').first().click();
  await page.waitForTimeout(200);
  check('    and opens a set to pick from', await page.locator('.post .cmts .emoji').first().isVisible()
    && await page.locator('.post .cmts .emoji button').count() >= 10);
  await box.fill('great');
  await page.locator('.post .cmts .emoji button').first().click();
  await page.waitForTimeout(200);
  check('    putting one where the caret was', /great./.test(await box.inputValue()), await box.inputValue());
  // A redraw lands between the tap and the insert often enough to matter: the tray that
  // was tapped is then a branch that has been thrown away, and walking up from it reaches
  // a box nobody can see. It goes into the one on screen.
  await box.fill('again');
  await page.evaluate(() => {
    const t = document.querySelector('.post .cmts .emoji button');
    render();                                        // the whole screen, out from under it
    putEmoji(t, '\u2705');
  });
  await page.waitForTimeout(200);
  check('      even when the screen is redrawn under the tap',
    /again\u2705/.test(await box.inputValue()), await box.inputValue());
  check('      and the tray is still open after a redraw',
    await page.locator('.post .cmts .emoji').first().isVisible());

  // Every post carries its own box and its own tray, so the one you opened is the one that
  // answers — the second post must not have taken the first one's emoji.
  const many = await page.evaluate(() => document.querySelectorAll('.post .cin input').length);
  if (many > 1) {
    const second = await page.locator('.post .cmts .emoji').nth(1).isHidden();
    check('    and the tray belongs to the post it was opened from', second === true);
  }
});

// The reaction buttons moved off the clip with the like, so the picker has to come up over
// the row it was opened from rather than over the video.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.locator('.post .acts .react').first().click();
  await page.waitForTimeout(200);
  check('the picker opens from the row under the clip', await page.locator('.post .acts .reactpick').count() === 1);
  check('  clear of the clip above it', await page.evaluate(() => {
    const pick = document.querySelector('.reactpick'), reel = document.querySelector('.post .reel');
    if (!pick || !reel) return false;
    return pick.getBoundingClientRect().top >= reel.getBoundingClientRect().top;
  }));
});

// A long run is the point of the app, so it gets stopped for — once, on the day it was
// earned, and never again for the same number.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  check('nothing is celebrated on an ordinary day', await page.locator('#party').isHidden());

  // 25 days behind today, and today already done: the run is real and it ends now.
  const back = async n => page.evaluate(days => {
    const d = i => { const x = new Date(); x.setDate(x.getDate() - i); return x.toLocaleDateString('en-CA'); };
    S.totals = S.totals.filter(t => t.u !== 'u1');
    for (let i = 0; i < days; i++) S.totals.push({g: 1, u: 'u1', d: d(i), m: 'pushups', n: 50});
    render();
  }, n);

  await back(25);
  await page.waitForTimeout(200);
  check('twenty-five days is worth stopping for', await page.locator('#party').isVisible());
  check('  and it says which run it is', /25/.test(await page.locator('#party .n').innerText()),
    await page.locator('#party .n').innerText());
  check('  with confetti over it', await page.locator('#party canvas').count() === 1);

  await page.locator('#party button:not(.share)').click();
  await page.waitForTimeout(150);
  check('  it goes away when it is dismissed', await page.locator('#party').isHidden());

  // The same run, drawn again. It must not come back.
  await page.evaluate(() => render());
  await page.waitForTimeout(200);
  check('  and does not come back on the next render', await page.locator('#party').isHidden());
  check('    because the number is written down', await page.evaluate(() => localStorage.milestone) === '25');
  check('      and read back before celebrating anything', await page.evaluate(() => milestoneDue()) === 0);

  // A day that is not a milestone passes without a word.
  await back(26);
  await page.waitForTimeout(200);
  check('  twenty-six is just another day', await page.locator('#party').isHidden());

  // The next one up still lands, and skips the ones never seen rather than queueing them.
  await back(365);
  await page.waitForTimeout(200);
  check('a year lands, and does not walk up through every number below it',
    await page.locator('#party').isVisible()
    && /365/.test(await page.locator('#party .n').innerText()),
    await page.locator('#party .n').innerText().catch(() => '(hidden)'));
  await page.locator('#party button:not(.share)').click();

  // Nothing is celebrated for a run that has not been earned today.
  await page.evaluate(() => {
    const d = i => { const x = new Date(); x.setDate(x.getDate() - i); return x.toLocaleDateString('en-CA'); };
    try { localStorage.removeItem('milestone'); } catch (e) {}
    S.totals = S.totals.filter(t => t.u !== 'u1');
    for (let i = 1; i <= 100; i++) S.totals.push({g: 1, u: 'u1', d: d(i), m: 'pushups', n: 50});
    render();
  });
  await page.waitForTimeout(200);
  check('  and a run with today still owing is not celebrated yet',
    await page.locator('#party').isHidden());
});

// A story is findable from the face on a post, not only from the row at the top: somebody
// scrolling the feed should not have to go back up to notice one.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const ring = () => page.locator('.post .head .rg').first();
  check('a face on a post carries no ring when there is no story behind it',
    await page.locator('.post .head .rg').count() === 0
    && await page.locator('.post .head .av').count() > 0);

  await page.evaluate(() => {
    S.stories = [{id: 40, u: 'u2', kind: 'text', body: 'out early', ts: Date.now() - 36e5, style: {}}];
    S.seen = []; render();
  });
  await page.waitForTimeout(250);
  check('  a story lights the ring on every post of theirs', await page.locator('.post .head .rg.new').count() >= 1);
  check('    and leaves your own face alone', await page.evaluate(() => {
    const mine = [...document.querySelectorAll('.post[data-post]')].filter(el => /@ari/.test(el.querySelector('.head').innerText));
    return mine.length > 0 && mine.every(el => !el.querySelector('.head .rg'));
  }));
  await ring().click();
  await page.waitForTimeout(300);
  check('  tapping it opens their story', await page.locator('#story').isVisible()
    && /out early/i.test(await page.locator('#story .face').innerText()));
  await page.locator('#story .who .x').click();
  await page.waitForTimeout(350);
  check('  and once watched the ring goes quiet, on the post as well as the row',
    await page.locator('.post .head .rg.old').count() >= 1
    && await page.locator('.post .head .rg.new').count() === 0
    && await page.locator('.stories .s:not(.me) .rg.old').count() === 1);
  check('    with the face still there', await page.locator('.post .head .rg .av').count() >= 1);
  // A day old and it is nobody's ring any more.
  await page.evaluate(() => { S.stories = S.stories.map(x => ({...x, ts: Date.now() - 25 * 36e5})); render(); });
  await page.waitForTimeout(250);
  check('  a story that has expired takes its ring with it', await page.locator('.post .head .rg').count() === 0);
});

// Every sheet has a way back out of it.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => storyKind());
  await page.waitForTimeout(300);
  check('the new-story sheet offers a way out', /cancel/i.test(await page.locator('#dlg').innerText()),
    await page.locator('#dlg').innerText());
  await page.locator('#dlg button:has-text("Cancel")').click();
  await page.waitForTimeout(350);
  check('  and taking it leaves nothing behind', await page.locator('#dlg').isHidden()
    && await page.evaluate(() => S.draft) === null
    && await page.locator('#make').isHidden());

  // The dark part of the screen is the other way out, on a sheet that is only choices.
  await page.evaluate(() => storyKind());
  await page.waitForTimeout(300);
  await page.evaluate(() => $('#dlg').dispatchEvent(new MouseEvent('click', {bubbles: true})));
  await page.waitForTimeout(350);
  check('  tapping beside it closes it too', await page.locator('#dlg').isHidden());

  // But not on one holding something typed or chosen.
  await page.evaluate(() => groupDlg());
  await page.waitForTimeout(400);
  check('    a sheet with a form in it is holding something', await page.locator('#dlg form').count() === 1);
  await page.evaluate(() => $('#dlg').dispatchEvent(new MouseEvent('click', {bubbles: true})));
  await page.waitForTimeout(350);
  check('      so a stray tap beside it does not throw that away', await page.locator('#dlg').isVisible());
});

// What happened today, and only today. Yesterday is not news by the morning.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  // Noon rather than "an hour ago": a test that runs just after midnight would otherwise
  // be asking whether an hour ago was yesterday, and sometimes it is.
  await page.evaluate(() => {
    const noon = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d.getTime(); };
    S.comments = [{id: 901, postId: S.posts[0].id, userId: 'u2', body: 'strong', ts: noon(0)},
                  {id: 902, postId: S.posts[0].id, userId: 'u2', body: 'yesterday', ts: noon(1)}];
    S.posts = S.posts.map(p => ({...p, ts: noon(4)}));            // only the comments are news
    render();
  });
  await page.waitForTimeout(200);
  const box = page.locator('.act');
  check('the activity line is about today', /today/i.test(await box.locator('summary').innerText()),
    await box.locator('summary').innerText());
  check('  and leaves yesterday out of it', await page.locator('.act .e').count() === 1, await box.innerText());
  check('    counting only what it lists', /\b1\b/.test(await box.locator('summary').innerText()),
    await box.locator('summary').innerText());
  await page.evaluate(() => {
    const noon = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d.getTime(); };
    S.comments = S.comments.map(c => ({...c, ts: noon(2)})); render();
  });
  await page.waitForTimeout(200);
  check('  with nothing today, there is no line at all', await page.locator('.act').count() === 0);
});

// Stories. Only people with one running are in the row, unseen first, and somebody you
// share a group with who has posted nothing is simply not in it.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const put = rows => page.evaluate(list => {
    S.stories = list.map(r => ({...r, ts: Date.now() - (r.agoMins || 1) * 60000, style: r.style || {}}));
    S.seen = []; render();
  }, rows);

  await put([]);
  check('with nobody posting, the row is just your own circle',
    await page.locator('.stories .s').count() === 1);
  check('  which offers to add one', /Add story/.test(await page.locator('.stories .s.me').innerText()));

  // A day is not one story. Having posted one must not be the thing that stops the next.
  await put([{id: 50, u: 'u1', kind: 'text', body: 'first of the day'}]);
  check('  your own circle keeps offering another once you have posted one',
    await page.locator('.stories .s.me .plus').count() === 1);
  await page.locator('.stories .s.me .plus').click();
  await page.waitForTimeout(300);
  check('    and it asks what kind, rather than opening the one you have',
    /New story/.test(await page.locator('#dlg').innerText()) && await page.locator('#story').isHidden(),
    await page.locator('#dlg').innerText());
  await page.locator('#dlg button:has-text("Just words")').click();
  await page.waitForTimeout(300);
  check('    on a blank card, not the one already up',
    await page.locator('#make').isVisible() && await page.evaluate(() => S.draft.body) === ''
    && await page.evaluate(() => S.draft.editing) === undefined);
  await page.evaluate(() => closeDraft());
  await page.locator('.stories .s.me .own').click();
  await page.waitForTimeout(300);
  check('    while the ring itself still watches back what is there',
    await page.locator('#story').isVisible() && /first of the day/i.test(await page.locator('#story .face').innerText()));
  await page.locator('#story .who .x').click();
  await page.waitForTimeout(250);
  await put([]);
  check('    and somebody you share a group with but who has posted nothing is not in it',
    await page.locator('.stories .s').count() === 1);

  await put([{id: 1, u: 'u2', kind: 'text', body: 'day one'}]);
  check('somebody with a story appears', await page.locator('.stories .s').count() === 2);
  check('  with a lit ring because it has not been watched',
    await page.locator('.stories .s:not(.me) .rg.new').count() === 1);

  // Watched, and the ring goes quiet rather than the person disappearing.
  await page.locator('.stories .s:not(.me)').click();
  await page.waitForTimeout(300);
  check('  tapping it opens the story', await page.locator('#story').isVisible());
  // The Strong face sets them in capitals, which is a look, not a change to the words.
  check('    with the words on it', /day one/i.test(await page.locator('#story .face').innerText()),
    await page.locator('#story .face').innerText());
  check('    and it counts as seen', await page.evaluate(() => S.seen.length) === 1);
  await page.locator('#story .who .x').click();
  await page.waitForTimeout(250);
  check('    the ring is quiet once watched',
    await page.locator('.stories .s:not(.me) .rg.old').count() === 1);
  check('      and they are still in the row', await page.locator('.stories .s').count() === 2);

  // Unseen ones come first however they arrive.
  await page.evaluate(() => {
    S.profiles.u3 = {id: 'u3', username: 'kit', display_name: 'Kit'};
    S.groups[0].members = [...new Set([...S.groups[0].members, 'u3'])];
  });
  await put([{id: 1, u: 'u2', kind: 'text', body: 'seen one'}, {id: 2, u: 'u3', kind: 'text', body: 'fresh'}]);
  await page.evaluate(() => { S.seen = [1]; render(); });
  await page.waitForTimeout(150);
  check('the unseen one is pulled to the front',
    /Kit/.test(await page.locator('.stories .s:not(.me)').first().innerText()),
    await page.locator('.stories .s:not(.me)').first().innerText());
  check('  and it is the lit one', await page.evaluate(() =>
    document.querySelectorAll('.stories .s:not(.me)')[0].querySelector('.rg').classList.contains('new')));

  // A day old is gone, and the policy says the same thing on the server.
  await put([{id: 9, u: 'u2', kind: 'text', body: 'yesterday', agoMins: 60 * 25}]);
  check('a story older than a day is not in the row', await page.locator('.stories .s').count() === 1);

  // Who watched yours is yours to know. The eye sits on your own story and on nobody else's.
  await put([{id: 20, u: 'u1', kind: 'text', body: 'mine'}, {id: 21, u: 'u2', kind: 'text', body: 'theirs'}]);
  await page.evaluate(() => { S.views = [{s: 20, u: 'u2', ts: Date.now() - 60000}, {s: 20, u: 'u3', ts: Date.now()}, {s: 21, u: 'u3', ts: Date.now()}]; render(); });
  await page.evaluate(() => openStory('u1'));
  await page.waitForTimeout(200);
  check('your own story counts who watched it', await page.locator('#story .eye').innerText() === '2',
    await page.locator('#story .eye').innerText());
  await page.locator('#story .eye').click();
  await page.waitForTimeout(150);
  const sheet = await page.locator('#story .seenby').innerText();
  check('  and tapping the count names them', /Seen by 2/.test(sheet) && /Kit/.test(sheet), sheet);
  check('    newest first', sheet.indexOf('Kit') < sheet.indexOf('Sam'), sheet);
  check('    without counting you', !/@ari/.test(sheet));
  await page.locator('#story .seenby .x').click();
  await page.waitForTimeout(150);
  check('    and it closes', await page.locator('#story .seenby').isHidden());
  await page.locator('#story .who .x').click();
  await page.evaluate(() => openStory('u2'));
  await page.waitForTimeout(200);
  check("somebody else's story has no such count", await page.locator('#story .eye').count() === 0);

  // Answering one: a heart, and as many emoji as you like, drifting up the side.
  check('  it can be liked instead', await page.locator('#story .answer .lk').count() === 1);
  check('    starting empty', !await page.locator('#story .answer .lk').evaluate(b => b.classList.contains('on')));
  await page.locator('#story .answer .lk').click();
  await page.waitForTimeout(250);
  check('    tapping it goes red at once', await page.locator('#story .answer .lk').evaluate(b => b.classList.contains('on')));
  check('      with the like really sent', (await page.evaluate(() => self.__slikes)).length === 1,
    JSON.stringify(await page.evaluate(() => self.__slikes)));
  check('      and the story is still open', await page.locator('#story').isVisible());
  await page.locator('#story .answer .lk').click();
  await page.waitForTimeout(250);
  check('    and again takes it back', !await page.locator('#story .answer .lk').evaluate(b => b.classList.contains('on'))
    && (await page.evaluate(() => self.__slikes)).length === 0);

  await page.locator('#story .answer .rx').click();
  await page.waitForTimeout(200);
  check('  and reacted to', await page.locator('#story .reactpick button').count() >= 5);
  await page.locator('#story .reactpick button').first().click();
  await page.waitForTimeout(300);
  check('    the reaction floats up the side of it', await page.locator('#story .reacts span').count() === 1);
  check('      and was really sent', (await page.evaluate(() => self.__sreacts)).length === 1);
  await page.locator('#story .who .x').click();
  await page.waitForTimeout(250);

  // Your own story says what it got, and offers no heart to press on yourself.
  await page.evaluate(() => { S.slikes = [{s: 20, u: 'u2'}, {s: 20, u: 'u3'}]; S.sreacts = [{s: 20, u: 'u2', e: '\ud83d\udd25'}]; openStory('u1'); });
  await page.waitForTimeout(300);
  check('your own story counts the hearts it got', /2/.test(await page.locator('#story .tally').innerText()));
  check('  shows what people left on it', await page.locator('#story .reacts span').count() === 1);
  check('  and offers nothing to press on yourself', await page.locator('#story .answer').count() === 0);

  // Who watched and who liked are the same sheet read two ways.
  await page.locator('#story .tally').click();
  await page.waitForTimeout(200);
  const liked = await page.locator('#story .seenby').innerText();
  check('  tapping the count says who liked it', /Liked by 2/.test(liked) && /Sam/.test(liked) && /Kit/.test(liked), liked);
  check('    marking what each of them left', await page.locator('#story .seenby .hrt').count() === 2
    && await page.locator('#story .seenby .em').count() === 1);
  // The sheet covers the buttons that opened it, so it carries both lists itself.
  await page.locator('#story .seenby .tabs button').first().click();
  await page.waitForTimeout(200);
  check('    and the other list is one tap away, inside the sheet',
    await page.locator('#story .seenby .tabs button.on').innerText().then(t => /Seen by/.test(t)));

  // A story of your own opens a menu, not a bin, and nothing in the app is an emoji you press.
  check('your own story has no bin on it', !/[\u{1F300}-\u{1FAFF}]/u.test(
    await page.locator('#story .who .bin').innerText() || 'x'));
  await page.locator('#story .who .bin').click();
  await page.waitForTimeout(300);
  const menu = await page.locator('#dlg .menu').innerText();
  check('  it offers more than deleting', /edit/i.test(menu) && /liked/i.test(menu) && /watched/i.test(menu), menu);
  check('    with deleting last', /delete/i.test((await page.locator('#dlg .menu button').last().innerText())));
  await page.locator('#dlg .menu button').first().click();
  await page.waitForTimeout(350);
  check('  editing reopens the editor on that story', await page.locator('#make').isVisible()
    && await page.evaluate(() => S.draft.editing) === 20);
  check('    saving rather than sharing', /save/i.test(await page.locator('#make .go').innerText()),
    await page.locator('#make .go').innerText());
  await page.evaluate(() => { S.draft.body = 'reworded'; });
  await page.locator('#make .go').click();
  await page.waitForTimeout(400);
  const edits = (await page.evaluate(() => self.__edits)).filter(e => e.table === 'stories');
  check('    and it goes back to the story it came from, not up as a new one',
    edits.length === 1 && edits[0].body === 'reworded'
    && await page.evaluate(() => S.stories.filter(x => x.body === 'reworded').length) === 0,
    JSON.stringify(edits));
});

// Making one. The words are typed onto the card itself and every control changes the
// thing rather than a preview of it; the two it writes for you arrive as drafts.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => newStory());
  await page.waitForTimeout(250);
  check('the editor opens on a blank card', await page.locator('#make').isVisible());
  const type = page.locator('#make .type');
  check('  with the words typed straight onto the card',
    await type.count() === 1 && await type.evaluate(el => el.isContentEditable));
  check('    inside it, not in a box somewhere else', await page.evaluate(() => {
    const a = document.querySelector('#make .type').getBoundingClientRect(), b = document.querySelector('#make .face').getBoundingClientRect();
    return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  }));

  await type.click();
  await page.keyboard.type('fifty done');
  await page.waitForTimeout(200);
  check('  what is typed is held as the story', await page.evaluate(() => S.draft.body) === 'fifty done',
    await page.evaluate(() => S.draft.body));

  const look = () => page.evaluate(() => {
    const w = document.querySelector('#make .type');
    return {bg: document.querySelector('#make .face').style.background, font: w.style.fontFamily, ink: w.style.color, cls: w.className, x: w.style.left, sh: w.style.textShadow};
  });
  const before = await look();
  // Every choice is laid out at once in a tray, the one in use marked; nothing to cycle.
  await page.locator('#make .bgbtn').click();
  await page.waitForTimeout(200);
  check('  the background button opens every background at once', await page.locator('#make .tray[data-tray=bg] .tile').count() >= 16
    && await page.locator('#make .tray .tile.on').count() === 1);
  await page.locator('#make .tray .tile').nth(3).click();
  await page.waitForTimeout(200);
  check('    and picking one changes the card', (await look()).bg !== before.bg && await page.locator('#make .tray[data-tray=bg]').count() === 1);
  const pill = await page.locator('#make .fontpill').innerText();
  await page.locator('#make .fontpill').click();
  await page.waitForTimeout(200);
  check('  the font pill opens every face at once', await page.locator('#make .tray[data-tray=font] .fonts button').count() >= 8
    && await page.locator('#make .tray .fonts button.on').count() === 1);
  check('    with size and alignment in the same tray', await page.locator('#make .tray .chip').count() === 6);
  await page.locator('#make .tray .fonts button').nth(6).click();
  await page.waitForTimeout(200);
  check('    and picking one changes the words', (await look()).font !== before.font
    && await page.locator('#make .fontpill').innerText() !== pill);
  await page.locator('#make .tray .chip[aria-label="Align left"]').click();
  await page.waitForTimeout(150);
  check('    alignment too', await page.evaluate(() => styleOf(S.draft).align) === 'left');
  await page.locator('#make .inkbtn').click();
  await page.waitForTimeout(200);
  check('  the colour sits next to the font, and opens every colour at once',
    await page.locator('#make .tray[data-tray=ink] .dot').count() >= 16);
  await page.locator('#make .tray .dot').nth(3).click();
  await page.waitForTimeout(200);
  check('    and picking one recolours the words', (await look()).ink !== before.ink);
  check('    and the card carries the same colour, so the decoration follows it',
    await page.evaluate(() => document.querySelector('#make .face').style.color !== ''));
  await page.locator('#make .tb[aria-label="Text effect"]').click();
  await page.waitForTimeout(200);
  check('  the words can wear an effect', await page.locator('#make .tray[data-tray=fx] .fxs button').count() === 6);
  await page.locator('#make .tray .fxs button').nth(5).click();
  await page.waitForTimeout(200);
  check('    a glow is a glow', /px/.test((await look()).sh) && await page.evaluate(() => styleOf(S.draft).box) === 5, (await look()).sh);
  await page.locator('#make .tray .fxs button').nth(4).click();
  await page.waitForTimeout(200);
  check('    and an outline is hollow', await page.evaluate(() => /text-stroke/.test(document.querySelector('#make .type').getAttribute('style'))));
  await page.locator('#make .tray .fxs button').nth(0).click();
  await page.waitForTimeout(150);

  // Dragged, and remembered where it was let go.
  const box = await type.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  check('  the words can be dragged down the card', await page.evaluate(() => styleOf(S.draft).y) > .55,
    String(await page.evaluate(() => styleOf(S.draft).y)));

  // As many stickers as you like; a tap takes one off again.
  await page.locator('#make .tb[aria-label=Sticker]').click();
  await page.waitForTimeout(150);
  check('  the sticker tray has plenty to choose from', await page.locator('#make .tray .stks button').count() >= 50);
  await page.locator('#make .tray .stks button').first().click();
  await page.waitForTimeout(200);
  check('  a sticker lands on the card', await page.locator('#make .face .stk').count() === 1
    && await page.locator('#make .tray').count() === 0);
  await page.locator('#make .tb[aria-label=Sticker]').click();
  await page.waitForTimeout(150);
  await page.locator('#make .tray .stks button').nth(3).click();
  await page.waitForTimeout(200);
  check('    and a second one joins it rather than replacing it', await page.locator('#make .face .stk').count() === 2
    && await page.evaluate(() => styleOf(S.draft).stks.length) === 2);
  await page.locator('#make .face .stk').first().click();
  await page.waitForTimeout(200);
  check('    tapping one takes it off', await page.locator('#make .face .stk').count() === 1);
  check('  a story from before, with its one sticker, still draws it',
    await page.evaluate(() => (storyFace({kind: 'text', body: 'x', style: {stk: '🔥', sx: .5, sy: .7}}).match(/class="stk"/g) || []).length === 1));

  await page.evaluate(() => closeDraft());
  await page.waitForTimeout(150);
  check('  and closing it throws the draft away', await page.evaluate(() => S.draft) === null);
});

// An emoji is something people leave on each other's things, never a control.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  await page.evaluate(() => newStory());
  await page.waitForTimeout(250);
  check('the sticker button is drawn, not an emoji',
    !emoji.test(await page.locator('#make .tb[aria-label=Sticker]').innerText())
    && await page.locator('#make .tb[aria-label=Sticker] svg').count() === 1,
    await page.locator('#make .tb[aria-label=Sticker]').innerText());
  check('  and what it opens is all emoji, which is the point of it',
    await page.evaluate(() => { draftTray('stk'); return true; }));
  await page.evaluate(() => closeDraft());
  await page.waitForTimeout(200);
  check('the emoji button on a comment box is drawn too',
    !emoji.test(await page.locator('.post .cin .emo').first().innerText())
    && await page.locator('.post .cin .emo svg').count() >= 1,
    await page.locator('.post .cin .emo').first().innerText());
});

// Finishing the whole challenge is worth saying out loud, and is rarer than finishing a day.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const chal = await page.evaluate(() => {
    const g = S.groups[0], w = S.wheels[0];
    const sp = {id: 91, wheel_id: w.id, user_id: 'u1', cycle: cycleOf(w), sat_out: false, days_required: 1,
      results: [{seq: 0, kind: 'challenge', label: 'Your challenge', value: 'Cold shower'}]};
    S.spins = [...S.spins.filter(x => x.user_id !== 'u1'), sp];
    S.totals = [...S.totals, {g: g.id, u: 'u1', d: today(), m: 'pushups', n: 50, sp: sp.id, ch: 'Cold shower'}];
    return {done: [...doneChallengeIds()], text: effChallenge(sp)};
  });
  check('a challenge is finished when its days are in', chal.done.includes(91) && chal.text === 'Cold shower',
    JSON.stringify(chal));
  await page.evaluate(() => suggestAfterChallenge(S.groups[0], S.spins.find(x => x.id === 91)));
  await page.waitForTimeout(300);
  check('  and offers a story that says which challenge', await page.locator('#make').isVisible()
    && /cold shower/i.test(await page.locator('#make .face .hero .word').innerText()),
    await page.locator('#make .face').innerText());
  check('    saying it is the challenge that is done, not the day',
    /challenge done/i.test(await page.locator('#make .face .hero .tag').innerText()));
  check('    it is a draft, not a post', await page.evaluate(() => S.stories.length) === 0);
  await page.evaluate(() => closeDraft());
});

// The one it writes for you. Built, never sent on its own.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => suggestAfterPost(S.groups[0], 50, 'pushups'));
  await page.waitForTimeout(250);
  check('finishing the day offers a story already written', await page.locator('#make').isVisible());
  check('  with the number drawn large', /^50$/.test((await page.locator('#make .face .hero .big').innerText()).trim())
    && /pushups/i.test(await page.locator('#make .face .hero .tag').innerText()));
  check('  and a stamp on it', await page.locator('#make .face .hero .stamp').count() === 1);
  check('  it is a draft, not a post', await page.evaluate(() => S.stories.length) === 0);
  check('  which can still be edited before it goes', await page.locator('#make .type').count() === 1);
  await page.evaluate(() => closeDraft());

  // A milestone offers one too, on a wider ladder than the confetti uses.
  await page.evaluate(() => suggest('streak', {n: 7, body: STORY_MILE_LINE(7)}));
  await page.waitForTimeout(250);
  check('a streak milestone offers one as well', await page.locator('#make').isVisible()
    && /^7$/.test((await page.locator('#make .face .hero .big').innerText()).trim())
    && /day streak/i.test(await page.locator('#make .face .hero .tag').innerText()));
});

// A tap handler that throws used to throw into nothing: the rejection catcher only sees
// promises, and a plain error event went nowhere. That is a tap that does nothing, with
// nothing to copy and send.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => {
    const b = document.createElement('button'); b.id = 'boom';
    b.setAttribute('onclick', "throw new Error('tap went wrong')");
    document.body.append(b);
  });
  await page.locator('#boom').click();
  await page.waitForTimeout(200);
  check('an error thrown by a tap shows on the bar', /tap went wrong/.test(await page.innerText('#err')),
    await page.innerText('#err'));
});

// ---- reactions
// More than a like: several different ones on the same post, from several people, sitting
// in the corner of it rather than in a list underneath.
await withPage(SIGNED_IN, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const reel = page.locator('.post .reel').first();
  check('nothing is shown on a post nobody has reacted to', await reel.locator('.reacts').count() === 0);

  await page.locator('.post .acts .react').first().click();
  await page.waitForTimeout(200);
  check('the react button offers a set to choose from', await page.locator('.post .reactpick button').count() >= 5);
  await page.locator('.post .reactpick button').first().click();
  await page.waitForTimeout(300);
  check('  picking one puts it on the post', await reel.locator('.reacts button').count() === 1,
    await reel.locator('.reacts').innerText().catch(() => '(none)'));
  check('    and the picker goes away', await page.locator('.post .reactpick').count() === 0);
  check('    with it really sent', (await page.evaluate(() => self.__reacts)).length === 1,
    JSON.stringify(await page.evaluate(() => self.__reacts)));
  check('    bare, with no ring or pill around it', await page.evaluate(() => {
    const b = document.querySelector('.reel .reacts button'), c = getComputedStyle(b);
    return c.backgroundColor === 'rgba(0, 0, 0, 0)' && c.borderStyle === 'none';
  }));
  check('    and moving, not parked', await page.evaluate(() => {
    const c = getComputedStyle(document.querySelector('.reel .reacts button'));
    return c.animationName === 'bob' && parseFloat(c.animationDuration) > 0;
  }));
  check('    answering to a tap because it is yours', await reel.locator('.reacts button.mine').count() === 1);
  check('  in the corner of the clip, and inside it', await page.evaluate(() => {
    const r = document.querySelector('.reel .reacts'), reel = document.querySelector('.reel');
    if (!r || !reel) return false;
    const a = r.getBoundingClientRect(), b = reel.getBoundingClientRect();
    return a.left < b.left + b.width / 2 && a.bottom <= b.bottom + 1 && a.top >= b.top - 1;
  }));

  // Two people with the same one is two of them floating, like two likes on a reel, and
  // only yours can be tapped.
  await page.evaluate(() => { const e = S.reacts[0].e; S.reacts.push({p: S.posts[0].id, u: 'u2', e}); render(); });
  await page.waitForTimeout(200);
  check('  the same one from two people floats twice', await reel.locator('.reacts button').count() === 2);
  check('    each on its own phase, so they do not move in step', await page.evaluate(() => {
    const [a, b] = document.querySelectorAll('.reel .reacts button');
    return getComputedStyle(a).animationDelay !== getComputedStyle(b).animationDelay;
  }));
  check('    and the other person\'s is not a button you can press',
    await reel.locator('.reacts button:not(.mine)').count() === 1
    && await page.evaluate(() => getComputedStyle(document.querySelector('.reel .reacts button:not(.mine)')).pointerEvents === 'none'));

  // A different one sits beside it.
  await page.locator('.post .acts .react').first().click();
  await page.waitForTimeout(150);
  await page.locator('.post .reactpick button').nth(1).click();
  await page.waitForTimeout(300);
  // Three floating now: the two 🔥 and this one. Each reaction is its own thing.
  check('  a different one floats alongside them', await reel.locator('.reacts button').count() === 3);

  // Tapping your own takes it back.
  // It is bobbing, and Playwright will not press a thing that is moving. A thumb will.
  await reel.locator('.reacts button.mine').first().click({ force: true });
  await page.waitForTimeout(300);
  check('  tapping your own takes it back', (await page.evaluate(() => self.__reacts)).length === 1,
    JSON.stringify(await page.evaluate(() => self.__reacts)));

  // Nothing around them. A clipped or filtered box over a playing video shows up on iOS as a
  // faint darker rectangle with an edge, and the bob carried the emoji into that edge.
  check('  nothing around them that could clip or tint them', await page.evaluate(() => {
    const r = document.querySelector('.reel .reacts'), c = getComputedStyle(r);
    const b = getComputedStyle(r.querySelector('button'));
    return c.overflow === 'visible' && c.backgroundColor === 'rgba(0, 0, 0, 0)' && c.backdropFilter === 'none'
      && b.filter === 'none';
  }));

  // A crowd of them is capped and stays inside the post, none cut off the top or the bottom.
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) S.reacts.push({p: S.posts[0].id, u: 'u' + (i + 3), e: '💪'}); render();
  });
  await page.waitForTimeout(200);
  const crowd = await page.evaluate(() => {
    const reel = document.querySelector('.reel').getBoundingClientRect();
    const bs = [...document.querySelectorAll('.reel .reacts button')].map(b => b.getBoundingClientRect());
    return {n: bs.length, out: bs.filter(r => r.top < reel.top || r.bottom > reel.bottom || r.left < reel.left).length};
  });
  check('  a crowd of them is capped', crowd.n === 10, JSON.stringify(crowd));
  check('    and every one sits inside the post, whole', crowd.out === 0, JSON.stringify(crowd));
});

// A notification is worth tapping only if it lands on the thing it is about.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => { location.hash = `#post-${S.posts[0].id}`; });
  await page.waitForTimeout(500);
  check('a link to a post scrolls to that post', await page.evaluate(() => {
    const el = document.querySelector(`[data-post="${S.posts[0].id}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < innerHeight && r.bottom > 0;
  }));
  check('  and tidies the address up behind itself', await page.evaluate(() => location.hash) === '');
  await page.evaluate(() => { location.hash = '#friends'; });
  await page.waitForTimeout(400);
  check('  a link to friends goes to friends', await page.evaluate(() => S.tab) === 'friends');
});

// ---- notifications nobody was ever offered
// They were opt-in behind a card at the foot of the Profile tab, which is opt-in by
// nobody: a whole group can go months without one and assume the app has none.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => { S.push = 'off'; render(); });
  await page.waitForTimeout(200);
  const txt = await page.innerText('#app');
  check('the feed offers notifications rather than hiding them in Profile',
    /Turn on notifications/i.test(txt), txt.slice(0, 400));
  check('  with a way to say no', await page.locator('#app button:has-text("Not now")').count() === 1);

  await page.locator('#app button:has-text("Not now")').click();
  await page.waitForTimeout(200);
  check('  which is remembered rather than asked again on the next render',
    !/Turn on notifications/i.test(await page.innerText('#app')));
  check('    and remembered past a reload', await page.evaluate(() => !!localStorage.getItem('quota.pushask')));
});

await withPage(SIGNED_IN, async page => {
  await settle(page);
  for (const state of ['on', 'denied', 'install', 'unsupported']) {
    await page.evaluate(s => { S.push = s; render(); }, state);
    check(`  nothing is asked when notifications are ${state}`,
      !/Turn on notifications/i.test(await page.innerText('#app')), state);
  }
});

// Turning them off should not mean going to find the phone's settings, and a switch that
// covers five different things has to say which five.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  // go('profile') asks the browser what the real state is and overwrites whatever was set,
  // so land on the tab first and say what to draw after.
  await page.evaluate(() => { S.tab = 'profile'; S.open = null; S.push = 'on'; render(); });
  await page.waitForTimeout(300);
  const card = page.locator('#app .card:has(.about)');
  check('Profile can turn notifications off without leaving the app',
    await card.locator('button:has-text("Turn off")').count() === 1);
  const txt = await card.innerText();
  check('  saying what it covers rather than just "on"',
    /friend request/i.test(txt) && /comment on your proof/i.test(txt) && /like on your proof/i.test(txt), txt);

  await page.evaluate(() => { S.push = 'off'; render(); });
  await page.waitForTimeout(200);
  const off = await page.locator('#app .card:has(.about)').innerText();
  check('  and still saying it when they are off, so you know what you are missing',
    /friend request/i.test(off) && /Turn on/i.test(off), off);

  await page.evaluate(() => { S.push = 'denied'; render(); });
  await page.waitForTimeout(200);
  const denied = await page.innerText('#app');
  check('  but pointing at the phone when the phone is what refused',
    /Settings/.test(denied) && !/Turn off/.test(denied));
});

// ---- the first frame of a clip
// preload="metadata" reads the header and stops, and an element that has never decoded a
// frame paints nothing: a black rectangle where the clip should be.
await withPage(SIGNED_IN, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const clip = await realClip(page);
  const shown = await page.evaluate(async u => {
    const v = document.querySelector('.reel video.proof');
    v.removeAttribute('src'); v.dataset.src = u;
    document.querySelectorAll('.reel').forEach(r => r.classList.remove('bust'));
    attachClip(v);
    await new Promise(r => setTimeout(r, 1500));
    return {t: v.currentTime, ready: v.readyState};
  }, clip);
  check('a clip shows a frame rather than a black box', shown.t > 0 && shown.ready >= 2, JSON.stringify(shown));
});

// ---- proof can be a picture
// Nothing new is stored for it: which one a post is, is read off the file, so every post
// that already exists is still a clip.
await withPage({ ...SIGNED_IN, photos: true }, async page => {
  await settle(page);
  const kinds = await page.evaluate(() => S.posts.slice(0, 2).map(p => `${p.path}:${isPhoto(p) ? 'photo' : 'clip'}`));
  check('a jpg is a picture and an mp4 is not', kinds.join(' ') === 'p.mp4:clip p.jpg:photo', kinds.join(' '));

  const reels = page.locator('.post .reel');
  check('  the picture is drawn as one, not put in a player',
    await reels.nth(1).locator('img').count() === 1 && await reels.nth(1).locator('video').count() === 0);
  check('    with no play button over it', await reels.nth(1).locator('.play').count() === 0);
  check('  and the clip is still a clip', await reels.nth(0).locator('video').count() === 1);
  check('  a picture waits to be near the screen like everything else',
    await reels.nth(1).locator('img').getAttribute('data-src') !== null);
});

// A picture that will not load says so in its own words.
await withPage({ ...SIGNED_IN, photos: true, noSign: true, resignFails: true }, async page => {
  await settle(page);
  await page.evaluate(() => {
    const im = document.querySelectorAll('.post .reel img')[0];
    clipBust(im, S.posts.find(p => isPhoto(p)).id, false);
  });
  await page.waitForTimeout(500);
  check('a picture that will not load is called a picture',
    /picture could not be loaded/.test(await page.locator('.reel.bust p').first().innerText()),
    await page.locator('.reel.bust p').first().innerText());
});

// The camera takes either, and says which it is about to take.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  check('the camera starts on video', await page.locator('#modevid').evaluate(b => b.classList.contains('on')));
  check('  with a microphone to cut', await page.locator('#cammic').isVisible());

  await page.locator('#modepic').click();
  await page.waitForTimeout(150);
  check('  and can be switched to photo', await page.locator('#modepic').evaluate(b => b.classList.contains('on')));
  check('    where there is no sound to cut', await page.locator('#cammic').isHidden());

  await page.locator('#camgo').click();
  await page.waitForTimeout(700);
  const shot = await page.evaluate(() => recorded && {size: recorded.size, type: recorded.type, name: recorded.name, cam: !!recorded.fromCamera});
  check('  the shutter takes a picture', shot && shot.type === 'image/jpeg' && shot.size > 1024, JSON.stringify(shot));
  check('    named so the feed can tell what it is', shot && /\.jpg$/.test(shot.name), JSON.stringify(shot));
  check('    and never re-encoded', shot && shot.cam === true, JSON.stringify(shot));
  check('  offered back as a picture, not in a player',
    await page.locator('#camrev').isVisible() && await page.locator('#camshot').isVisible()
    && await page.locator('#camplay').isHidden());
  check('    and the form says it has one', /Photo/.test(await page.locator('#vsize').innerText()),
    await page.locator('#vsize').innerText());
  check('  with the camera parked rather than handed back, so it is not asked for twice',
    await page.evaluate(() => $('#campre').srcObject === null && camLive()));
});

// A picture posts with nothing to compress and nothing to wait for.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  lastUpload = null;
  uploadReply = { status: 200, body: '{}', hold: null };
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  await page.locator('#modepic').click();
  await page.locator('#camgo').click();
  await page.waitForTimeout(700);
  await page.locator('#camrev button:has-text("Use this")').click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const size = await page.evaluate(() => recorded.size);
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(2500);
  check('a picture posts without a compressing step',
    !(await labels(page)).some(t => /Compressing/.test(t)), (await labels(page)).join(' -> '));
  check('  and what went up is the picture that was taken',
    lastUpload && lastUpload.length === size, `sent ${lastUpload && lastUpload.length} of ${size}`);
  const sent = await page.evaluate(() => self.__posts.at(-1));
  check('  stored under a name that says it is one', sent && /\.jpg$/.test(sent.video_path), JSON.stringify(sent));
});

// A file picked from the phone can be a picture too.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  check('choosing a file offers pictures as well as clips',
    /image/.test(await page.locator('#dlg input[name=video]').getAttribute('accept')),
    await page.locator('#dlg input[name=video]').getAttribute('accept'));
});

// ---- the days a group actually expects anything
// A group that only runs on certain days should not treat the other days as missed. The
// streak steps over them; it neither counts them nor breaks on them.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const r = await page.evaluate(() => {
    const g = S.groups[0], u = 'u1';
    const day = n => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA');
    const dow = n => new Date(`${day(n)}T00:00`).getDay();
    // Hit the quota today and four days back, and miss the three days in between.
    S.totals = [0, 4].map(n => ({g: g.id, u, d: day(n), m: 'pushups', n: 50}));
    S.posts = [];
    const everyday = streak(g, u);
    // Now say the group only expects those two days of the week.
    g.active_days = [dow(0), dow(4)];
    return {everyday, rest: streak(g, u), days: g.active_days,
      onToday: onDay(g, day(0)), onGap: onDay(g, day(1))};
  });
  check('missing days in between breaks a streak when every day counts', r.everyday === 1, JSON.stringify(r));
  check('  but not when those days were never expected', r.rest === 2, JSON.stringify(r));
  check('  and a day the group does not run on is known to be one', r.onToday && !r.onGap, JSON.stringify(r));
});

// The completion rate is out of the days there was something to do, not out of thirty.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const r = await page.evaluate(() => {
    const g = S.groups[0], u = 'u1';
    const day = n => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA');
    S.totals = [{g: g.id, u, d: day(1), m: 'pushups', n: 50}];
    const all = rate(g, u);
    g.active_days = [new Date(`${day(1)}T00:00`).getDay()];
    return {all, one: rate(g, u)};
  });
  check('a rate is out of every day when every day counts', r.all && r.all.of === 30, JSON.stringify(r));
  // One weekday comes round four or five times in thirty days, and only those were ever
  // a chance to hit the quota.
  check('  and out of the days that counted when only some do',
    r.one && r.one.of >= 4 && r.one.of <= 5 && r.one.pct > r.all.pct, JSON.stringify(r));
});

// And the group says so rather than showing everyone as behind.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  // Set after the load, not before: go() reloads, and the stub has no such column.
  await page.evaluate(() => { S.tab = 'groups'; S.open = null;
    S.groups[0].active_days = [(new Date().getDay() + 3) % 7];   // never today
    render();
  });
  await page.waitForTimeout(200);
  const txt = await page.innerText('#app');
  check('a group not running today says it is a rest day', /rest day/i.test(txt), txt.slice(0, 300));
});

// Picking the days is a row of taps, and leaving it alone means every day.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => groupDlg());
  await page.waitForTimeout(200);
  check('a new group does not ask about days unless you want it to',
    await page.locator('#gdays').isHidden() && await page.locator('#dlg input[name=somedays]').isChecked() === false);
  await page.locator('#dlg input[name=somedays]').check();
  await page.waitForTimeout(150);
  check('  asking brings up all seven', await page.locator('#gdays').isVisible()
    && await page.locator('#gdays input[name=day]').count() === 7);
  check('  with all of them on to begin with',
    await page.locator('#gdays input[name=day]:checked').count() === 7);
});

// ---- finding somebody to add
// Typing a username blind meant a letter out of place looked exactly like an account that
// was not there, which with more than a handful of people is most of the time.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => go('friends'));
  await page.waitForTimeout(200);
  check('the friends tab searches rather than asking you to spell it',
    await page.locator('#fq').count() === 1 && await page.locator('#fq').getAttribute('placeholder') !== null);

  await page.locator('#fq').fill('s');
  await page.waitForTimeout(500);
  check('  one letter is not a search', (await page.locator('#fsr').innerText()).trim() === '',
    await page.locator('#fsr').innerText());

  await page.locator('#fq').fill('sam');
  await page.waitForTimeout(700);
  const txt = await page.locator('#fsr').innerText();
  check('  a name people actually have brings them up', /Sam Gamgee/.test(txt) && /@samwise/.test(txt), txt);
  check('    by display name as well as username', /Sam\b/.test(txt) && /@sam\b/.test(txt), txt);
  check('    with both names shown, not one', /@/.test(txt) && /Sam/.test(txt), txt);

  await page.locator('#fq').fill('zzzznobody');
  await page.waitForTimeout(700);
  check('  and a name nobody has says so instead of letting you invite it',
    /Nobody goes by that/.test(await page.locator('#fsr').innerText())
    && await page.locator('#fsr button').count() === 0,
    await page.locator('#fsr').innerText());

  await page.locator('#fq').fill('rosie');
  await page.waitForTimeout(700);
  check('  somebody new can be added', await page.locator('#fsr button:has-text("Add")').count() === 1);
  await page.locator('#fsr button:has-text("Add")').click();
  await page.waitForTimeout(600);
  const sent = await page.evaluate(() => self.__invited);
  check('    and the request goes to them by id, not by a typed name', sent && sent.to_user === 'u4', JSON.stringify(sent));
});

// The list says where you already stand with somebody, so nothing is asked twice.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => go('friends'));
  await page.locator('#fq').fill('ari');
  await page.waitForTimeout(700);
  check('you cannot add yourself', /You/.test(await page.locator('#fsr').innerText())
    && await page.locator('#fsr button').count() === 0, await page.locator('#fsr').innerText());
});

// A post says who by both names, the way every app that has usernames does.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const top = await page.locator('.post .head').first().innerText();
  check('a post carries the name and the username', /Ari/.test(top) && /@ari/.test(top), top);
});

// ---- an app, not a page in a browser
// Tapping a field used to zoom the whole screen in and never zoom back out. It was never
// a gesture: iOS zooms into any focused field under 16px, and the comment box was 14.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const small = await page.evaluate(() => {
    document.querySelectorAll('form').forEach(f => {});
    return [...document.querySelectorAll('input,select,textarea')]
      .filter(el => el.type !== 'hidden' && parseFloat(getComputedStyle(el).fontSize) < 16)
      .map(el => `${el.tagName.toLowerCase()}[name=${el.name || '?'}] ${getComputedStyle(el).fontSize}`);
  });
  check('no field is small enough to make iOS zoom into it', small.length === 0, small.join(', '));

  // And the ones that only exist inside the post sheet.
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  const dlgSmall = await page.evaluate(() => [...document.querySelectorAll('#dlg input,#dlg select,#dlg textarea')]
    .filter(el => el.type !== 'hidden' && parseFloat(getComputedStyle(el).fontSize) < 16)
    .map(el => `${el.name || el.type} ${getComputedStyle(el).fontSize}`));
  check('  including the ones inside the post sheet', dlgSmall.length === 0, dlgSmall.join(', '));
});

await withPage(SIGNED_IN, async page => {
  await settle(page);
  const vp = await page.getAttribute('meta[name=viewport]', 'content');
  check('the page asks not to be scaled', /user-scalable=no/.test(vp) && /maximum-scale=1/.test(vp), vp);
  check('  and double tap does not zoom either',
    await page.evaluate(() => getComputedStyle(document.body).touchAction) === 'manipulation');
  check('  with no rubber band to pull on',
    await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY) === 'none');
  check('  and no long-press callout', await page.evaluate(() => {
    const c = getComputedStyle(document.body);
    return (c.webkitUserSelect || c.userSelect) === 'none';
  }));
  check('  but a field can still be selected in', await page.evaluate(() => {
    const i = document.createElement('input'); document.body.append(i);
    const c = getComputedStyle(i), ok = (c.webkitUserSelect || c.userSelect) === 'text';
    i.remove(); return ok;
  }));
  // Safari's own pinch arrives as a gesture event, and a second finger as a touchmove.
  check('  a pinch is turned down', await page.evaluate(() => {
    const e = new Event('gesturestart', {cancelable: true, bubbles: true});
    dispatchEvent(e);
    return e.defaultPrevented;
  }));
  check('  and so is a two-finger drag', await page.evaluate(() => {
    const t = {clientX: 0, clientY: 0};
    const ev = new Event('touchmove', {cancelable: true, bubbles: true});
    Object.defineProperty(ev, 'touches', {value: [t, t]});
    dispatchEvent(ev);
    return ev.defaultPrevented;
  }));
  check('  while one finger scrolls as normal', await page.evaluate(() => {
    const ev = new Event('touchmove', {cancelable: true, bubbles: true});
    Object.defineProperty(ev, 'touches', {value: [{}]});
    dispatchEvent(ev);
    return !ev.defaultPrevented;
  }));
});

// The tab bar is fixed to the layout viewport, which during a URL-bar collapse or with a
// keyboard up is not what is on screen. That difference is the bar wandering off.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const set = (height, offsetTop) => page.evaluate(([h, o]) => {
    Object.defineProperty(self, 'visualViewport', {configurable: true, value: {height: h, offsetTop: o, addEventListener() {}}});
    fitBar();
    const root = document.documentElement;
    return {vvb: root.style.getPropertyValue('--vvb'), keys: root.classList.contains('keys'), inner: innerHeight};
  }, [height, offsetTop]);

  const full = await page.evaluate(() => innerHeight);
  let r = await set(full, 0);
  check('with nothing in the way the bar sits where it always did', r.vvb === '0px' && !r.keys, JSON.stringify(r));

  const barBottom = () => page.evaluate(() => parseFloat(getComputedStyle($('#bar')).bottom));
  const at0 = await barBottom();
  r = await set(full - 60, 0);             // a collapsing URL bar: a sliver
  check('  a shrinking toolbar moves it by exactly that much', r.vvb === '60px' && !r.keys, JSON.stringify(r));
  const at60 = await barBottom();
  check('    and the bar is what moves, not just the number',
    Math.round(at60 - at0) === 60, `${at0} -> ${at60}`);

  r = await set(full - Math.round(full * 0.45), 0);   // a keyboard: a large bite
  check('  and a keyboard puts it away rather than parking it on top', r.keys, JSON.stringify(r));
  check('    which is what actually hides it',
    await page.evaluate(() => getComputedStyle($('#bar')).display) === 'none');

  r = await set(full, 0);
  check('  and it comes back when the keyboard goes', !r.keys && r.vvb === '0px', JSON.stringify(r));
  check('    visible again', await page.evaluate(() => getComputedStyle($('#bar')).display) !== 'none');

  // Halfway through the keyboard sliding in, the gap is a plausible toolbar. Following it
  // there is the bar riding up the screen before it disappears.
  r = await set(full - 140, 0);
  check('  a gap caught mid-animation never lifts it', r.vvb === '0px' && r.keys, JSON.stringify(r));
});

// The keyboard is known the moment a field is tapped, which is before the viewport has
// moved at all. That is what stops the bar travelling on the way out.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const shown = () => page.evaluate(() => getComputedStyle($('#bar')).display !== 'none');
  check('the bar is there to begin with', await shown());

  // Comments moved into a sheet of their own, so the search box is the plain text field
  // still sitting on a page behind the bar.
  await page.evaluate(() => go('friends'));
  await page.waitForTimeout(200);
  await page.locator('#fq').focus();
  await page.waitForTimeout(150);
  check('  tapping a text field puts it away at once', !await shown());
  check('    with no viewport change needed', await page.evaluate(() => innerHeight === visualViewport.height));
  check('    and without lifting it first',
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--vvb')) === '0px');

  await page.locator('#fq').blur();
  await page.waitForTimeout(200);
  check('  and gives it back when you are done', await shown());

  // A range or a button is not a keyboard.
  await page.evaluate(() => {
    const r = document.createElement('input'); r.type = 'range'; r.id = 'probe';
    document.body.append(r); r.focus();
  });
  await page.waitForTimeout(150);
  check('  a control that summons no keyboard leaves it alone', await shown());
  await page.evaluate(() => $('#probe').remove());
});

// The library can end a session without the app asking. The screen has to follow.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  check('starts signed in', await page.isVisible('#bar'));
  await page.evaluate(() => self.__authCb('SIGNED_OUT', null));
  await page.waitForTimeout(200);
  check('  a sign-out from the library returns to the welcome screen',
    await page.isHidden('#bar') && (await page.innerHTML('#app')).includes('auth'));
});

// The library failing to arrive is what a blank page used to look like from the outside.
await withPage(null, async page => {
  await page.route(LIB, r => r.abort());
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  check('a missing library says so instead of showing nothing',
    (await page.innerHTML('#app')).includes('could not start'));
});

// And the real vendored library has to actually work, with Supabase unreachable.
await withPage(null, async page => {
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**supabase.co**', r => r.abort());
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const html = await page.innerHTML('#app');
  check('the vendored library boots the page', !html.includes('could not start') && html.trim().length > 50);
  check('  with no uncaught errors', errs.length === 0, errs.join(' | '));
});

// The page's own self-check still passes.
await withPage(null, async page => {
  const logs = [];
  page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
  await page.route('**supabase.co**', r => r.abort());
  await page.goto(`${base}/#test`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('the #test self-check passes', logs.some(l => l.includes('self-check ok')) && !logs.some(l => /assert/i.test(l)),
    logs.join(' | '));
});

await browser.close();
server.close();
if (failed) { console.log(`\nFAIL: ${failed} check(s)`); process.exit(1); }
console.log('\nPASS: the app always shows something');

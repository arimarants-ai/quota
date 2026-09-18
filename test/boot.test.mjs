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
  check('  with no error banner left behind', await page.isHidden('#err'),
    await page.isHidden('#err') ? '' : await page.locator('#err').innerText());
  check('  and no modal', alerts.length === 0, alerts.join(' | '));
});

// Anything that is not an auth problem: say so, offer a way out, keep the app on screen.
await withPage({ ...SIGNED_IN, queryError: 'network is down' }, async (page, alerts) => {
  await settle(page);
  check('a failed load explains itself in the banner', (await page.innerText('#err')).includes('network is down'));
  check('  with a retry', await page.isVisible('#err button'));
  check('  and no modal', alerts.length === 0, alerts.join(' | '));
  // There was no way to put this bar away at all. A load that keeps failing shows it
  // again on every attempt, so "it never goes away" was the literal truth.
  check('  and a way to put it away', await page.isVisible('#err .dis'));
  await page.locator('#err .dis').click();
  await page.waitForTimeout(150);
  check('    which puts it away', await page.isHidden('#err'));
});

// The bar carries two different things. A load that failed has a Retry on it and the app
// is showing stale data until that is pressed, so it stays. A report of something that has
// already happened has nothing to press, and one that repeats used to mean a bar parked
// over a working app for the rest of the session.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => { self.__softMs = SOFT_MS; showErr('Something went wrong: boom', 'stack', true); });
  await page.waitForTimeout(150);
  check('a fault with nothing to retry still says so', await page.isVisible('#err')
    && /boom/.test(await page.innerText('#err')));
  check('  but offers no Retry, because there is nothing to retry',
    await page.isHidden('#err .rty'));
  check('    and goes on its own rather than staying for the session',
    await page.evaluate(() => self.__softMs) <= 10000 && await page.evaluate(() => self.__softMs) > 0,
    String(await page.evaluate(() => self.__softMs)));
  await page.evaluate(() => hideErr());

  // A clip swapped out while it was starting, and a browser that will not start one
  // unprompted, both reject. Neither is a fault anybody can act on.
  const quiet = await page.evaluate(() => {
    const ab = new Error('The play() request was interrupted'); ab.name = 'AbortError';
    const na = new Error('play() failed'); na.name = 'NotAllowedError';
    return [noise(ab), noise(na), noise(undefined), noise(new Error('a real one'))];
  });
  check('  the noise a player makes is not put on the bar',
    quiet[0] && quiet[1] && quiet[2] && !quiet[3], JSON.stringify(quiet));
  check('    and the bar is still hidden after all that', await page.isHidden('#err'));
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
  // Released rather than parked, and this is a change. Parking keeps the next open instant
  // and is still what a photo does — but a stream that has just been recorded on cannot be
  // recorded on again: Safari will not start a second MediaRecorder on one, and what comes
  // back is nothing at all. So a take ends with the camera let go and the next one asks
  // afresh, which costs a moment and is the difference between recording and not.
  check('  with the preview let go of while you watch', await page.evaluate(() => $('#campre').srcObject === null));
  check('    and the camera released rather than parked, so the next take gets a fresh one',
    await page.evaluate(() => camStream === null));
  check('    with no finished recorder left holding anything',
    await page.evaluate(() => camRec === null));
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
  // What is handed back is the whole recording and not the end of it. MediaRecorder was
  // asked for a chunk a second, and on Safari writing MP4 that put the header in the first
  // blob and fragments in the rest — what they reassembled into was a file holding the last
  // moment of a long take. Measured off the player rather than the label, because the label
  // is written from the same duration and would agree with a wrong one.
  const ran = await page.evaluate(() => new Promise(res => {
    const v = document.querySelector('#camplay');
    if (v.duration && isFinite(v.duration)) return res(v.duration);
    v.addEventListener('loadedmetadata', () => res(v.duration), { once: true });
    setTimeout(() => res(-1), 5000);
  }));
  check('  and it is the whole recording, not the end of it',
    ran > 1.2, `${ran}s back from about 2s of recording`);
  await page.locator('#camrev button:has-text("Retake")').click({ timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 }).catch(() => {});
  check('  turning it down throws it away', await page.evaluate(() => recorded === null));
  check('  and brings the camera back', await page.locator('#camrev').isHidden()
    && await page.evaluate(() => !!(camStream && camStream.getVideoTracks().length)));
  check('  leaving nothing behind on the form', (await page.locator('#vsize').innerText()).trim() === '');

  // Escape closes a <dialog> on its own and reached none of the tidying up, so a take that
  // was looked at and then escaped out of stayed on `recorded` — and the post sheet went on
  // carrying a clip that had been walked away from, through closing and reopening the
  // camera, because opening it does not clear one either.
  await page.locator('#camgo').click();
  await page.waitForTimeout(1500);
  await page.locator('#camgo').click();
  await page.waitForFunction(() => !$('#camrev').hidden, null, { timeout: 10000 }).catch(() => {});
  check('a take is held while it is being looked at', await page.evaluate(() => recorded !== null));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  check('  escaping out of the camera puts the take down',
    await page.evaluate(() => recorded === null), String(await page.evaluate(() => !!recorded)));
  check('    and leaves nothing on the form', (await page.locator('#vsize').innerText()).trim() === '');
  check('    with the review put away rather than left up',
    await page.locator('#camrev').isHidden() && await page.locator('#cam').evaluate(d => !d.open));
});

// Recording, retaking, and recording again. The second take is where it went wrong: the
// stream was parked and handed straight back, so the next MediaRecorder was built on one a
// previous recorder had already used. Safari answers that with a shutter that does nothing,
// a clock that never starts, a stop that does not stop, and then an empty recording — or
// the last second of a long one handed back as the whole take.
await withPage(NO_WHEEL, async (page, alerts) => {
  await settle(page);
  await page.evaluate(() => openCam('post'));
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 15000 });
  await page.locator('#camgo').click();
  await page.waitForTimeout(2000);
  await page.locator('#camgo').click();
  await page.waitForFunction(() => !$('#camrev').hidden, null, { timeout: 15000 });
  check('a first take records', await page.evaluate(() => recorded !== null));
  check('  and the camera is let go rather than parked, so the next take gets a fresh one',
    await page.evaluate(() => camStream === null));
  check('    with no finished recorder left holding it', await page.evaluate(() => camRec === null));

  await page.locator('#camrev button:has-text("Retake")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 15000 });
  check('  retaking brings a live camera back', await page.evaluate(() => camLive()));

  // The press that used to do nothing at all.
  await page.locator('#camgo').click();
  await page.waitForTimeout(500);
  check('  and the very next press really starts recording',
    await page.evaluate(() => !!camRec && camRec.state === 'recording'),
    String(await page.evaluate(() => camRec && camRec.state)));
  await page.waitForTimeout(2200);
  check('    with the clock running rather than sitting at nothing',
    /0:0[1-9]/.test(await page.locator('#camtime').innerText()),
    JSON.stringify(await page.locator('#camtime').innerText()));

  await page.locator('#camgo').click();
  await page.waitForFunction(() => !$('#camrev').hidden, null, { timeout: 15000 });
  check('  and stopping really stops it', await page.evaluate(() => camRec === null));
  check('    with nothing saying the recording came out empty',
    !alerts.some(a => /came out empty/i.test(a)), alerts.join(' | '));
  const again = await page.evaluate(() => new Promise(res => {
    const v = document.querySelector('#camplay');
    if (v.duration && isFinite(v.duration)) return res(v.duration);
    v.addEventListener('loadedmetadata', () => res(v.duration), { once: true });
    setTimeout(() => res(-1), 5000);
  }));
  check('  and the second take is the whole thing, not its last second',
    again > 1.5, `${again}s back from about 2.5s of recording`);
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
  check('  and the build is at the foot of settings', await page.evaluate(() => {
    S.me = S.me || {username: 'ari'}; go('profile'); openSettings();
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
  // Near enough was the only rule, and it is not enough on its own: a phone keeps a handful
  // of videos decoded at once, and past that they come up black, freeze with the sound
  // still running, and in the end the page is killed for memory. 150% of a screen either
  // way covers a lot of a grid three tiles across.
  check('  and never more than a handful at once, however many are near',
    await loaded() <= await page.evaluate(() => MAX_CLIPS),
    `${await loaded()} loaded, budget ${await page.evaluate(() => MAX_CLIPS)}`);
});

// The same budget over a profile grid, which is where it actually bites: sixty tiles three
// across, all of them small enough that a great many sit inside the margin at once.
await withPage({ ...NO_WHEEL, manyPosts: 24 }, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  // Every post put on the profile, so the grid is as full as it can be.
  await page.evaluate(() => {
    S.pro[S.me.id] = {loading: false, posts: S.posts.map(p => ({...p, userId: S.me.id, onProfile: true}))};
    go('profile');
  });
  await page.waitForTimeout(900);
  const tiles = await page.locator('#app .tile .proof').count();
  check('a full profile grid draws every tile', tiles >= 20, `${tiles} tiles`);
  const live = () => page.locator('#app .tile video[src]').count();
  check('  but only a handful hold a clip at once',
    await live() <= await page.evaluate(() => MAX_CLIPS),
    `${await live()} of ${tiles} loaded`);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(800);
  check('    and still only a handful after scrolling the length of it',
    await live() <= await page.evaluate(() => MAX_CLIPS),
    `${await live()} of ${tiles} loaded`);
});

// Proof is a clip or a picture, and letting go of one is not the same as letting go of the
// other. This is the fault that was actually reported: a bar across the bottom of a working
// app saying "v.load is not a function", back on every scroll, with no way to clear it.
await withPage({ ...SIGNED_IN, manyPosts: 12, photos: true }, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const shot = page.locator('.reel img.proof').first();
  check('a picture in the feed is an <img>, not a <video>', await shot.count() === 1);
  // A real picture, or it fails to decode, the reel shows its failure, and the observer
  // skips it on purpose — "a hidden element reports as off screen too" — so nothing would
  // ever be let go of and this would pass without touching the thing it is about.
  await page.evaluate(() => {
    const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    document.querySelectorAll('.reel img.proof').forEach(i => {
      i.removeAttribute('src'); i.dataset.src = GIF; delete i.dataset.retried;
    });
    document.querySelectorAll('.reel').forEach(r => r.classList.remove('bust'));
    watchClips();
  });
  await page.waitForTimeout(500);
  check('  and it really is drawn, or nothing below tests anything',
    await page.evaluate(() => document.querySelector('.reel img.proof').getBoundingClientRect().width > 0));
  check('  and is given its source when it is on screen',
    await shot.getAttribute('src') !== null);

  // Scrolling it well off the screen is what used to throw: <img> has no load().
  await page.locator('.reel').last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  check('  scrolling past it lets go of it without throwing',
    errs.length === 0, errs.join(' | '));
  check('    and puts nothing on the bar', await page.isHidden('#err'),
    await page.isHidden('#err') ? '' : await page.locator('#err span').innerText());
  check('    having really let go of it', await shot.getAttribute('src') === null);

  // And back again, because a picture that is released and never given back is a hole.
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(700);
  check('  and gives it back when you scroll to it again',
    await shot.getAttribute('src') !== null);
  check('    still with nothing on the bar', await page.isHidden('#err'));
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
  // The box is emptied before the redraw, not after. render() carries a half-typed reply
  // across a rebuild so a like elsewhere on the page cannot eat it, and a box still
  // holding what it had just sent looked exactly like one being carried across — so it
  // was put straight back, and the comment read as having been typed twice.
  check('      and the box it was typed into is empty again', await box.inputValue() === '',
    JSON.stringify(await box.inputValue()));
  await page.evaluate(() => { const g = self.__go; self.__stall = null; g(); });
  await page.waitForTimeout(900);
  check('  a comment written there stays there', /nice one/.test(await list()), await list());
  check('    and the box is still empty once it has really saved', await box.inputValue() === '',
    JSON.stringify(await box.inputValue()));
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

// The bar is the whole gradient, and how far along you are is how much of it shows. A
// fill that carried the gradient itself would squeeze dark-to-light into every width, so
// a quarter done would look the same as finished.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const bar = page.locator('.mini i').first();
  check('the quota bar is a gradient, not a colour', await bar.evaluate(el =>
    /linear-gradient/.test(getComputedStyle(el).backgroundImage)), await bar.evaluate(el => getComputedStyle(el).backgroundImage));
  check('  running dark to light', await bar.evaluate(el => {
    const g = getComputedStyle(el).backgroundImage;
    return g.indexOf('11, 90, 52') < g.indexOf('72, 236, 139');
  }));
  check('  and the gradient is the bar, so the unearned part is covered rather than coloured',
    await bar.evaluate(el => {
      const c = getComputedStyle(el, '::after');
      return c.marginLeft !== '0px' || c.width === '0px' || /calc/.test(c.width);
    }));
  // A quarter done shows a quarter of the gradient: the cover starts a quarter along. The
  // bar animates to a new width, so this reads it once it has arrived rather than on the
  // way, which is the old value.
  const at = async pct => {
    await page.evaluate(p => document.querySelector('.mini i').style.setProperty('--w', p + '%'), pct);
    await page.waitForTimeout(550);
    return page.evaluate(() => {
      const el = document.querySelector('.mini i');
      return Math.round(parseFloat(getComputedStyle(el, '::after').marginLeft) / el.getBoundingClientRect().width * 100);
    });
  };
  const q25 = await at(25), q100 = await at(100), q0 = await at(0);
  check('  a quarter done covers from a quarter along', Math.abs(q25 - 25) <= 1, String(q25));
  check('    and finished covers nothing', Math.abs(q100 - 100) <= 1, String(q100));
  check('    while nothing done covers all of it', q0 === 0, String(q0));
});

// A reply can be liked, and whoever wrote it is the one who hears about it.
await withPage(SIGNED_IN, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.evaluate(() => {
    S.comments = [{id: 801, postId: S.posts[0].id, userId: 'u2', body: 'strong work', ts: Date.now() - 6e5}];
    S.clikes = []; render();
  });
  await page.waitForTimeout(250);
  const heart = page.locator('.clist .c .clk').first();
  check('a reply carries a heart', await heart.count() === 1);
  check('  empty until somebody presses it', !await heart.evaluate(b => b.classList.contains('on'))
    && !/\d/.test(await heart.innerText()));
  await heart.click();
  await page.waitForTimeout(300);
  check('  tapping it counts at once', await heart.evaluate(b => b.classList.contains('on'))
    && /1/.test(await heart.innerText()), await heart.innerText());
  check('    with the like really sent', (await page.evaluate(() => self.__clikes)).length === 1,
    JSON.stringify(await page.evaluate(() => self.__clikes)));
  await heart.click();
  await page.waitForTimeout(300);
  check('  and again takes it back', !await heart.evaluate(b => b.classList.contains('on'))
    && (await page.evaluate(() => self.__clikes)).length === 0);
  check('  a reply still being written offers no heart', await page.evaluate(() => {
    S.comments = [{id: -1, postId: S.posts[0].id, userId: 'u1', body: 'pending', pending: true}]; render();
    return document.querySelectorAll('.clist .c .clk').length === 0;
  }));
});

// A notification lands on the thing it is about, not near it.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const pid = await page.evaluate(() => S.posts[0].id);
  await page.evaluate(p => {
    S.comments = Array.from({length: 8}, (_, i) => ({id: 810 + i, postId: p, userId: 'u2', body: 'reply ' + i, ts: Date.now() - i * 6e4}));
    render();
  }, pid);
  await page.waitForTimeout(250);
  await page.evaluate(() => { location.hash = '#comment-815'; });
  await page.waitForTimeout(600);
  check('a notification about a reply opens the post it is under',
    await page.evaluate(() => S.tab) === 'feed' && await page.locator(`[data-post="${pid}"]`).count() === 1);
  check('  and marks which reply it was', await page.locator('.clist .c[data-cmt="815"]').count() === 1);
  check('    scrolled to, rather than left somewhere up the page', await page.evaluate(() => {
    const el = document.querySelector('[data-cmt="815"]');
    const b = el.getBoundingClientRect();
    return b.top > -50 && b.top < innerHeight;
  }));
  check('    with the hash cleaned up behind it', await page.evaluate(() => location.hash) === '');
  // A comment that is not there to open must not leave the app somewhere odd.
  await page.evaluate(() => { location.hash = '#comment-99999'; });
  await page.waitForTimeout(400);
  check('  a reply that is not there leaves the screen alone', await page.locator('.post').count() > 0);

  // And a post notification still lands on the post.
  await page.evaluate(p => { location.hash = '#post-' + p; }, pid);
  await page.waitForTimeout(500);
  check('a notification about a post still lands on the post',
    await page.evaluate(p => { const b = document.querySelector(`[data-post="${p}"]`).getBoundingClientRect();
      return b.top > -60 && b.top < 200; }, pid));
});

// The profile is a page about somebody, and it is the same page whoever is looking.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => { go('profile'); });
  await page.waitForTimeout(500);
  check('your own profile reads as a profile, not a settings screen',
    await page.locator('.pf .nm b').count() === 1
    && /ari/i.test(await page.locator('.pf .nm span').innerText())
    && await page.locator('.pf .stats div').count() === 3);
  check('  with a way into settings rather than the settings themselves',
    await page.locator('.hdr .gear').count() === 1
    && !/Recovery codes/i.test(await page.innerText('#app')));

  // Your own profile is where you go to find your own work, so everything you posted is
  // on it whether or not anybody else can see it.
  check('  your own grid holds a post nobody else can see',
    await page.locator('.pgrid .tile').count() === 1,
    await page.locator('.pf').innerText());
  check('    unmarked, because it is not on show',
    await page.locator('.pgrid .tile .seen').count() === 0);
  check('    and none counted as on show', /^0$/.test(
    (await page.locator('.pf .stats div').last().innerText()).split('\n')[0].trim()),
    await page.locator('.pf .stats div').last().innerText());
  check('    and it says which of the two kinds a tile is',
    /only you can see/i.test(await page.locator('.pgrid .tile').first().getAttribute('aria-label')),
    await page.locator('.pgrid .tile').first().getAttribute('aria-label'));

  // A bio, once there is one.
  await page.evaluate(() => { S.profiles.u1.bio = 'Mornings before work.'; render(); });
  await page.waitForTimeout(200);
  check('  a bio shows where one is written', /Mornings before work/.test(await page.locator('.pf .bio').innerText()));

  // Settings is its own screen, and everything that was on the old profile is on it.
  await page.locator('.hdr .gear').click();
  await page.waitForTimeout(400);
  const set = await page.innerText('#app');
  check('the gear opens settings', await page.evaluate(() => S.settings) === true
    && await page.locator('.list').count() === 4);
  check('  carrying everything the profile used to', /bio/i.test(set) && /Groups on your profile/i.test(set)
    && /Dark mode/i.test(set) && /Notifications/i.test(set) && /Change password/i.test(set)
    && /Recovery codes/i.test(set) && /Log out/i.test(set), set);
  // Whatever somebody agreed to at signup has to stay readable afterwards, or agreeing to
  // it was a box they ticked once and can never look at again.
  check('  and the documents, which have to stay reachable', /Privacy policy/i.test(set)
    && /Cookies and storage/i.test(set) && /Community guidelines/i.test(set), set);
  await page.locator('.li:has-text("Privacy policy")').click();
  await page.waitForTimeout(300);
  check('  one of which opens on its own screen', await page.evaluate(() => S.legal) === 'privacy'
    && await page.locator('.legal').count() === 1
    && await page.locator('#bar[hidden]').count() === 1);
  await page.locator('#app .back').click();
  await page.waitForTimeout(400);
  check('    and comes back to settings, not to the feed',
    await page.evaluate(() => S.legal) === null && await page.evaluate(() => S.settings) === true);
  // Notifications only get a switch where the browser can do them at all, which a headless
  // one cannot; dark mode always can, and the notifications row has its own test.
  check('  with the ones that are a yes or a no as switches',
    await page.locator('.li:has-text("Dark mode") .sw').count() === 1);
  await page.locator('.li:has-text("Dark mode")').click();
  await page.waitForTimeout(300);
  check('  and dark mode switching in place rather than opening anything',
    await page.evaluate(() => isDark()) && await page.evaluate(() => S.settings) === true
    && await page.locator('#dlg[open]').count() === 0);
  await page.evaluate(() => setTheme('light'));
  await page.locator('#app .back').click();
  await page.waitForTimeout(400);
  check('  the way back is the profile', await page.evaluate(() => S.settings) === false
    && await page.locator('.pf').count() === 1);
});

// Opening somebody from the feed, without leaving the feed.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  check('a name on a post is the way to their profile',
    await page.locator('.post .head .who').first().evaluate(b => b.tagName === 'BUTTON'));
  await page.locator('.post .head .who').nth(1).click();
  await page.waitForTimeout(500);
  check('  tapping it opens them', await page.locator('.pf').count() === 1
    && await page.evaluate(() => S.who) !== null);
  check('    still in the feed, not the profile tab', await page.evaluate(() => S.tab) === 'feed');
  check('    with no settings offered on somebody else', await page.locator('#app .hdr .gear').count() === 0);
  // A button shaped like a button, with an arrow on it. The muted text link that used to
  // be here was missed so reliably that people thought there was no way back at all.
  check('    and a way back', await page.locator('#app .backx').count() === 1);
  await page.locator('#app .backx').click();
  await page.waitForTimeout(400);
  check('  which returns to the feed', await page.evaluate(() => S.who) === null
    && await page.locator('.post').count() > 0);

  // And returns to where you were in it. A profile opened from twenty posts down used to
  // come back to the top, which is the whole feed to scroll through again to find your
  // place. The page is made tall enough to have a place to lose.
  await page.evaluate(() => { document.documentElement.style.minHeight = '3000px'; });
  await page.evaluate(() => scrollTo(0, 800));
  await page.waitForTimeout(150);
  await page.locator('.post .head .who').nth(1).click();
  await page.waitForTimeout(400);
  check('  a profile opened part way down remembers where that was',
    await page.evaluate(() => backY[backY.length - 1]) === 800,
    String(await page.evaluate(() => backY.slice())));
  check('    and opens at the top of itself, not part way down',
    await page.evaluate(() => scrollY) === 0);
  await page.locator('#app .backx').click();
  await page.waitForTimeout(400);
  check('    and coming back puts you there', await page.evaluate(() => scrollY) === 800,
    String(await page.evaluate(() => scrollY)));
  check('      with nothing left on the stack to go back to',
    await page.evaluate(() => backY.length) === 0);

  // Dragged back rather than tapped back. The screen follows the finger and the feed is
  // already behind it, which is the whole point: you can see where you are going before
  // you have committed to going there.
  await page.evaluate(() => scrollTo(0, 800));
  await page.locator('.post .head .who').nth(1).click();
  await page.waitForTimeout(450);
  await page.mouse.move(40, 500);
  await page.mouse.down();
  await page.mouse.move(260, 504, { steps: 6 });
  const mid = await page.evaluate(() => ({
    moving: document.documentElement.classList.contains('moving'),
    shifted: /matrix\(1, 0, 0, 1, [1-9]/.test(getComputedStyle($('#app')).transform),
    ghostUp: !$('#ghost').hidden,
    ghostIsFeed: $('#ghost').querySelectorAll('[data-post]').length > 0,
    ghostAt: $('#ghost .inner').style.top,
    dimmed: +getComputedStyle($('#dim')).opacity > 0,
  }));
  check('  the profile follows the finger', mid.moving && mid.shifted, JSON.stringify(mid));
  check('    with the feed already behind it, at the place it was left',
    mid.ghostUp && mid.ghostIsFeed && mid.ghostAt === '-800px', JSON.stringify(mid));
  check('    and dimmed, so which one is on top is never in doubt', mid.dimmed, JSON.stringify(mid));
  await page.mouse.move(760, 506, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  check('  letting go past the middle of the screen leaves the profile',
    await page.evaluate(() => S.who) === null, String(await page.evaluate(() => S.who)));
  check('    landing where the feed was', await page.evaluate(() => scrollY) === 800,
    String(await page.evaluate(() => scrollY)));
  check('    with both layers put away again',
    await page.evaluate(() => $('#ghost').hidden && $('#dim').hidden
      && !document.documentElement.classList.contains('moving') && !$('#app').style.transform));

  // A short, slow drag is somebody changing their mind, and it has to fall back as
  // smoothly as it would have left or the gesture feels like a trap.
  await page.locator('.post .head .who').nth(1).click();
  await page.waitForTimeout(450);
  await page.mouse.move(40, 500);
  await page.mouse.down();
  for (const x of [50, 60, 70, 80]) { await page.mouse.move(x, 502); await page.waitForTimeout(60); }
  await page.mouse.up();
  await page.waitForTimeout(450);
  check('  a short slow drag changes nothing', await page.evaluate(() => S.who) !== null
    && await page.locator('#app .pf').count() === 1);
  check('    and tidies up after itself',
    await page.evaluate(() => $('#ghost').hidden && $('#dim').hidden && !$('#app').style.transform));
  await page.locator('#app .backx').click();
  await page.waitForTimeout(450);

  // Your own face in the feed is a way in too, and it used to be a way in with no way out:
  // the header with the gear belongs to the Profile tab, not to every look at yourself.
  await page.evaluate(() => scrollTo(0, 400));
  await page.evaluate(() => openWho(me().id));
  await page.waitForTimeout(400);
  check('  your own profile opened from the feed has a way back',
    await page.locator('#app .backx').count() === 1 && await page.locator('#app .hdr .gear').count() === 0);
  await page.locator('#app .backx').click();
  await page.waitForTimeout(400);
  check('    which also puts you back where you were',
    await page.evaluate(() => S.who) === null && await page.evaluate(() => scrollY) === 400);

  // The tab itself is the one that still carries the gear, and it is not a way back.
  await page.evaluate(() => go('profile'));
  await page.waitForTimeout(400);
  check('  the Profile tab keeps its gear and offers no way back',
    await page.locator('#app .hdr .gear').count() === 1 && await page.locator('#app .backx').count() === 0);
  await page.evaluate(() => { go('feed'); document.documentElement.style.minHeight = ''; });
  await page.waitForTimeout(300);

  // A face with no story behind it opens the profile rather than doing nothing.
  await page.evaluate(() => { S.stories = []; render(); });
  await page.waitForTimeout(200);
  await page.locator('.post .head .rg.none').nth(1).click();
  await page.waitForTimeout(450);
  check('  a face with no story behind it opens the profile too', await page.locator('.pf').count() === 1);
  await page.evaluate(() => closeWho());

  // With a story, the face is the story and the name is still the profile.
  await page.evaluate(() => { S.stories = [{id: 60, u: 'u2', kind: 'text', body: 'out early', ts: Date.now() - 36e5, style: {}}]; S.seen = []; render(); });
  await page.waitForTimeout(250);
  await page.locator('.post .head .rg.new').first().click();
  await page.waitForTimeout(350);
  check('    and a face with one opens the story instead', await page.locator('#story').isVisible());
  await page.locator('#story .who .x').click();
});

// A clip goes to the group. Putting it on your profile is a separate, deliberate tick.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(400);
  const box = page.locator('#dlg input[name=onprofile]');
  check('the post form offers the profile as a choice', await box.count() === 1);
  check('  which is off to begin with', !await box.isChecked());
  check('    and says what the difference is',
    /group sees it either way/i.test(await page.locator('#dlg .chk').innerText()),
    await page.locator('#dlg .chk').innerText());
  await page.evaluate(() => dlg());
  await page.waitForTimeout(300);

  // The post's own menu is how anything posted before today gets onto the grid.
  await page.locator('.post .head .more').first().click();
  await page.waitForTimeout(350);
  check("a post of your own offers to show itself on your profile",
    /show this on my profile/i.test(await page.locator('#dlg .menu').innerText()),
    await page.locator('#dlg .menu').innerText());
  // By what it says rather than by where it sits: the menu has more on it than it used to.
  await page.locator('#dlg .menu button', { hasText: /show this on my profile/i }).click();
  await page.waitForTimeout(700);
  const sent = (await page.evaluate(() => self.__edits)).filter(e => e.table === 'posts');
  check('  and ticking it saves that against the post',
    sent.length === 1 && sent[0].on_profile === true, JSON.stringify(sent));
  check('    which is what the grid is built from',
    await page.evaluate(() => S.posts.find(p => p.userId === 'u1').onProfile) === true);
  await page.evaluate(() => { go('profile'); });
  await page.waitForTimeout(700);
  check('  so it turns up in the grid', await page.locator('.pgrid .tile').count() === 1,
    String(await page.locator('.pgrid .tile').count()));
  check('    as a tile carrying what the day was worth',
    /50/.test(await page.locator('.pgrid .tile b').first().innerText()));
  // The same tile as before, now wearing the mark that says other people can see it.
  check('    and now marked as on show', await page.locator('.pgrid .tile .seen').count() === 1);
  check('      which the count above the grid agrees with', /^1$/.test(
    (await page.locator('.pf .stats div').last().innerText()).split('\n')[0].trim()));
  await page.locator('.pgrid .tile').first().click();
  await page.waitForTimeout(450);
  check('  and tapping the tile opens that one post on its own',
    await page.locator('#one').isVisible() && await page.locator('#one .post').count() === 1);
  // The clip in that layer used to be the one element on the page that never got its
  // source: watchClips() looked only inside #app, so it sat there black and a tap on it
  // had to fetch, attach and start it all at once.
  check('    with the clip given its source rather than left black',
    await page.evaluate(() => !!document.querySelector('#one video.proof')?.getAttribute('src')));
  await page.locator('#one .backx').click();
  await page.waitForTimeout(300);
  check('    with a way back out', await page.locator('#one').isHidden());

  // And taking it off again.
  await page.locator('.pgrid .tile').first().click();
  await page.waitForTimeout(400);
  await page.locator('#one .post .head .more').click();
  await page.waitForTimeout(350);
  check('  a post already on the profile offers to come off',
    /take this off my profile/i.test(await page.locator('#dlg .menu').innerText()),
    await page.locator('#dlg .menu').innerText());
  await page.evaluate(() => { dlg(); closePost(); });
});

// A post opened on its own sits in a layer of its own over the screen, and everything that
// is true of a screen has to be true of it: it moves when it is dragged, it comes back when
// the drag falls short, and what is on it keeps up with the rest of the app.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.evaluate(() => openPost(S.posts[0].id));
  await page.waitForTimeout(450);
  check('a post on its own opens over the screen', await page.locator('#one .post').count() === 1);

  // The screen underneath must not be the thing that moves. Its own back-drag works off
  // #app, so without a gesture of its own a pull here slid the feed out from under it and
  // left this sitting on top of the result.
  await page.evaluate(() => { S.who = 'u2'; backY.push(0); });
  await page.mouse.move(40, 500);
  await page.mouse.down();
  await page.mouse.move(150, 503, { steps: 5 });
  const held = await page.evaluate(() => ({
    one: /matrix\(1, 0, 0, 1, [1-9]/.test(getComputedStyle($('#one')).transform),
    app: $('#app').style.transform,
    who: S.who,
  }));
  check('  it is the post that follows the finger, not the screen behind it',
    held.one && !held.app && held.who === 'u2', JSON.stringify(held));
  await page.mouse.move(700, 505, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  check('  and a drag carried far enough closes it', await page.locator('#one').isHidden());
  check('    leaving the screen behind it exactly as it was',
    await page.evaluate(() => S.who) === 'u2');
  check('    with nothing of the drag left on it',
    await page.evaluate(() => !$('#one').style.transform && !$('#one').style.animation));
  await page.evaluate(() => { S.who = null; backY.length = 0; });

  // Falling back has to be as smooth as leaving or the gesture feels like a trap.
  await page.evaluate(() => openPost(S.posts[0].id));
  await page.waitForTimeout(450);
  await page.mouse.move(40, 500);
  await page.mouse.down();
  for (const x of [50, 62, 74, 86]) { await page.mouse.move(x, 502); await page.waitForTimeout(60); }
  await page.mouse.up();
  await page.waitForTimeout(400);
  check('  a short slow drag leaves it where it was', await page.locator('#one').isVisible()
    && await page.evaluate(() => !$('#one').style.transform));

  // It used to be drawn once and never again, so a reply written there did not appear
  // until it was closed and opened, and a like counted up everywhere except in front of you.
  const before = await page.locator('#one .clist .c').count();
  await page.evaluate(() => {
    S.comments = [...S.comments, {id: 950, postId: S.one, userId: 'u2', body: 'kept up', ts: Date.now()}];
    render();
  });
  await page.waitForTimeout(250);
  check('  and what is on it keeps up with the rest of the app',
    await page.locator('#one .clist .c').count() === before + 1
    && /kept up/.test(await page.locator('#one .clist').innerText()),
    await page.locator('#one').innerText());
  // The clip it is showing must survive that redraw, the same as one in the feed does.
  check('    without the clip it is playing being thrown away',
    await page.evaluate(() => !!document.querySelector('#one video.proof')?.getAttribute('src')));

  // A name on a post opened on its own is a way in too, and the profile used to slide in
  // underneath it: a screen change nobody could see, behind a layer still in the way.
  await page.locator('#one .head .who').first().click();
  await page.waitForTimeout(600);
  check('  a name tapped on it opens that profile in front, not behind it',
    await page.locator('#one').isHidden() && await page.evaluate(() => S.who) !== null
    && await page.locator('#app .pf').count() === 1);
  await page.locator('#app .backx').click();
  await page.waitForTimeout(500);
  await page.evaluate(() => openPost(S.posts[0].id));
  await page.waitForTimeout(450);

  // A post that goes while it is open must not leave an empty layer on screen.
  await page.evaluate(() => { const id = S.one; S.posts = S.posts.filter(p => p.id !== id);
    S.pro = {}; render(); });
  await page.waitForTimeout(250);
  check('  a post deleted while it is open closes rather than emptying',
    await page.locator('#one').isHidden() && await page.evaluate(() => S.one) === null);
});

// Proof already posted, put on a story. It goes on as a card rather than as the whole
// screen, because that is what it is: a thing lifted from somewhere else and stuck on.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.locator('.post .head .more').first().click();
  await page.waitForTimeout(350);
  check('a post of your own offers to go on your story',
    /share this to my story/i.test(await page.locator('#dlg .menu').innerText()),
    await page.locator('#dlg .menu').innerText());

  // The story points at the post rather than carrying a copy, so the people who can watch
  // the story have to be people who can open the post. On your profile is that exact set.
  await page.locator('#dlg .menu button').first().click();
  await page.waitForTimeout(350);
  check('  and says first that it also goes on your profile',
    /profile/i.test(await page.locator('#dlg').innerText()), await page.locator('#dlg').innerText());
  check('    with a way to back out', await page.locator('#dlg .row button').count() === 2);
  await page.locator('#dlg .row button').first().click();       // Cancel
  await page.waitForTimeout(300);
  check('    and backing out shares nothing and changes nothing',
    await page.evaluate(() => S.posts.find(p => p.userId === 'u1').onProfile) === false
    && await page.locator('#make').isHidden());

  await page.locator('.post .head .more').first().click();
  await page.waitForTimeout(300);
  await page.locator('#dlg .menu button').first().click();
  await page.waitForTimeout(300);
  await page.locator('#dlg .row button.teal').click();
  await page.waitForTimeout(800);
  check('  going ahead puts it on the profile and opens the editor',
    await page.evaluate(() => S.posts.find(p => p.userId === 'u1').onProfile) === true
    && await page.locator('#make').isVisible());
  check('    with the post on the card, not filling it',
    await page.locator('#make .face .pcard').count() === 1
    && await page.evaluate(() => {
      const c = document.querySelector('#make .face .pcard'), f = document.querySelector('#make .face');
      return c.getBoundingClientRect().width < f.getBoundingClientRect().width * 0.92;
    }));
  check('    carrying what the post was worth',
    /50/.test(await page.locator('#make .pcard .foot em').innerText()),
    await page.locator('#make .pcard .foot').innerText());
  check('    and it is not a button in here, because in here it is being arranged',
    await page.evaluate(() => document.querySelector('#make .pcard').tagName) === 'DIV');

  // It drags about the card like the words and the stickers do.
  const box = await page.locator('#make .pcard').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 90, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('    and it can be dragged where you want it',
    await page.evaluate(() => styleOf(S.draft).py) < 0.44,
    String(await page.evaluate(() => styleOf(S.draft).py)));

  await page.locator('#make .go').click();
  await page.waitForTimeout(900);
  const story = await page.evaluate(() => self.__stories.at(-1));
  check('  sharing writes the post it points at into the story',
    story && story.style && story.style.post === 1, JSON.stringify(story));
  check('    and nothing is uploaded, because the clip is already up',
    story && story.media_path === null && story.kind === 'text', JSON.stringify(story));

  // And in the viewer it is the way through to the post.
  await page.evaluate(() => openStory(S.me.id));
  await page.waitForTimeout(600);
  check('  the card is on the story when it is watched',
    await page.locator('#story .pcard').count() === 1);
  check('    as a button, above the zones that step the story on',
    await page.evaluate(() => {
      const c = document.querySelector('#story .pcard');
      return c.tagName === 'BUTTON' && +getComputedStyle(c).zIndex
        > +getComputedStyle(document.querySelector('#story .tap')).zIndex;
    }));
  await page.locator('#story .pcard').click();
  await page.waitForTimeout(600);
  check('  and tapping it opens that post rather than stepping the story on',
    await page.locator('#story').isHidden() && await page.locator('#one .post').count() === 1,
    `story hidden ${await page.locator('#story').isHidden()}, posts ${await page.locator('#one .post').count()}`);
  await page.evaluate(() => closePost());

  // A post that has gone since must not leave a hole on somebody's story.
  await page.evaluate(() => {
    S.stories = [{ id: 999, u: S.me.id, kind: 'text', body: '', style: { post: 123456 }, ts: Date.now() }];
    S.spost = {}; openStory(S.me.id);
  });
  await page.waitForTimeout(500);
  check('  a post that has gone says so rather than leaving a hole',
    /no longer here/i.test(await page.locator('#story .pcard').innerText()),
    await page.locator('#story .pcard').innerText());
  await page.evaluate(() => closeStory());
});

// ---- questioning somebody's proof
//
// The rules themselves live in the database and are checked there (test/policies.test.sql).
// What is checked here is that the app never offers what the database would refuse, and
// that an upheld flag really does take the day back — that last one is the whole point of
// the feature and it is worked out entirely in the browser.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  // Sam's post is the one that is not yours. HISTORY in the stub is all u2's.
  const other = await page.evaluate(() => S.posts.find(p => p.userId !== S.me.id).id);
  const own = await page.evaluate(() => S.posts.find(p => p.userId === S.me.id).id);
  check('the flag is on somebody else’s post',
    await page.locator(`.post[data-post="${other}"] .acts .flg`).count() === 1);
  check('  and not on your own, because you cannot question yourself',
    await page.locator(`.post[data-post="${own}"] .acts .flg`).count() === 0);
  check('  drawn as an outline until somebody uses it',
    await page.evaluate(o => {
      const s = document.querySelector(`.post[data-post="${o}"] .acts .flg svg`);
      return getComputedStyle(s).fill === 'none';
    }, other));

  await page.locator(`.post[data-post="${other}"] .acts .flg`).click();
  await page.waitForTimeout(350);
  check('  tapping it asks what is wrong rather than flagging on the spot',
    await page.locator('#dlg textarea').count() === 1);
  check('    and says the group decides', /group decides/i.test(await page.locator('#dlg').innerText()),
    await page.locator('#dlg').innerText());
  check('    and that the person it is about does not get a vote',
    /does not get a vote/i.test(await page.locator('#dlg').innerText()));

  // Cancel has to actually cancel. A half-written flag that goes up anyway is the worst
  // possible failure for a feature whose whole job is being fair.
  await page.locator('#dlg textarea').fill('elbows barely bent');
  await page.locator('#dlg .row button', { hasText: /cancel/i }).click();
  await page.waitForTimeout(400);
  check('  cancelling raises nothing at all',
    await page.evaluate(() => self.__flags.length) === 0
    && await page.evaluate(() => S.flags.length) === 0);

  // And an empty one is not a flag either: the reason is what everybody else votes on.
  await page.locator(`.post[data-post="${other}"] .acts .flg`).click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(400);
  check('  and one with no reason on it does not go up either',
    await page.evaluate(() => self.__flags.length) === 0);

  await page.locator('#dlg textarea').fill('not full range, elbows barely bent');
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(1100);
  const raised = await page.evaluate(() => self.__flags.at(-1));
  check('  submitting raises it against that post, with the reason on it',
    raised && raised.post_id === other && /elbows/.test(raised.reason), JSON.stringify(raised));
  check('    and takes you straight to the thing you just started',
    await page.evaluate(() => typeof S.flag) === 'number'
    && await page.locator('#app .fbar').count() === 1);
  check('    with a clock on it, because how long is left is the whole question',
    /\d+:\d\d/.test(await page.locator('#app .fbar .clock b').innerText()),
    await page.locator('#app .fbar').innerText());
  check('    the reason the group is being asked to read',
    /elbows/.test(await page.locator('#app .why p').innerText()));
  check('    and the clip it is about', await page.locator('#app .post .reel').count() === 1);

  // Raising one is a vote, or a pair could never reach "everybody has voted".
  check('  raising it counted as agreeing with it',
    await page.evaluate(() => myVote(S.flag)?.yes) === true);
  check('    and that shows as the one you picked',
    await page.locator('#app .votes button.on').count() === 1
    && /needs redoing/i.test(await page.locator('#app .votes button.on').innerText()));

  // Changing your mind before the result is out is not a second vote.
  await page.locator('#app .votes button', { hasText: /it counts/i }).click();
  await page.waitForTimeout(900);
  check('  you can change it while the clock is running',
    await page.evaluate(() => myVote(S.flag)?.yes) === false
    && await page.evaluate(() => self.__fvotes.filter(v => v.user_id === 'u1').length) === 1,
    JSON.stringify(await page.evaluate(() => self.__fvotes)));

  // Back out, and the post now says a question has been asked about it.
  await page.locator('#app .fbar .backx').click();
  await page.waitForTimeout(500);
  check('  the post itself says it is being questioned',
    await page.locator(`.post[data-post="${other}"] .fstrip`).count() === 1
    && /deciding/i.test(await page.locator(`.post[data-post="${other}"] .fstrip`).innerText()),
    await page.locator(`.post[data-post="${other}"] .fstrip`).innerText());
  check('    and the flag on it is filled in now, and goes to the decision',
    await page.evaluate(o => {
      const s = document.querySelector(`.post[data-post="${o}"] .acts .flg svg`);
      return getComputedStyle(s).fill !== 'none';
    }, other));
  check('  and the feed carries the way back to it',
    await page.locator('.fbar-chip').count() === 1
    && /\d+:\d\d/.test(await page.locator('.fbar-chip em').innerText()),
    await page.locator('.fbar-chip').innerText());
});

// What an upheld flag actually does, which is the whole point of the feature and is worked
// out in the browser: the amount stops counting towards the day it was posted on, so the
// day reopens and every rule written on top of the totals follows without knowing flags
// exist. Driven through a load rather than by poking S, because the filtering happens while
// the totals are being read.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  const before = await page.evaluate(() => {
    const g = myGroups()[0], p = S.posts.find(x => x.userId === 'u2');
    return { g: g.id, post: p.id, day: p.day, u: p.userId,
             did: done(g, p.userId, p.metric, p.day), streak: streak(g, p.userId) };
  });
  check('a day counts what was posted on it', before.did > 0, JSON.stringify(before));

  await page.evaluate(b => {
    self.__flags.push({ id: 700, post_id: b.post, by_user: 'u1', reason: 'not full range',
      created_at: new Date().toISOString(), closes_at: new Date(Date.now() - 6e4).toISOString(),
      outcome: 'upheld', closed_at: new Date().toISOString() });
    return load();
  }, before);
  await page.waitForTimeout(900);
  const after = await page.evaluate(b => ({
    did: done(S.groups.find(g => g.id === b.g), b.u, 'pushups', b.day),
    streak: streak(S.groups.find(g => g.id === b.g), b.u),
    flagged: S.flags.length,
  }), before);
  check('  and an upheld flag takes that amount back off it',
    after.did === before.did - (await page.evaluate(b => S.posts.find(p => p.id === b.post)?.amount ?? 0, before)),
    `${before.did} -> ${after.did}`);
  check('    which is what reopens the day rather than anything special-casing a streak',
    after.streak <= before.streak, `${before.streak} -> ${after.streak}`);
  check('  the post is not deleted: the group can still watch what it decided about',
    await page.locator(`.post[data-post="${before.post}"] .reel`).count() === 1);
  check('    and it says what was decided',
    /needs redoing/i.test(await page.locator(`.post[data-post="${before.post}"] .fstrip`).innerText()),
    await page.locator(`.post[data-post="${before.post}"] .fstrip`).innerText());

  // A decision reached is not a clock any more.
  await page.locator(`.post[data-post="${before.post}"] .fstrip`).click();
  await page.waitForTimeout(500);
  check('  opening it shows the verdict rather than a vote',
    await page.locator('#app .verdict').count() === 1
    && await page.locator('#app .votes').count() === 0,
    await page.locator('#app').innerText().then(t => t.slice(0, 200)));
  check('    with no clock left running on it',
    await page.evaluate(() => !!tickTimer) === false);
});

// A flag against you: you are told, and you do not get a vote on your own.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.evaluate(() => {
    const p = S.posts.find(x => x.userId === S.me.id);
    self.__flags.push({ id: 701, post_id: p.id, by_user: 'u2', reason: 'looked short to me',
      created_at: new Date().toISOString(), closes_at: new Date(Date.now() + 3 * 3600e3).toISOString(),
      outcome: null, closed_at: null });
    self.__fvotes.push({ flag_id: 701, user_id: 'u2', agree: true });
    return load();
  });
  await page.waitForTimeout(900);
  check('a flag against your own post says so in the feed',
    await page.locator('.fbar-chip.mine').count() === 1
    && /your proof is being questioned/i.test(await page.locator('.fbar-chip').innerText()),
    await page.locator('.fbar-chip').innerText());
  await page.locator('.fbar-chip').click();
  await page.waitForTimeout(600);
  check('  and opening it offers no vote, because you do not get one',
    await page.locator('#app .votes').count() === 0
    && /do not get a vote/i.test(await page.innerText('#app')),
    await page.innerText('#app'));
  check('    but does show what was said about it',
    /looked short to me/.test(await page.locator('#app .why p').innerText()));

  // A notification about one lands on it, not near it.
  await page.evaluate(() => { S.flag = null; render(); location.hash = '#flag-701'; });
  await page.waitForTimeout(600);
  check('  a notification about a flag opens that flag',
    await page.evaluate(() => S.flag) === 701 && await page.locator('#app .why').count() === 1);
  check('    and leaves a way back out of it',
    await page.locator('#app .fbar .backx').count() === 1);
  await page.locator('#app .fbar .backx').click();
  await page.waitForTimeout(500);
  check('    which goes back to the feed', await page.evaluate(() => S.flag) === null);
});

// A project where the v27 block has not been run. The tables are not there, and the app has
// to come up without the feature rather than not come up.
await withPage({ ...NO_WHEEL, noFlagTables: true }, async page => {
  await settle(page);
  check('without the schema block the app still loads', await page.isVisible('#bar')
    && await page.locator('.post').count() > 0);
  check('  with no error banner over it', await page.isHidden('#err'),
    await page.isHidden('#err') ? '' : await page.locator('#err').innerText());
  check('  and no flag offered on anything', await page.locator('.acts .flg').count() === 0);
  check('  and nothing in the feed about it', await page.locator('.fbar-chip').count() === 0);
});

// ---- talking to each other
await withPage({ ...NO_WHEEL, friends: true }, async page => {
  await settle(page);
  check('the feed carries a way into the chats', await page.locator('.hdr .chatbtn').count() === 1);
  check('  with nothing on it when nothing is waiting',
    await page.locator('.hdr .chatbtn i').count() === 0);

  await page.locator('.hdr .chatbtn').click();
  await page.waitForTimeout(600);
  check('a group has a chat whether anything has been said in it or not',
    await page.locator('.crow').count() === 1
    && /Mornings/.test(await page.locator('.crow').innerText()),
    await page.locator('#app').innerText());

  await page.locator('.crow').click();
  await page.waitForTimeout(600);
  check('  opening it gives you somewhere to type', await page.locator('.csend input').count() === 1);
  // The status bar is translucent and the page runs under it. Every header pads past it;
  // this one did not, and the name and the way back sat under the clock. Read off the
  // stylesheet rather than the box, because a desktop browser has no notch to measure.
  // The whole declaration block as text: a shorthand carrying env() is not broken into its
  // longhands by the browser, so asking for padding-top on its own comes back empty.
  const rule = sel => page.evaluate(s => {
    const r = [...document.styleSheets].flatMap(ss => { try { return [...ss.cssRules]; } catch (e) { return []; } })
      .find(x => x.selectorText === s);
    return r ? { css: r.style.cssText, pos: r.style.position } : null;
  }, sel);
  const cbar = await rule('.cbar'), fbar = await rule('.fbar'), backx = await rule('#app > .backx');
  check('  the bar at the top sits below the notch',
    cbar && /safe-area-inset-top/.test(cbar.css), JSON.stringify(cbar));
  check('    and so does the one on a flag', fbar && /safe-area-inset-top/.test(fbar.css), JSON.stringify(fbar));
  check('    and a back button on its own at the top of a screen',
    backx && /margin-top:.*safe-area-inset-top/.test(backx.css), JSON.stringify(backx));
  // A conversation is a column the height of the screen, and only the lines in it scroll.
  // Nothing sticky, nothing fixed: a sticky bar stops sticking the moment its screen is
  // transformed or lifted into the ghost, which is what was glitching the way out.
  await page.evaluate(() => {
    S.msgs = Array.from({ length: 40 }, (_, i) => ({ id: 9000 + i, groupId: 1, a: null, b: null,
      userId: i % 2 ? 'u1' : 'u2', body: `line ${i}`, ts: Date.now() - (40 - i) * 6e4 }));
    render();
  });
  await page.waitForTimeout(300);
  const col = await page.evaluate(() => {
    const m = document.querySelector('#msgs'), bar = document.querySelector('.cbar'), box = document.querySelector('.csend');
    const cs = getComputedStyle(m);
    const before = bar.getBoundingClientRect().top;
    m.scrollTop = 0;
    return { scrolls: cs.overflowY === 'auto' && m.scrollHeight > m.clientHeight,
      atEndFirst: m.scrollHeight - m.clientHeight - (m.scrollTop) >= 0,   // was scrolled to the end before we moved it
      barStill: bar.getBoundingClientRect().top === before,
      barSticky: getComputedStyle(bar).position === 'sticky', boxFixed: getComputedStyle(box).position === 'fixed',
      pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
      boxBelow: box.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 1 };
  });
  check('  a long conversation scrolls inside its own box, not the page',
    col.scrolls && !col.pageScrolls, JSON.stringify(col));
  check('    with the name and the way back held still above it, and nothing sticky or fixed to do it',
    col.barStill && !col.barSticky && !col.boxFixed && col.boxBelow, JSON.stringify(col));
  check('    and the tab bar put away for it, faded rather than gone',
    await page.evaluate(() => !$('#bar').hidden && $('#bar').classList.contains('away')));
  await page.evaluate(() => { S.msgs = []; render(); });
  await page.waitForTimeout(200);
  check('    and says who can read it',
    /everyone in the group/i.test(await page.locator('#app .msgs').innerText()),
    await page.locator('#app .msgs').innerText());

  const box = page.locator('.csend input');
  await box.fill('who is doing the 6am one');
  await page.evaluate(() => { self.__stall = new Promise(r => { self.__go = r; }); });
  await page.locator('.csend button.primary').click();
  await page.waitForTimeout(250);
  check('  a line shows before the write comes back',
    /6am one/.test(await page.locator('#app .msgs').innerText()));
  check('    emptying the box it was typed into', await box.inputValue() === '',
    JSON.stringify(await box.inputValue()));
  check('    and offering nothing to react to until it has really landed',
    await page.locator('.m.pending .drop').count() === 0);
  await page.evaluate(() => { const g = self.__go; self.__stall = null; g(); });
  await page.waitForTimeout(900);
  const sent = await page.evaluate(() => self.__msgs.at(-1));
  check('  and it is written against the group, not a pair',
    sent && sent.group_id === 1 && sent.a === null && /6am one/.test(sent.body), JSON.stringify(sent));

  // A conversation redraws itself every few seconds, so a redraw must never take what
  // somebody is in the middle of writing — the same fault as the comment box, in the one
  // place it would happen without anybody touching anything.
  await box.fill('half a thought');
  await page.evaluate(() => { document.querySelector('#app .csend input').focus(); render(); });
  await page.waitForTimeout(250);
  check('  a redraw does not take a half-written message',
    await box.inputValue() === 'half a thought', JSON.stringify(await box.inputValue()));
  check('    and leaves the caret where it was',
    await page.evaluate(() => document.activeElement === document.querySelector('#app .csend input')));
  await box.fill('');

  // Reacting to one, which is the same gesture as reacting to a post.
  await page.locator('#app .m .say').last().click();
  await page.waitForTimeout(300);
  check('  tapping a line offers a reaction', await page.locator('#app .m .reactpick').count() === 1);
  // Put away by tapping anywhere that is not it, which is what tapping away from an open
  // thing means everywhere else on a phone. It used to want the same message tapped again.
  await page.locator('#app .cbar').click();
  await page.waitForTimeout(200);
  check('    and tapping anywhere else puts it away',
    await page.locator('#app .m .reactpick').count() === 0);
  await page.locator('#app .m .say').last().click();
  await page.waitForTimeout(250);
  check('    while tapping the tray itself leaves it up',
    await page.locator('#app .m .reactpick').count() === 1);
  // What you answer a message with is not what you answer a post with: a post gets cheers,
  // a line in a conversation gets agreeing with it or not.
  const quick = await page.locator('#app .m .reactpick button').allInnerTexts();
  check('    with answers a conversation actually takes',
    quick.includes('❤️') && quick.includes('👍') && quick.includes('👎') && !quick.includes('💪'),
    JSON.stringify(quick));
  check('      and a way to anything else', quick.includes('+'));

  // The + opens the rest in the same tray rather than a sheet over the conversation.
  await page.locator('#app .m .reactpick .more').click();
  await page.waitForTimeout(250);
  const all = await page.locator('#app .m .reactpick button').allInnerTexts();
  check('    which opens the rest in place, and scrolls',
    all.length > 20 && !all.includes('+')
    && await page.evaluate(() => getComputedStyle(document.querySelector('#app .m .reactpick')).overflowX === 'auto'),
    `${all.length} to pick from`);
  check('      still offering the quick ones first', all[0] === '❤️', JSON.stringify(all.slice(0, 3)));

  await page.locator('#app .m .reactpick button').first().click();
  await page.waitForTimeout(700);
  check('    and picking one sticks it on',
    await page.locator('#app .m .mrx button').count() === 1
    && await page.evaluate(() => self.__mreacts.length) === 1,
    JSON.stringify(await page.evaluate(() => self.__mreacts)));

  // Back to the list, because that is where this was opened from.
  await page.locator('#app .cbar .backx').click();
  await page.waitForTimeout(600);
  check('  and the way back is the list it was opened from',
    await page.evaluate(() => S.chat) === 'list' && await page.locator('.crow').count() >= 1);
  check('    with the last thing said on the row',
    /6am one/.test(await page.locator('.crow').first().innerText()),
    await page.locator('.crow').first().innerText());
});

// A private one, the pair it is stored as, and what the filter says about language it
// turns away.
await withPage({ ...NO_WHEEL, friends: true }, async (page, alerts) => {
  await settle(page);
  await page.evaluate(() => go('friends'));
  await page.waitForTimeout(600);
  check('a friend can be messaged from the friends list',
    await page.locator('#app .list .row .msg').count() === 1);
  await page.locator('#app .list .row .msg').click();
  await page.waitForTimeout(600);
  check('  which opens a chat with only the two of you in it',
    /only you and/i.test(await page.locator('#app .msgs').innerText()),
    await page.locator('#app .msgs').innerText());
  await page.locator('.csend input').fill('see you tomorrow');
  await page.locator('.csend button.primary').click();
  await page.waitForTimeout(900);
  const dm = await page.evaluate(() => self.__msgs.at(-1));
  check('  and it is stored as the pair, sorted, the way a friendship is',
    dm && dm.group_id === null && dm.a === 'u1' && dm.b === 'u2', JSON.stringify(dm));

  // Language the filter turns away, said back without being said back. The word is taken
  // out of the page at run time rather than written here, which is the same reason the
  // notice does not quote it: nobody needs it on the screen to know which one it was.
  const swear = await page.evaluate(() => (BAD.swear.word || [])[0] || (BAD.swear.any || [])[0]);
  alerts.length = 0;
  await page.locator('.csend input').fill(`well ${swear} then`);
  await page.locator('.csend button.primary').click();
  await page.waitForTimeout(500);
  const said = alerts.join(' | ');
  check('  language the filter turns away is refused', /cannot go on Quota/i.test(said), said);
  check('    without repeating the word back at you', !said.toLowerCase().includes(swear),
    said.replace(new RegExp(swear, 'ig'), '***'));
  check('      while still saying which kind it was', /swear word/i.test(said), said);
  check('    and nothing was sent', await page.evaluate(() => self.__msgs.length) === 1,
    String(await page.evaluate(() => self.__msgs.length)));
  await page.locator('.csend input').fill('');

  // Back out of a conversation is always the hub, however it was reached; back out of the
  // hub is wherever you were before any of it. Opened from Friends, that is Friends.
  await page.locator('#app .cbar .backx').click();
  await page.waitForTimeout(600);
  check('  back out of it is the hub, even though it was opened from Friends',
    await page.evaluate(() => S.chat) === 'list' && await page.locator('.crow').count() >= 1);
  await page.locator('#app > .backx').click();
  await page.waitForTimeout(600);
  check('    and back out of the hub is Friends, where this started',
    await page.evaluate(() => S.chat) === null && await page.evaluate(() => S.tab) === 'friends'
    && await page.evaluate(() => backY.length) === 0);
});

// ---- every way back, and that it lands where you were
//
// A screen that opens over the feed has to have a way back that puts you where you were —
// not at the top of the feed, and not one screen short. Every stacked screen, every back
// control on it, from a feed scrolled well down, and the scroll checked on landing.
await withPage({ ...NO_WHEEL, manyPosts: 12, friends: true }, async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const other = await page.evaluate(() => S.posts.find(p => p.userId !== S.me.id).id);
  await page.evaluate(o => {
    self.__flags.push({ id: 730, post_id: o, by_user: 'u2', reason: 'not sure',
      created_at: new Date().toISOString(), closes_at: new Date(Date.now() + 2 * 3600e3).toISOString(),
      outcome: null, closed_at: null });
    self.__fvotes.push({ flag_id: 730, user_id: 'u2', agree: true });
    return load();
  }, other);
  await page.waitForTimeout(900);
  const Y = 640;
  const onFeedAt = async () => ({ feed: await page.evaluate(() => S.tab === 'feed' && !S.who && !S.open && !S.flag && !S.chat && !S.settings && !S.legal),
    y: await page.evaluate(() => scrollY), stack: await page.evaluate(() => backY.length) });
  const back = async (sel, label) => {
    await page.locator(sel).first().click();
    await page.waitForTimeout(500);
    const r = await onFeedAt();
    check(label, r.feed && r.y === Y && r.stack === 0, JSON.stringify(r));
  };
  const from = async () => { await page.evaluate(y => scrollTo(0, y), Y); await page.waitForTimeout(80); };

  await from(); await page.locator('.post .head .who').nth(1).click(); await page.waitForTimeout(500);
  await back('#app > .backx', 'a profile goes back to the feed where you were');

  await from(); await page.evaluate(() => openSettings()); await page.waitForTimeout(500);
  await back('#app .ghost.back', 'settings goes back to the feed where you were');

  await from(); await page.evaluate(() => openLegal('privacy')); await page.waitForTimeout(500);
  await back('#app .ghost.back', 'a document goes back to the feed where you were');

  await from(); await page.evaluate(() => openFlag(730)); await page.waitForTimeout(500);
  await back('#app .fbar .backx', 'a flag goes back to the feed where you were');

  await from(); await page.evaluate(() => openFlag('all')); await page.waitForTimeout(500);
  check('the flags list has a way back at the top', await page.locator('#app > .backx').count() === 1);
  await page.locator('.frow').first().click(); await page.waitForTimeout(500);
  await page.locator('#app .fbar .backx').click(); await page.waitForTimeout(500);
  check('  a flag opened from the list goes back to the list, not past it',
    await page.evaluate(() => S.flag) === 'all' && await page.locator('.frow').count() === 1,
    String(await page.evaluate(() => S.flag)));
  await back('#app > .backx', '  and the list goes back to the feed where you were');

  // Opened by calling in rather than by tapping the icon: the icon is in the feed's header,
  // and a click on it scrolls the page to the top to reach it — which is what a thumb has to
  // do as well, so "where you were" is the top in that case and proves nothing here. This is
  // about the stack under the hub, so the hub is opened with the page left where it is.
  await from(); await page.evaluate(() => openChats()); await page.waitForTimeout(500);
  check('the chat hub has a way back at the top', await page.locator('#app > .backx').count() === 1);
  await page.locator('.crow').first().click(); await page.waitForTimeout(500);
  check('  and a conversation has one at the top too', await page.locator('#app .cbar .backx').count() === 1);
  await page.locator('#app .cbar .backx').click(); await page.waitForTimeout(500);
  check('  a conversation goes back to the hub', await page.evaluate(() => S.chat) === 'list');
  await back('#app > .backx', '  and the hub goes back to the feed where you were');

  // A conversation reached from a group screen: back is still the hub, and back out of the
  // hub is the group, not the feed, at the spot you left it.
  await page.evaluate(() => go('groups')); await page.waitForTimeout(300);
  await page.evaluate(() => openGroup(1)); await page.waitForTimeout(500);
  await page.evaluate(() => scrollTo(0, 220)); await page.waitForTimeout(80);
  await page.locator('#app .chatrow').click(); await page.waitForTimeout(500);
  await page.locator('#app .cbar .backx').click(); await page.waitForTimeout(500);
  check('a conversation opened from a group goes back to the hub first',
    await page.evaluate(() => S.chat) === 'list');
  await page.locator('#app > .backx').click(); await page.waitForTimeout(500);
  check('  and the hub goes back to the group, where you were',
    await page.evaluate(() => S.open === 1 && S.chat === null && scrollY === 220),
    JSON.stringify(await page.evaluate(() => ({ open: S.open, chat: S.chat, y: scrollY }))));

  // The two layers that are not screens: closing them changes nothing underneath.
  await page.evaluate(() => go('feed')); await page.waitForTimeout(300);
  await from(); await page.evaluate(() => openPost(S.posts[0].id)); await page.waitForTimeout(400);
  await page.locator('#one .backx').click(); await page.waitForTimeout(400);
  check('closing a post on its own leaves the feed where it was', (await onFeedAt()).y === Y);
  await page.evaluate(() => { S.stories = [{ id: 5, u: 'u2', kind: 'text', body: 'hi', style: {}, ts: Date.now() }]; render(); });
  await from(); await page.evaluate(() => openStory('u2')); await page.waitForTimeout(400);
  await page.locator('#story .who .x').click(); await page.waitForTimeout(400);
  check('closing a story leaves the feed where it was', (await onFeedAt()).y === Y);
});

// What is waiting, and what stops waiting once it has been read.
await withPage({ ...NO_WHEEL, friends: true }, async page => {
  await settle(page);
  await page.evaluate(() => {
    self.__msgs.push({ id: 950, group_id: 1, a: null, b: null, user_id: 'u2',
      body: 'anyone up', created_at: new Date().toISOString() });
    return load();
  });
  await page.waitForTimeout(900);
  check('something said by somebody else counts as waiting',
    await page.locator('.hdr .chatbtn i').count() === 1
    && (await page.locator('.hdr .chatbtn i').innerText()).trim() === '1',
    await page.locator('.hdr .chatbtn i').innerText());
  await page.locator('.hdr .chatbtn').click();
  await page.waitForTimeout(500);
  check('  and the row it is in says so', await page.locator('.crow.un').count() === 1);
  await page.locator('.crow').click();
  await page.waitForTimeout(900);
  check('  reading it stops it waiting',
    await page.evaluate(() => self.__reads.some(r => r.chat === 'g:1')),
    JSON.stringify(await page.evaluate(() => self.__reads)));
  await page.evaluate(() => { S.chat = null; S.chatFrom = null; go('feed'); });
  await page.waitForTimeout(600);
  check('    and the feed stops saying so too', await page.locator('.hdr .chatbtn i').count() === 0);

  // Your own words are never something waiting to be read.
  await page.evaluate(() => {
    self.__msgs.push({ id: 951, group_id: 1, a: null, b: null, user_id: 'u1',
      body: 'i am', created_at: new Date().toISOString() });
    return load();
  });
  await page.waitForTimeout(900);
  check('  and what you said yourself never counts as waiting',
    await page.locator('.hdr .chatbtn i').count() === 0);

  // A notification about one lands in it, not near it.
  await page.evaluate(() => { location.hash = '#chat-g:1'; });
  await page.waitForTimeout(700);
  check('  a notification about a message opens that conversation',
    await page.evaluate(() => S.chat) === 'g:1' && await page.locator('.csend input').count() === 1);
});

// A project where the v28 block has not been run.
await withPage({ ...NO_WHEEL, noChatTables: true }, async page => {
  await settle(page);
  check('without the chat block the app still loads', await page.isVisible('#bar')
    && await page.locator('.post').count() > 0);
  check('  with no error banner over it', await page.isHidden('#err'),
    await page.isHidden('#err') ? '' : await page.locator('#err span').innerText());
  check('  and no way in offered anywhere', await page.locator('.hdr .chatbtn').count() === 0);
});

// ---- what is happening while you are looking
//
// A push notification is for somebody who is not looking. This is the other half, and the
// two rules that matter are both about restraint: nothing for a post in your group, because
// the feed fills in underneath you, and nothing for the chat that is open in front of you.
const fire = (page, table, row, ev = 'INSERT') =>
  page.evaluate(([t, r, e]) => self.__live(t, { eventType: e, new: r }), [table, row, ev]);
const settleLive = p => p.waitForTimeout(1400);   // the burst window, plus the load it asks for

await withPage({ ...NO_WHEEL, friends: true }, async page => {
  await settle(page);
  check('the app subscribes to what it can show',
    (await page.evaluate(() => self.__liveTables())).includes('comments'));
  check('  and knows it is connected', await page.evaluate(() => liveOn) === true);

  // Somebody in your group posting: the feed fills in underneath you and says nothing.
  await page.evaluate(() => {
    self.__posts.push({ id: 510, group_id: 1, user_id: 'u2', metric: 'pushups', amount: 25,
      caption: '', video_path: 'live.mp4', day: new Date().toLocaleDateString('en-CA'),
      created_at: new Date().toISOString() });
  });
  const before = await page.locator('.post').count();
  await fire(page, 'posts', { id: 510, group_id: 1, user_id: 'u2' });
  await settleLive(page);
  check('a post in your group turns up in the feed on its own',
    await page.locator('.post').count() === before + 1,
    `${before} -> ${await page.locator('.post').count()}`);
  check('  and says nothing, because you can already see it',
    await page.isHidden('#drop'), await page.locator('#drop').innerText().catch(() => ''));

  // A comment on your own proof is news, and it lands on the comment.
  const mine = await page.evaluate(() => S.posts.find(p => p.userId === S.me.id).id);
  await page.evaluate(m => {
    self.__cmts.push({ id: 760, post_id: m, user_id: 'u2', body: 'how', created_at: new Date().toISOString() });
  }, mine);
  await fire(page, 'comments', { id: 760, post_id: mine, user_id: 'u2', body: 'how' });
  await settleLive(page);
  check('a comment on your own proof comes down from the top',
    await page.isVisible('#drop') && /Sam/.test(await page.locator('#drop').innerText())
    && /how/.test(await page.locator('#drop').innerText()),
    await page.locator('#drop').innerText());
  await page.locator('#drop .dropcard').click();
  await page.waitForTimeout(600);
  check('  and tapping it goes to that comment, not near it',
    await page.evaluate(() => !!document.querySelector('[data-cmt="760"]')));
  check('    taking the banner with it', await page.isHidden('#drop'));

  // Somebody else's proof being commented on is not your business.
  const theirs = await page.evaluate(() => S.posts.find(p => p.userId !== S.me.id).id);
  await page.evaluate(t => {
    self.__cmts.push({ id: 761, post_id: t, user_id: 'u2', body: 'nice', created_at: new Date().toISOString() });
  }, theirs);
  await fire(page, 'comments', { id: 761, post_id: theirs, user_id: 'u2', body: 'nice' });
  await settleLive(page);
  check('  a comment on somebody else’s proof says nothing to you',
    await page.isHidden('#drop'), await page.locator('#drop').innerText().catch(() => ''));

  // Nothing you did yourself is ever news to you.
  await page.evaluate(m => {
    self.__likes.push({ post_id: m, user_id: 'u1' });
  }, mine);
  await fire(page, 'likes', { post_id: mine, user_id: 'u1' });
  await settleLive(page);
  check('  and nothing you did yourself is news to you', await page.isHidden('#drop'));
});

// The chat you are reading, and the one you are not.
await withPage({ ...NO_WHEEL, friends: true }, async page => {
  await settle(page);
  await page.evaluate(() => openChat('g:1'));
  await page.waitForTimeout(700);
  check('the subscription takes the chat poll off its hands',
    await page.evaluate(() => chatPoll) === null);

  await page.evaluate(() => {
    self.__msgs.push({ id: 960, group_id: 1, a: null, b: null, user_id: 'u2',
      body: 'anyone up', created_at: new Date().toISOString() });
  });
  await fire(page, 'messages', { id: 960, group_id: 1, a: null, b: null, user_id: 'u2', body: 'anyone up' });
  await settleLive(page);
  check('  a line in the chat you are reading appears in it',
    /anyone up/.test(await page.locator('#app .msgs').innerText()),
    await page.locator('#app .msgs').innerText());
  check('    and says nothing, because you are reading it', await page.isHidden('#drop'));

  // The same line, in a conversation you are not looking at.
  await page.evaluate(() => { S.chat = null; S.chatFrom = null; render(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    self.__msgs.push({ id: 961, a: 'u1', b: 'u2', group_id: null, user_id: 'u2',
      body: 'see you tomorrow', created_at: new Date().toISOString() });
  });
  await fire(page, 'messages', { id: 961, a: 'u1', b: 'u2', group_id: null, user_id: 'u2', body: 'see you tomorrow' });
  await settleLive(page);
  check('  a line in one you are not looking at does come down from the top',
    await page.isVisible('#drop') && /see you tomorrow/.test(await page.locator('#drop').innerText()),
    await page.locator('#drop').innerText());
  await page.locator('#drop .dropcard').click();
  await page.waitForTimeout(800);
  check('    and tapping it opens that conversation',
    await page.evaluate(() => S.chat) === 'u:u2');
});

// Saying yes, and the end of a flag: both are things that happen to you without you doing
// anything, which is exactly what the banner is for.
await withPage({ ...NO_WHEEL, friends: true }, async page => {
  await settle(page);
  await fire(page, 'friendships', { a: 'u1', b: 'u2' });
  await settleLive(page);
  check('somebody accepting your request says so',
    await page.isVisible('#drop') && /accepted/i.test(await page.locator('#drop').innerText()),
    await page.locator('#drop').innerText());
  await page.locator('#drop .x').click();
  await page.waitForTimeout(300);
  check('  and it can be sent away', await page.isHidden('#drop'));

  // A banner goes on its own, or it is a thing to be cleared rather than a thing to be read.
  await fire(page, 'invites', { id: 55, type: 'friend', from_user: 'u3', to_user: 'u1' });
  await settleLive(page);
  check('  a request coming in says so too', await page.isVisible('#drop'));
  await page.waitForTimeout(5200);
  check('    and goes away on its own', await page.isHidden('#drop'));
});

// A project that has not turned realtime on in the dashboard. Nothing here is allowed to
// be a thing the app needs in order to work.
await withPage({ ...NO_WHEEL, noRealtime: true }, async page => {
  await settle(page);
  check('without realtime the app comes up exactly as it did', await page.isVisible('#bar')
    && await page.locator('.post').count() > 0);
  check('  with no error banner over it', await page.isHidden('#err'),
    await page.isHidden('#err') ? '' : await page.locator('#err span').innerText());
  await page.evaluate(() => openChat('g:1'));
  await page.waitForTimeout(600);
  check('  and the chat falls back to asking for itself',
    await page.evaluate(() => chatPoll) !== null);
});

// ---- a picture for a group
//
// The same bucket, the same crop and the same 512px square a person's picture is. What is
// different is where it is filed — a group is not a user, and the avatars policies key on
// the first folder being your own id — so the path is what this is really about.
await withPage({ ...NO_WHEEL, friends: true }, async page => {
  await settle(page);
  await page.evaluate(() => go('groups'));
  await page.waitForTimeout(400);
  check('a group with no picture wears its first letter',
    (await page.locator('.ghead .av.gav').first().innerText()).trim() === 'M',
    await page.locator('.ghead .av.gav').first().innerText());

  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(500);
  await page.evaluate(() => groupDlg(S.groups.find(x => x.id === 1)));
  await page.waitForTimeout(400);
  check('  editing it offers somewhere to put one',
    await page.locator('#dlg #avprev .av').count() === 1
    && /camera/i.test(await page.locator('#dlg').innerText()));
  check('    and says who may change it',
    /anyone in it can change it/i.test(await page.locator('#dlg').innerText()));

  // Straight through the crop, the way the camera and the file picker both arrive at it.
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const g = c.getContext('2d'); g.fillStyle = '#123456'; g.fillRect(0, 0, 8, 8);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await openCrop(new File([blob], 'pic.png', { type: 'image/png' }), 'file');
  });
  await page.waitForTimeout(500);
  check('  a picture chosen for it goes through the same crop a face does',
    await page.locator('#crop').evaluate(d => d.open) === true);
  await page.evaluate(() => useCrop());
  await page.waitForTimeout(600);
  check('    and lands in the form as the picture it will be',
    await page.locator('#dlg #avprev .av img').count() === 1);

  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(1200);
  const up = await page.evaluate(() => (self.__uploads || []).at(-1));
  check('  saving files it under the group, not under whoever saved it',
    up && up.bucket === 'avatars' && /^g\/1\/\d+\.jpg$/.test(up.path) && up.type === 'image/jpeg',
    JSON.stringify(up));
  const wrote = await page.evaluate(() => self.__edits.filter(e => e.table === 'groups' && 'avatar_path' in e).at(-1));
  check('    and writes that path onto the group',
    wrote && wrote.avatar_path === up.path, JSON.stringify(wrote));

  // And once it is really saved — read back through a load, not set on S by hand — it is
  // the group's face everywhere the letter used to be.
  await page.evaluate(() => go('groups'));
  await page.waitForTimeout(800);
  check('  the group wears it in the list',
    (await page.locator('.ghead .av.gav img').first().getAttribute('src') || '').includes(up.path),
    await page.locator('.ghead .av.gav img').first().getAttribute('src').catch(() => 'no img'));
  await page.evaluate(() => openChat('g:1'));
  await page.waitForTimeout(700);
  check('    and at the top of its chat',
    (await page.locator('.cbar .av.gav img').getAttribute('src') || '').includes(up.path));
  await page.evaluate(() => closeChat());
  await page.waitForTimeout(600);
  await page.evaluate(() => openChats());
  await page.waitForTimeout(600);
  check('    and in the list of chats',
    (await page.locator('.crow .av.gav img').first().getAttribute('src') || '').includes(up.path));
});

// A picture that will not upload must not take the name and the quotas down with it.
await withPage({ ...NO_WHEEL, uploadFails: true }, async page => {
  await settle(page);
  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(400);
  await page.evaluate(() => groupDlg(S.groups.find(x => x.id === 1)));
  await page.waitForTimeout(300);
  await page.locator('#dlg input[name=name]').fill('Evenings');
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    c.getContext('2d').fillRect(0, 0, 8, 8);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await openCrop(new File([blob], 'pic.png', { type: 'image/png' }), 'file');
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => useCrop());
  await page.waitForTimeout(400);
  await page.locator('#dlg button.primary').click();
  await page.waitForTimeout(1400);
  const named = await page.evaluate(() => self.__edits.filter(e => e.table === 'groups' && e.name).at(-1));
  check('a picture that will not upload still saves the rest of the group',
    named && named.name === 'Evenings', JSON.stringify(named));
  check('  and says so rather than failing quietly',
    await page.isVisible('#err') && /picture/i.test(await page.locator('#err span').innerText()),
    await page.locator('#err span').innerText().catch(() => ''));
});

// Which groups you are willing to have on show.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => { go('profile'); });
  await page.waitForTimeout(500);
  check('a profile shows no groups until you pick some', await page.locator('.gchips').count() === 0);
  await page.evaluate(() => { S.profiles.u1.shown_groups = [S.groups[0].id]; render(); });
  await page.waitForTimeout(250);
  check('  one picked shows as a chip', await page.locator('.gchip').count() === 1
    && /Mornings/.test(await page.locator('.gchip').innerText()));
  check('    carrying your run in that group', /day streak/.test(await page.locator('.gchip').innerText()),
    await page.locator('.gchip').innerText());
  await page.evaluate(() => { S.profiles.u1.shown_groups = [9999]; render(); });
  await page.waitForTimeout(250);
  check('  a group you are not in is never shown, whatever the list says',
    await page.locator('.gchip').count() === 0);
  await page.evaluate(() => { openSettings(); });
  await page.waitForTimeout(400);
  await page.locator('.li:has-text("Groups on your profile")').click();
  await page.waitForTimeout(350);
  check('  and settings is where you choose', await page.locator('#dlg input[name=g]').count() === 1);
});

// A long run leaves a mark. Earned once, kept whatever happens next, and never a second
// time for the same number.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  check('a name with no long run behind it carries no badge',
    await page.locator('.post .head .bchip').count() === 0);

  // A hundred days, all of them behind us: the history is what earns it. The confetti has
  // its own tests; here it is marked as already seen so it does not sit over the badges.
  const claimed = await page.evaluate(async () => {
    try { localStorage.milestone = '1000'; } catch (e) {}
    const g = S.groups[0], d = n => { const x = new Date(); x.setDate(x.getDate() - n); return x.toLocaleDateString('en-CA'); };
    for (let i = 0; i < 120; i++) S.totals.push({g: g.id, u: 'u1', d: d(i), m: 'pushups', n: 50});
    S.badges = []; self.__badges = [];
    await claimBadges();
    return {have: badgesOf('u1').map(b => b.n), sent: self.__badges.map(b => b.streak)};
  });
  check('  a run of 120 days earns every milestone it passed', claimed.have.join() === '25,50,100',
    JSON.stringify(claimed));
  check('    and each one is written down, not worked out again later',
    claimed.sent.slice().sort((a, b) => a - b).join() === '25,50,100', JSON.stringify(claimed.sent));
  check('    stopping at the ones that are big enough to mean something',
    !claimed.have.some(n => n < 25));

  // Run it again: the badges are already there, so nothing new is claimed.
  const again = await page.evaluate(async () => { await claimBadges(); return self.__badges.length; });
  check('  asking again claims nothing', again === 3, String(again));

  // The run breaks. The badge is not a reading of the current state.
  const broken = await page.evaluate(() => {
    S.totals = S.totals.filter(t => !(t.u === 'u1' && t.m === 'pushups'));
    render();
    return {streak: Math.max(0, ...myGroups().map(g => streak(g, 'u1'))), badges: badgesOf('u1').map(b => b.n)};
  });
  check('  and a broken run keeps every badge it earned', broken.streak === 0 && broken.badges.join() === '25,50,100',
    JSON.stringify(broken));

  // Next to a name, only the highest of them.
  await page.evaluate(() => { S.badges = [{u: 'u2', n: 25, ts: Date.now()}, {u: 'u2', n: 365, ts: Date.now()}]; render(); });
  await page.waitForTimeout(250);
  const chips = await page.locator('.post .head .bchip').count();
  check('somebody who has earned several wears the highest one beside their name', chips >= 1);
  check('  one badge, not a row of them', await page.evaluate(() =>
    [...document.querySelectorAll('.post[data-post] .head')].every(h => h.querySelectorAll('.bchip').length <= 1)));
  check('    and it is the highest', await page.evaluate(() => topBadge('u2').n) === 365);

  await page.locator('.post .head .bchip').first().click();
  await page.waitForTimeout(350);
  const win = await page.locator('#dlg .bwin').innerText();
  check('  tapping it says what the milestone is', /365/.test(win) && /day streak/i.test(win)
    && /full year/i.test(win), win);
  check('    and whose it is', /Sam/.test(win), win);
  await page.evaluate(() => $('#dlg').dispatchEvent(new MouseEvent('click', {bubbles: true})));
  await page.waitForTimeout(300);
  check('    and it closes', await page.locator('#dlg').isHidden());

  // All of them on the profile, in the order they were earned.
  await page.evaluate(() => { S.badges = [{u: 'u1', n: 25, ts: Date.now()}, {u: 'u1', n: 100, ts: Date.now()}, {u: 'u1', n: 1000, ts: Date.now()}]; go('profile'); });
  await page.waitForTimeout(350);
  check('your profile shows every badge you have', await page.locator('.bshelf button').count() === 3);
  check('  lowest first', await page.locator('.bshelf button').first().innerText() === '25',
    await page.locator('.bshelf button').first().innerText());
  check('  each one drawn differently', await page.evaluate(() => {
    const arts = [...document.querySelectorAll('.bshelf .bdg')].map(el => el.innerHTML);
    return new Set(arts).size === arts.length;
  }));
  check('  and openable from there too', await page.evaluate(() =>
    document.querySelector('.bshelf button').getAttribute('onclick').includes('badgeDlg')));
});

// A story is findable from the face on a post, not only from the row at the top: somebody
// scrolling the feed should not have to go back up to notice one.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const ring = () => page.locator('.post .head .rg.new').first();
  // Every face is a button now, because one with no story behind it opens the profile.
  // What a ring means is the lit or quiet state, not the presence of the button.
  check('a face on a post carries no ring when there is no story behind it',
    await page.locator('.post .head .rg.new, .post .head .rg.old').count() === 0
    && await page.locator('.post .head .av').count() > 0);

  await page.evaluate(() => {
    S.stories = [{id: 40, u: 'u2', kind: 'text', body: 'out early', ts: Date.now() - 36e5, style: {}}];
    S.seen = []; render();
  });
  await page.waitForTimeout(250);
  check('  a story lights the ring on every post of theirs', await page.locator('.post .head .rg.new').count() >= 1);
  check('    and leaves your own face unlit', await page.evaluate(() => {
    const mine = [...document.querySelectorAll('.post[data-post]')].filter(el => /@ari/.test(el.querySelector('.head').innerText));
    return mine.length > 0 && mine.every(el => !el.querySelector('.head .rg.new, .head .rg.old'));
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
  check('  a story that has expired takes its ring with it',
    await page.locator('.post .head .rg.new, .post .head .rg.old').count() === 0);
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

  // Swiping, which is one line through everybody rather than one person at a time. The
  // line is the row: yours, then anyone unseen, then everyone already caught up with —
  // and being able to swipe back to one you have watched is the point of it.
  await page.evaluate(() => {
    S.profiles.u3 = {id: 'u3', username: 'kit', display_name: 'Kit'};
    S.groups[0].members = [...new Set([...S.groups[0].members, 'u3'])];
  });
  await put([
    {id: 101, u: 'u1', kind: 'text', body: 'mine one'}, {id: 102, u: 'u1', kind: 'text', body: 'mine two'},
    {id: 201, u: 'u2', kind: 'text', body: 'theirs one'}, {id: 202, u: 'u2', kind: 'text', body: 'theirs two'},
    {id: 301, u: 'u3', kind: 'text', body: 'kit only'},
  ]);
  await page.evaluate(() => { S.seen = [201, 202]; render(); });
  await page.waitForTimeout(150);
  check('the line is yours, then unseen, then already watched',
    (await page.evaluate(() => storyPeople())).join(' ') === 'u1 u3 u2',
    (await page.evaluate(() => storyPeople())).join(' '));
  check('  and somebody already watched is still in it, to be swiped back to',
    (await page.evaluate(() => storyPeople())).includes('u2'));

  // A real drag, not a call to stepStory: the tap zones cover the whole face, so this is
  // also the check that a swipe does not step twice by leaving a click behind it.
  const swipe = async dir => {
    await page.mouse.move(dir < 0 ? 300 : 90, 400);
    await page.mouse.down();
    await page.mouse.move(dir < 0 ? 90 : 300, 402, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(420);        // it slides the rest of the way now, then redraws
  };
  const where = () => page.evaluate(() => S.story && {uid: S.story.uid, i: S.story.i, p: S.story.p});

  await page.evaluate(() => openStory('u1'));
  await page.waitForTimeout(200);
  check('opening your own starts at the front of the line', JSON.stringify(await where()) === '{"uid":"u1","i":0,"p":0}',
    JSON.stringify(await where()));
  // Sideways leaves this person. You have two of your own up and a swipe goes past both,
  // because that is what a sideways drag means in a story viewer: the rest of somebody's
  // is not something you drag through one at a time — that is what tapping is for.
  await swipe(-1);
  check('  a swipe across leaves this person, whatever else they posted',
    JSON.stringify(await where()) === '{"uid":"u3","i":0,"p":1}', JSON.stringify(await where()));
  check('    showing theirs, not yours', /kit only/i.test(await page.locator('#story .face').innerText()));
  await swipe(-1);
  check('  and on again into somebody whose stories were all watched',
    JSON.stringify(await where()) === '{"uid":"u2","i":0,"p":2}', JSON.stringify(await where()));
  await swipe(1);
  check('  swiping back reaches the person before',
    JSON.stringify(await where()) === '{"uid":"u3","i":0,"p":1}', JSON.stringify(await where()));
  await swipe(1);
  check('    and back again lands on the last of yours',
    JSON.stringify(await where()) === '{"uid":"u1","i":1,"p":0}', JSON.stringify(await where()));
  await swipe(1);
  check('  at the front of the line there is nothing before it, and it stays open',
    await page.locator('#story').isVisible()
    && JSON.stringify(await where()) === '{"uid":"u1","i":1,"p":0}', JSON.stringify(await where()));
  // Tapping is the thing that walks within a person, so it is what gets back to the front.
  await page.locator('#story .tap.back').first().click();
  await page.waitForTimeout(200);
  check('    which a tap backwards walks into',
    JSON.stringify(await where()) === '{"uid":"u1","i":0,"p":0}', JSON.stringify(await where()));

  // Another of the same person's arrives with nothing in between: no second pane, no
  // slide, no wait. Two of somebody's own stories are not two people, and sliding between
  // them said they were.
  await page.locator('#story .tap.fwd').first().click();
  await page.waitForTimeout(50);
  const within = await page.evaluate(() => ({
    panes: document.querySelectorAll('#strack .pane').length,
    armed: document.querySelector('#strack').dataset.armed || null,
    dx: getComputedStyle(document.querySelector('#strack')).getPropertyValue('--dx').trim(),
    at: S.story && { uid: S.story.uid, i: S.story.i },
  }));
  check('  another of the same person’s arrives at once, with nothing sliding',
    within.panes === 1 && !within.armed && JSON.stringify(within.at) === '{"uid":"u1","i":1}',
    JSON.stringify(within));

  // Crossing to somebody else is the one that moves, because that really is a journey.
  await page.locator('#story .tap.fwd').first().click();
  await page.waitForTimeout(60);
  const across = await page.evaluate(() => ({
    panes: document.querySelectorAll('#strack .pane').length,
    armed: document.querySelector('#strack').dataset.armed,
    dx: getComputedStyle(document.querySelector('#strack')).getPropertyValue('--dx').trim(),
    i: S.story.i, uid: S.story.uid,
  }));
  check('    but leaving them for the next person builds the pair and moves them',
    across.panes === 2 && across.armed === '1' && /^-\d+px$/.test(across.dx), JSON.stringify(across));
  check('      without having arrived yet', across.uid === 'u1', JSON.stringify(across));
  await page.evaluate(() => stepStory(1));   // a second tap mid-slide must not double-step
  await page.waitForTimeout(450);
  check('      and it arrives once, however many taps landed on the way',
    JSON.stringify(await where()) === '{"uid":"u3","i":0,"p":1}'
    && await page.evaluate(() => document.querySelectorAll('#strack .pane').length) === 1,
    JSON.stringify(await where()));

  // Motion turned off goes straight to the far side even across people.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#story .tap.back').first().click();
  await page.waitForTimeout(60);
  check('  with motion turned off even that lands at once',
    JSON.stringify(await where()) === '{"uid":"u1","i":1,"p":0}'
    && await page.evaluate(() => document.querySelectorAll('#strack .pane').length) === 1,
    JSON.stringify(await where()));
  await page.emulateMedia({ reducedMotion: null });

  // The bar is what moves when nothing else does, so it has to really run.
  const bar = await page.evaluate(() => {
    const b = document.querySelector('#story .bars i.now b');
    return b && { run: getComputedStyle(b).animationName, dur: b.style.getPropertyValue('--run') };
  });
  check('  and the bar on the one being watched fills as it runs',
    bar && bar.run === 'barfill' && /^\d+ms$/.test(bar.dur), JSON.stringify(bar));

  // Press and hold and it waits for you, which is the reason a card of text is not a race.
  await page.mouse.move(195, 400);
  await page.mouse.down();
  await page.waitForTimeout(320);
  const heldNow = await page.evaluate(() => ({ cls: $('#story').classList.contains('held'),
    play: getComputedStyle(document.querySelector('#story .bars i.now b')).animationPlayState }));
  check('  holding it stops the clock and the bar with it',
    heldNow.cls && heldNow.play === 'paused', JSON.stringify(heldNow));
  const wasAt = await where();
  await page.mouse.up();
  await page.waitForTimeout(250);
  check('    letting go starts it again, and the hold was not also a tap',
    JSON.stringify(await where()) === JSON.stringify(wasAt)
    && await page.evaluate(() => !$('#story').classList.contains('held')),
    `${JSON.stringify(wasAt)} -> ${JSON.stringify(await where())}`);

  // Off the end of the line is the way out, which is what it always was off the end of
  // one person's.
  await swipe(-1); await swipe(-1); await swipe(-1); await swipe(-1);
  check('  off the end of the line it closes',
    await page.locator('#story').isHidden() && await page.evaluate(() => S.story) === null);

  // Opened part way along, the line is still the whole line in both directions. Watching
  // all of that moved everybody into the seen half, so the line is put back the way it was
  // first: this is about where you come in, not about what the order does as you go.
  await page.evaluate(() => { S.seen = [201, 202]; render(); });
  await page.waitForTimeout(150);
  await page.evaluate(() => openStory('u2'));
  await page.waitForTimeout(200);
  check('opening somebody already watched starts on their first',
    JSON.stringify(await where()) === '{"uid":"u2","i":0,"p":2}', JSON.stringify(await where()));
  await swipe(1);
  check('  and swiping back from them reaches the person before',
    JSON.stringify(await where()) === '{"uid":"u3","i":0,"p":1}', JSON.stringify(await where()));
  await page.locator('#story .who .x').click();
  await page.waitForTimeout(250);

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

// An icon drawn at nothing by nothing is an icon nobody can press. This is the check that
// was missing when the emoji on two buttons was swapped for a drawing: the swap was tested
// for the absence of the emoji and not for the presence of anything in its place, so both
// buttons went invisible and stayed that way for three versions.
const drawn = async (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return 'missing';
  const svg = el.tagName === 'svg' ? el : el.querySelector('svg');
  if (!svg) return 'no svg';
  const r = svg.getBoundingClientRect();
  return r.width >= 12 && r.height >= 12 ? 'ok' : `${Math.round(r.width)}x${Math.round(r.height)}`;
}, sel);

await withPage(SIGNED_IN, async page => {
  await settle(page);
  check('the menu on your own post is drawn, not nothing', await drawn(page, '.post .head .more') === 'ok',
    await drawn(page, '.post .head .more'));
  check('  and so is the emoji button on a reply box', await drawn(page, '.post .cin .emo') === 'ok',
    await drawn(page, '.post .cin .emo'));
  check('  and the heart on a reply', await page.evaluate(() => {
    S.comments = [{id: 880, postId: S.posts[0].id, userId: 'u2', body: 'x', ts: Date.now()}]; render(); return true;
  }) && await drawn(page, '.c .clk') === 'ok', await drawn(page, '.c .clk'));

  // Every icon on a button, across the screens, at a size a thumb can find.
  const tiny = await page.evaluate(() => {
    const bad = [];
    for (const b of document.querySelectorAll('button')) {
      if (!b.offsetParent && b.offsetWidth === 0) continue;         // not on screen
      for (const svg of b.querySelectorAll('svg')) {
        const r = svg.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) bad.push(`${b.className || b.getAttribute('aria-label') || '?'} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return bad;
  });
  check('no button on the feed carries an icon too small to see', tiny.length === 0, tiny.join(' | '));
});

// The three dots on your own story: under the ✕, and only on your own.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  await page.evaluate(() => {
    S.stories = [{id: 70, u: 'u1', kind: 'text', body: 'mine', ts: Date.now() - 36e5, style: {}},
                 {id: 71, u: 'u2', kind: 'text', body: 'theirs', ts: Date.now() - 18e5, style: {}}];
    S.seen = []; render(); openStory('u1');
  });
  await page.waitForTimeout(400);
  check('your own story carries three dots', await page.locator('#story .who .bin').count() === 1);
  check('  drawn at a size worth pressing', await drawn(page, '#story .who .bin') === 'ok',
    await drawn(page, '#story .who .bin'));
  const place = await page.evaluate(() => {
    const d = document.querySelector('#story .who .bin').getBoundingClientRect();
    const x = document.querySelector('#story .who .x').getBoundingClientRect();
    return {below: d.top >= x.bottom - 2, aligned: Math.abs((innerWidth - d.right) - (innerWidth - x.right)) <= 8};
  });
  check('    under the ✕, not beside it', place.below, JSON.stringify(place));
  check('    and lined up with it', place.aligned, JSON.stringify(place));
  await page.locator('#story .who .bin').click();
  await page.waitForTimeout(400);
  const menu = await page.locator('#dlg .menu').innerText();
  check('  and it opens the menu', /edit/i.test(menu) && /delete/i.test(menu), menu);
  await page.evaluate(() => dlg());
  await page.locator('#story .who .x').click();
  await page.waitForTimeout(300);

  await page.evaluate(() => openStory('u2'));
  await page.waitForTimeout(400);
  check("somebody else's story has no dots on it", await page.locator('#story .who .bin').count() === 0);
  check('  but still has the way out', await page.locator('#story .who .x').count() === 1);
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
  // openSettings() asks the browser what the real state is and overwrites whatever was
  // set, so land on the screen first and say what to draw after.
  await page.evaluate(() => { S.tab = 'profile'; S.open = null; S.settings = true; S.push = 'on'; render(); });
  await page.waitForTimeout(300);
  const row = page.locator('#app .li:has-text("Notifications")');
  check('Settings can turn notifications off without leaving the app',
    await row.locator('.sw.on').count() === 1 && /disablePush/.test(await row.getAttribute('onclick') || ''));
  const txt = await page.locator('#app .pushabout').innerText();
  check('  saying what it covers rather than just "on"',
    /friend request/i.test(txt) && /comment on your proof/i.test(txt) && /like on your proof/i.test(txt), txt);

  await page.evaluate(() => { S.push = 'off'; render(); });
  await page.waitForTimeout(200);
  const off = await page.locator('#app .pushabout').innerText();
  const offRow = page.locator('#app .li:has-text("Notifications")');
  check('  and still saying it when they are off, so you know what you are missing',
    /friend request/i.test(off) && await offRow.locator('.sw:not(.on)').count() === 1
    && /enablePush/.test(await offRow.getAttribute('onclick') || ''), off);

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

// A profile picture is taken by the same camera, and goes straight into the circle it is
// about to become. The camera's own review would be a second look at the same thing.
await withPage(NO_WHEEL, async page => {
  await settle(page);
  await page.evaluate(() => { go('profile'); openSettings(); });
  await page.waitForTimeout(300);
  await page.locator('.li:has-text("Name, picture and bio")').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Camera")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  check('the profile camera opens on the front one', await page.evaluate(() => camFacing) === 'user',
    await page.evaluate(() => camFacing));
  check('  with nothing to switch to, because a profile picture is never a clip',
    await page.locator('#cammode').isHidden() && await page.evaluate(() => shooting()) === true);

  await page.locator('#camgo').click();
  await page.waitForFunction(() => document.querySelector('#crop').open, null, { timeout: 8000 }).catch(() => {});
  check('  the shutter goes straight to the crop, not to a review',
    await page.evaluate(() => $('#crop').open) === true && await page.locator('#camrev').isHidden());
  const c = await page.evaluate(() => C && {w: C.natW, h: C.natH, scale: C.scale, x: C.x, y: C.y, from: C.from});
  check('    holding the picture that was just taken', c && c.w > 0 && c.h > 0, JSON.stringify(c));
  check('    zoomed out, centred, and knowing it can go back to the camera',
    c && c.scale === 1 && c.x === 0 && c.y === 0 && c.from === 'cam', JSON.stringify(c));
  check('    with Retake rather than Cancel, because the shot is what was wrong',
    /Retake/.test(await page.locator('#cropback').innerText()));

  // Dragged, zoomed, and taken: what comes out is a square the size the avatar is stored
  // at, whatever shape went in.
  await page.evaluate(() => { cropSet(2); cropMove(40, -20); });
  await page.locator('#crop button:has-text("Use photo")').click();
  await page.waitForTimeout(400);
  const a = await page.evaluate(async () => {
    if (!avatarFile) return null;
    const im = await createImageBitmap(avatarFile);
    return {name: avatarFile.name, type: avatarFile.type, size: avatarFile.size, w: im.width, h: im.height};
  });
  check('  and using it leaves a square ready to save', a && a.w === 512 && a.h === 512
    && a.type === 'image/jpeg' && a.size > 1024, JSON.stringify(a));
  check('    with the crop put away behind it', await page.evaluate(() => !$('#crop').open && C === null));
  check('    and shown back in the form at the size it will be seen at',
    await page.locator('#avprev .av img').count() === 1);

  // The camera remembers what it was opened for. It used to be a variable somebody set
  // beforehand, and one left saying 'avatar' would open the next post in avatar mode.
  await page.evaluate(() => { dlg(); closeSettings(); });
  await page.waitForTimeout(200);
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForFunction(() => !$('#camgo').disabled, null, { timeout: 10000 });
  check('  and a post opened afterwards is a post again, on video',
    await page.evaluate(() => camFor) === 'post' && await page.evaluate(() => shooting()) === false
    && await page.locator('#cammode').isVisible());
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

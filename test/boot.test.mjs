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
// headers and the boundary that follows.
function filePart(buf, contentType) {
  const b = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!b) return null;
  const mark = Buffer.from(`--${b[1] || b[2]}`);
  const start = buf.indexOf(Buffer.from('\r\n\r\n'), buf.indexOf(Buffer.from('Content-Type: video')));
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
const browser = await chromium.launch();

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failed++;
};

// Every case gets a clean context: the app keeps its session in localStorage.
// With a mode, the stub is installed and the page is loaded ready to inspect. With null,
// the real library is used and the case navigates itself, so it can add routes first.
async function withPage(mode, body) {
  const ctx = await browser.newContext();
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

// The caption used to be hidden the moment playback started, along with the play button
// and the gradient. It is the one thing on that overlay worth reading while watching.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const cap = page.locator('.reel .cap').first();
  check('a post shows its caption', await cap.isVisible() && (await cap.innerText()).includes('fifty in the bag'));
  await page.locator('.reel').first().evaluate(el => el.classList.add('playing'));
  check('  and keeps it once the video is playing', await cap.isVisible());
  // Native controls sit at the bottom of the video, so the caption has to move off them.
  const [reel, box] = await Promise.all([
    page.locator('.reel').first().boundingBox(),
    cap.boundingBox(),                                     // null once it is hidden
  ]);
  const clearance = box && reel ? reel.y + reel.height - (box.y + box.height) : -1;
  check('  clear of the native controls', clearance >= 40,
    box ? `only ${Math.round(clearance)}px above the bottom` : 'the caption is not on screen at all');
});

// A post with no caption should not leave an empty overlay floating over the video.
await withPage({ ...SIGNED_IN, noCaption: true }, async page => {
  await settle(page);
  check('a post without a caption still renders', await page.locator('.reel').count() >= 1);
  check('  but with no empty caption overlay', await page.locator('.reel .ov.bot').count() === 0);
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

  const ticks = page.locator('.tick');
  check('  with a day to tick for each day of the cycle so far', await ticks.count() >= 1, `${await ticks.count()} ticks`);
  await ticks.last().click();
  await page.waitForTimeout(400);
  check('  ticking a day records it', await page.locator('.tick.on').count() === 1);
  await page.locator('.tick.on').click();
  await page.waitForTimeout(400);
  check('  and unticking takes it back off', await page.locator('.tick.on').count() === 0);
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

  // Finishing it keeps the streak: a spin for yesterday's cycle with its day ticked.
  const kept = await page.evaluate(() => {
    const w = S.wheels[0], y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const c = cycleOf(w, y);
    S.spins = [...S.spins, {id: 99, wheel_id: w.id, user_id: 'u2', cycle: c, results: [], days_required: 1}];
    S.ticks = [{spin_id: 99, day: y}];
    return streak(S.groups[0], 'u2');
  });
  check('  and finishing the challenge keeps it', kept >= 1, `streak ${kept}`);

  // The quota chips and the completion rate stay about the quota alone.
  const rate = await page.evaluate(() => window.rate(S.groups[0], 'u2').n);
  check('  while the completion rate still counts quota days only', rate === 3, `${rate} days`);
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

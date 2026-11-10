// node test/feature-graphic.mjs    redraw native/store/google-play/feature-graphic.jpg
//
// Google Play's feature graphic, 1024x500: the mascot (MascotDone, light) beside the Quota
// mark and "Proof or it didn't happen.", drawn as a page with the app's own fonts and logo,
// so it changes when they do rather than being a picture nobody can remake.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), OUT = join(ROOT, 'native/store/google-play/feature-graphic.jpg');
const html = readFileSync(`${ROOT}/app/index.html`, 'utf8');
const icon = /const ICON = `([^`]+)`/.exec(html)[1];
const mascot = readFileSync(`${ROOT}/native/ios/App/QuotaWidget/Assets.xcassets/MascotDone.imageset/mascot-done-light.png`).toString('base64');
const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@600&family=Plus+Jakarta+Sans:wght@700;800&display=swap">
<style>
html,body{margin:0;width:1024px;height:500px;overflow:hidden}
body{background:#eaf3e8;position:relative;font-family:'Plus Jakarta Sans',sans-serif;color:#0b0c0e}
.art{position:absolute;left:330px;top:-20px;width:700px;height:700px;background:url(data:image/png;base64,${mascot}) center/cover}
.copy{position:absolute;left:72px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;width:520px}
.logo{display:flex;align-items:center;gap:16px;font-family:Oswald,sans-serif;font-weight:600;font-size:46px;letter-spacing:.09em}
.logo svg{width:62px;height:62px;border-radius:14px}
h1{margin:30px 0 0;font-size:62px;line-height:1.04;font-weight:800;letter-spacing:-.02em}
h1 span{color:#0b5a34}
</style></head><body><div class="art"></div>
<div class="copy"><div class="logo">${icon.replace('<svg ', '<svg aria-hidden="true" ')}QUOTA</div><h1>Proof or it<br><span>didn't happen.</span></h1></div>
</body></html>`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
// The fonts through curl, which uses the proxy where the browser does not (as in screenshots.mjs).
await p.route(/fonts\.(googleapis|gstatic)\.com/, r => {
  try { const body = execFileSync('curl', ['-sS', '-A', UA, r.request().url()], { maxBuffer: 1 << 24 });
    r.fulfill({ body, contentType: /googleapis/.test(r.request().url()) ? 'text/css' : 'font/woff2' }); } catch { r.abort(); }
});
await p.setContent(page, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: OUT, type: 'jpeg', quality: 92 });
await b.close();
console.log('wrote', OUT);

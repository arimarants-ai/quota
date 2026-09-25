// node test/crop.test.mjs
//
// The profile-picture crop is the other piece of index.html that is pure arithmetic with
// no DOM in it, and it fails the same quiet way the word filter does: a wrong rectangle
// saves an off-centre face and nothing on screen says anything went wrong. So it is
// lifted straight out of the page, between the crop:start and crop:end markers, rather
// than copied here where it would drift the first time the framing changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const src = (html.match(/\/\/ crop:start[\s\S]*?\/\/ crop:end/) || [])[0];
assert.ok(src, 'index.html has no crop:start/crop:end block. If the crop maths moved, move these markers with it.');
const { cropRect, cropClamp, cropK, mirrorShot } = new Function(`${src}\nreturn {cropRect, cropClamp, cropK, mirrorShot};`)();

const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-6, `${why}: got ${a}, expected ${b}`);

// 1. Zoomed all the way out, a square picture is the whole square. Nothing is cut, and
// the source rectangle is the file itself.
{
  const r = cropRect(1000, 1000, 300, 1, 0, 0);
  near(r.sx, 0, 'square sx'); near(r.sy, 0, 'square sy'); near(r.sw, 1000, 'square sw');
}

// 2. Zoomed out, a landscape picture is cropped to its own height, centred. This is the
// one that goes wrong if base is taken off the long side instead of the short one.
{
  const r = cropRect(1600, 900, 300, 1, 0, 0);
  near(r.sw, 900, 'landscape takes the short side');
  near(r.sx, 350, 'landscape is centred left to right');
  near(r.sy, 0, 'landscape has nothing to centre vertically');
}

// 3. And a portrait one the other way round.
{
  const r = cropRect(900, 1600, 300, 1, 0, 0);
  near(r.sw, 900, 'portrait takes the short side');
  near(r.sx, 0, 'portrait has nothing to centre left to right');
  near(r.sy, 350, 'portrait is centred top to bottom');
}

// 4. Zooming in halves what is visible, still around the middle.
{
  const r = cropRect(1000, 1000, 300, 2, 0, 0);
  near(r.sw, 500, 'twice the zoom shows half the picture');
  near(r.sx, 250, 'and stays in the middle');
}

// 5. Dragging right moves the window left: what you pull towards you is what you see.
{
  const k = cropK(1000, 1000, 300, 2);
  const r = cropRect(1000, 1000, 300, 2, 30, 0);
  near(r.sx, 250 - 30 / k, 'dragging right shows what was to the left');
}

// 6. Zoomed out there is nowhere to go on the short side, and a fixed amount on the long
// one. This is what stops a corner of nothing appearing in somebody's avatar.
{
  const c = cropClamp(1600, 900, 300, 1, 999, 999);
  near(c.y, 0, 'no room to move on the short side');
  near(c.x, (1600 * (300 / 900) - 300) / 2, 'as far as the long side goes, and no further');
}

// 7. The property that matters, over shapes and zooms picked to be awkward: however far
// it is dragged, the rectangle that gets drawn is inside the picture. If this ever fails,
// drawImage is reading off the edge and the avatar has a transparent band down one side.
for (const [w, h] of [[1000, 1000], [1600, 900], [900, 1600], [4032, 3024], [640, 480], [2, 3000]]) {
  for (const scale of [1, 1.0001, 1.37, 2, 3.5, 6]) {
    for (const [x, y] of [[0, 0], [1e6, 1e6], [-1e6, -1e6], [37, -12], [-1e6, 1e6]]) {
      const box = 317;                     // a real box is a vw, so never a round number
      const c = cropClamp(w, h, box, scale, x, y);
      const r = cropRect(w, h, box, scale, c.x, c.y);
      const why = `${w}x${h} @${scale} (${x},${y}) -> ${JSON.stringify(r)}`;
      assert.ok(r.sx >= -1e-6 && r.sy >= -1e-6, `reads off the top or left: ${why}`);
      assert.ok(r.sx + r.sw <= w + 1e-6, `reads off the right: ${why}`);
      assert.ok(r.sy + r.sw <= h + 1e-6, `reads off the bottom: ${why}`);
      assert.ok(r.sw > 0, `empty rectangle: ${why}`);
    }
  }
}

// 8. Clamping something already inside leaves it exactly where it was — a drag that
// nudges by a pixel must not be snapped anywhere.
{
  const c = cropClamp(1000, 1000, 300, 2, 40, -25);
  near(c.x, 40, 'an allowed x is left alone'); near(c.y, -25, 'an allowed y is left alone');
}

// 9. Which way round a still comes out. The front camera shows you a mirror, and a
// profile picture has to be the face you were looking at while you framed it — undoing
// that flip is the whole complaint. Proof is of the world and is never mirrored, whichever
// camera took it.
assert.equal(mirrorShot('avatar', true), true, 'a selfie keeps the mirror it was framed in');
assert.equal(mirrorShot('avatar', false), false, 'the back camera shows no mirror to keep');
assert.equal(mirrorShot('post', true), false, 'proof is of the world, not of the mirror');
assert.equal(mirrorShot('story', true), false, 'and so is a story');

console.log('crop ok');

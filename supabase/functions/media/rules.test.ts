// node --experimental-strip-types supabase/functions/media/rules.test.ts
//
// The rules R2 is guarded by are the storage policies the Supabase buckets had. These are
// the cases where a slip would quietly widen them: someone else's group, someone else's
// file, a path that climbs out of where it was meant to be.
import { canDelete, canView, cleanKey, kindOf, planUpload, posterOf, PROOF_MAX, STORY_MAX,
  viewWindow, VIEW_SECONDS } from './rules.ts';

let failed = 0;
const ok = (cond: boolean, what: string, detail?: unknown) => {
  console.log(`  ${cond ? 'ok ' : 'NOT OK'} ${what}${cond || detail === undefined ? '' : `  <- ${JSON.stringify(detail)}`}`);
  if (!cond) failed++;
};

const ME = '11111111-1111-1111-1111-111111111111', THEM = '22222222-2222-2222-2222-222222222222';
const mine = `7/${ME}/1789575067364.mp4`, theirs = `7/${THEM}/1789575067364.mov`, elsewhere = `9/${THEM}/1.mp4`;
const groups = new Set([7]);

// members watch proof: is_member(folder[1]), whoever posted it.
ok(canView(mine, groups, new Set()), 'your own clip in your group');
ok(canView(theirs, groups, new Set()), 'somebody else\'s clip in a group you are in');
ok(canView(posterOf(theirs), groups, new Set()), 'and its still, which sits in the same folder');
ok(!canView(elsewhere, groups, new Set()), 'not a clip in a group you are not in');
ok(!canView(`7/${ME}`, groups, new Set()), 'not a folder with no file in it');
ok(!canView(`x7/${ME}/1.mp4`, groups, new Set()), 'not a group folder that is not a number');
ok(!canView(`7/../9/${THEM}/1.mp4`, groups, new Set()), 'not a path that climbs out');
ok(!canView(`/7/${ME}/1.mp4`, groups, new Set()), 'not an absolute path');
ok(!canView('', groups, new Set()), 'not nothing');

// A story is watchable exactly when its row is, which the caller works out as the person.
const story = `stories/${THEM}/1.mp4`;
ok(canView(story, new Set(), new Set([story])), 'a story whose row you can read');
ok(!canView(story, groups, new Set()), 'not a story whose row you cannot, whatever groups you are in');
ok(kindOf(`stories/${THEM}/1.mp4`)?.bucket === 'stories', 'stories/ is the stories bucket');

// delete own proof: folder[2] = you. Being the group's maker is not enough (see rules.ts).
ok(canDelete(mine, ME), 'your own clip');
ok(canDelete(posterOf(mine), ME), 'your own still');
ok(!canDelete(theirs, ME), 'not somebody else\'s, even in your group');
ok(canDelete(`stories/${ME}/1.jpg`, ME), 'your own story file');
ok(!canDelete(`stories/${THEM}/1.jpg`, ME), 'not somebody else\'s story');
ok(!canDelete(`${ME}/7/1.mp4`, ME), 'not a proof path with you in the wrong folder');

// Upload: the key is built here, from who is asking and when.
const up = planUpload({ group_id: 7, ext: 'mp4', contentType: 'video/mp4', size: 2_000_000, thumbSize: 40_000 }, ME, 1789575067364);
ok(typeof up === 'object' && up.key === `7/${ME}/1789575067364.mp4` && up.group === 7, 'a clip goes in your folder in that group', up);
ok(typeof up === 'object' && up.thumb?.key === `7/${ME}/1789575067364.mp4.jpg`, 'with its still beside it, named the way the app names it', up);
const pic = planUpload({ group_id: 7, ext: 'JPG', contentType: 'image/jpeg', size: 300_000, thumbSize: 1 }, ME, 5);
ok(typeof pic === 'object' && pic.key === `7/${ME}/5.jpg` && pic.thumb === null, 'a picture is its own still', pic);
const st = planUpload({ story: true, ext: 'mp4', contentType: 'video/mp4', size: 1000, group_id: 7 }, ME, 5);
ok(typeof st === 'object' && st.key === `stories/${ME}/5.mp4` && st.group === null, 'a story goes under stories/ in your folder, whatever group is named', st);
ok(typeof planUpload({ group_id: 7, ext: 'mp4', contentType: 'video/mp4', size: PROOF_MAX + 1 }, ME, 5) === 'string', 'nothing over the bucket\'s 50 MB');
ok(typeof planUpload({ story: true, ext: 'mp4', contentType: 'video/mp4', size: STORY_MAX + 1 }, ME, 5) === 'string', 'nothing over the stories bucket\'s 25 MB');
ok(typeof planUpload({ group_id: 7, ext: 'mp4', contentType: 'video/mp4' }, ME, 5) === 'string', 'no size, no URL: the size is what gets signed');
ok(typeof planUpload({ group_id: 7, ext: 'html', contentType: 'text/html', size: 10 }, ME, 5) === 'string', 'not a web page');
ok(typeof planUpload({ group_id: 7, ext: 'mp4', contentType: 'text/html', size: 10 }, ME, 5) === 'string', 'not a web page called .mp4');
ok(typeof planUpload({ story: true, ext: 'gif', contentType: 'image/gif', size: 10 }, ME, 5) === 'string', 'stories take only what their bucket took');
ok(typeof planUpload({ group_id: '7/../9', ext: 'mp4', contentType: 'video/mp4', size: 10 }, ME, 5) === 'string', 'a group that is not a number');
ok(typeof planUpload({ group_id: 7, ext: 'mp4', contentType: 'video/mp4', size: 10, thumbSize: 9e9 }, ME, 5) === 'string', 'a still the size of a film');
ok(cleanKey(`7/${ME}/1.mp4`) && !cleanKey(`7/${ME}/1.mp4?x=1`) && !cleanKey(`7//1.mp4`), 'keys are plain names and nothing else');

// One URL per file per half hour, each good for at least the hour the app counts on.
const t = Date.parse('2026-10-13T20:47:12Z'), w = viewWindow(t), w2 = viewWindow(t + 60_000);
ok(w.signedAt.getTime() === w2.signedAt.getTime(), 'two asks a minute apart sign the same moment, so the URL is the same');
ok(w.until - t >= VIEW_SECONDS * 1000, 'and it lasts at least an hour from when it was asked for', { left: (w.until - t) / 1000 });

if (failed) { console.error(`FAIL: ${failed} media rule check(s)`); process.exit(1); }
console.log('PASS: R2 is guarded by the rules the buckets had');

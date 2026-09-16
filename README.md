# Quota

Daily goals with friends. Proof or it didn't happen.

One static page (`index.html`) talking straight to Supabase (accounts, database, video storage). Hosted on Vercel.

## One-time setup

1. **Supabase project** — at supabase.com create a project (free tier). Pick a strong database password and save it somewhere.
2. **Run the schema** — in the Supabase dashboard open *SQL Editor*, paste the whole of `schema.sql`, click *Run*. It should finish with no errors.
3. **Turn off email confirmation** — *Authentication → Providers → Email* → switch **Confirm email** off, save. (Accounts use usernames, not real emails.)
4. **Copy the keys** — *Project Settings → API*: copy the **Project URL** and the **anon public** key.
5. **Paste them** into the top of `index.html` (`SUPABASE_URL`, `SUPABASE_KEY`).
6. **Deploy** — push to GitHub (Vercel redeploys automatically) or run `npx vercel --prod`.

Then open the Vercel URL on your phone, *Share → Add to Home Screen*, and it behaves like an app.

## Updating the database for the redesign

The redesign adds comments. In Supabase → SQL Editor, paste and run the block at the bottom of `schema.sql` (from the line `-- v2 (redesign)` down). Until then the app shows "Comments are off".

## Branches

- `main` is the published app (what the live URL serves).
- `redesign` is the unpublished work. Merge it into `main` and deploy to publish.

## Installing it as an app

The app is a PWA, so it installs to a phone home screen with no app store.
On iPhone: open the site in **Safari**, tap Share, then "Add to Home Screen".
A one-time banner explains this to iOS Safari visitors automatically.

PWA files: `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`.
The icon is the logo on a white tile with a hairline edge, so it still reads as an
app tile on a pale wallpaper rather than a mark floating on nothing. The ring runs
`#0B5A34` where the arc starts to `#2FD36F` where it stops: the icon cannot change
with a streak, so it wears a finished one. A linear gradient goes one way across a
box and a ring goes round, so the arc is cut into segments that each carry their
slice of the ramp — which is why both SVGs are generated rather than hand-written.
`icon-src.svg` holds that composition. Render at 512 and downscale — `qlmanage`
pads the canvas with white below about 256px, so never render small directly:

```bash
mkdir -p /tmp/ql && qlmanage -t -s 512 -o /tmp/ql "$PWD/icon-src.svg"   # needs an absolute path
cp /tmp/ql/icon-src.svg.png icon-512.png
sips -z 192 192 icon-512.png --out icon-192.png
sips -z 180 180 icon-512.png --out apple-touch-icon.png
```

The same mark is drawn three more times and they have to stay in step: `ICON` in
`index.html` (the loading screen and the signed-out screens) and the `rel=icon`
data URI (the browser tab) carry a shorter eight-segment version of it.

`maskable-src.svg` is the same mark scaled to 0.70 so it survives Android cropping
it to a circle or a squircle; render it the same way into `icon-maskable-512.png`
and downscale to 192.

After changing any of these, bump `VERSION` in `sw.js` or installed apps keep
the old icons from cache.

The four `screenshot-*.png` in `manifest.json` are what Chrome and PWABuilder put
on the install prompt, so they have to look like the app that is actually shipping:

```bash
node test/screenshots.mjs
```

That renders them from the real page against the test stub. A screenshot taken on a
phone, of a real run, is better — this is the floor, not the ceiling.

The service worker caches only static assets. Everything from Supabase (sign-in,
database, video upload, signed video URLs) always goes to the network, so the
worker can never serve a stale feed or a stale video.

The Supabase library is vendored under `vendor/` and precached rather than pulled
from a CDN. An installed app is often opened before the phone has a connection, and
every line of `index.html` depends on that file: when it did not arrive, the page
came up blank with nothing on it. See `vendor/supabase-js-2.49.4/README.md` for how
to move to a newer version.

## When notifications stop

Nothing anywhere says so. `pg_net` sends the call and throws the answer away, so a push
that never went out looks exactly like one that did. The answers are kept for a while
though, and they say which of the two failures it is:

```sql
select created, status_code, content from net._http_response order by created desc limit 10;
```

| What comes back | Where it stopped | What it means |
| --- | --- | --- |
| `403 forbidden` | Inside the function | The secret the trigger sent is not the secret the function holds. |
| `401 UNAUTHORIZED_NO_AUTH_HEADER` | Supabase's gateway, before the function | That function has **Verify JWT** switched on, so the call never arrives. |
| `200` | Nowhere | It went. |

Rows landing exactly on the hour are the `wheelday` cron; anything else is somebody
posting, commenting, liking or inviting.

### 403: the secret

Every trigger calls the `notify` function with a shared secret. Older blocks in
`schema.sql` carry that secret as the literal placeholder `'<HOOK_SECRET>'`, so re-running
one of them — which is what happens when a later feature block gets pasted in — replaces a
working trigger with one that sends the string `<HOOK_SECRET>`. The same 403 comes back if
`HOOK_SECRET` was never set on the function at all, because an unset one can never match.
So set both ends explicitly, to the same value:

1. Edge Functions → Secrets → `HOOK_SECRET`.
2. `alter database postgres set app.hook_secret = 'that same value';`
3. Run the v16 block at the bottom of `schema.sql`.
4. In a **new** SQL session: `select coalesce(current_setting('app.hook_secret', true), '') <> '' as secret_is_set;`

### 401: the gateway

`wheelday` guards itself with the same shared secret `notify` does, so it wants the same
setting: Edge Functions → `wheelday` → turn **Verify JWT** off (`--no-verify-jwt` if you
deploy from a terminal). With it on, the gateway rejects the cron job before the function
runs, which is why spin-day reminders can be dead while everything else is merely wrong.

To check either from outside, without waiting for someone to post:

```bash
curl -i -X POST https://<project>.supabase.co/functions/v1/notify -d '{}'
# 403 forbidden  -> deployed, running, and guarding itself. Good.
# 401 ...        -> Verify JWT is on; the gateway is answering, not the function.
```

The old check, for whether the placeholder is what is in the trigger:

```sql
-- Is the placeholder still sitting in the trigger?
select prosrc like '%<HOOK_SECRET>%' as placeholder_left_in
from pg_proc where proname = 'notify_hook';

-- What did the last few calls actually come back with? 403 means the secret is wrong.
select created, status_code, content from net._http_response order by created desc limit 10;
```

The fix, and the reason it cannot happen again, is the v16 block at the bottom of
`schema.sql`: the secret moves out of the function body and into a row in `private.config`,
which re-running the block cannot touch, and a missing one is written to the Postgres log
instead of being swallowed. Run the block, then write the value once:

```sql
insert into private.config (key, value) values ('hook_secret', 'the-real-secret')
  on conflict (key) do update set value = excluded.value;

select left(value, 6) || '…' as hook_secret from private.config where key = 'hook_secret';
```

It has to match the `HOOK_SECRET` set on the edge functions. That one is project-wide, so
it covers `notify` and `wheelday` together. Supabase masks it after it is saved, so if you
cannot read it back, overwrite both ends with a new value rather than trying to recover it.

A database setting would read better than a table, but `alter database ... set` on a custom
parameter needs superuser and Supabase does not hand that out — it fails with
`permission denied to set parameter`.

## When the app cannot load

An installed app can sit closed for days, so its access token has almost always
expired by the time it is opened again, and the first thing it does is talk to the
network. All three of those go wrong far more often than they do in a browser tab,
so nothing in the load path is allowed to leave an empty page behind:

- The page paints a splash before the first request, so a slow or hung session read
  shows something rather than nothing.
- An expired token gets one forced `refreshSession()` and one retry. If that fails
  the app falls back to the sign-in screen instead of dying half-loaded.
- Anything else lands in the banner at the bottom of the screen with a Retry button.
  Errors during load never use `alert()`: a modal you dismiss into a blank page is
  what the old behaviour amounted to.
- `onAuthStateChange` keeps the UI honest when the library ends the session on its own.

## Going into something, and coming back out

A profile, a group, Settings and the three legal documents all open *over* whatever screen
you were on. Every one of them needs a way back that puts you where you were, and a move
you can actually see — redrawing `#app` in place and calling it a transition is what made
the whole thing feel like nothing had happened.

**The move.** Two fixed layers, `#ghost` and `#dim`, sit either side of `#app` depending on
which way you are going. The screen coming in travels the full width; the one it covers
eases back 22px behind a dim. Both layers are `position: fixed`, so a screen sliding a whole
width sideways can never widen the page or move where the document is scrolled to.

The ghost holds a screen held still, pulled up by however far it was scrolled so it shows
exactly the slice that was on screen. The screen being *left* hands over its real nodes
rather than a copy of its markup — a second copy of a live screen means two elements with
the same id and two of every class, and that is the kind of duplication that is invisible
until something queries the document and finds the screen on its way out. (`watchClips()`
did exactly that, and is now scoped to `#app`.) Moving the nodes also keeps a playing clip
playing on the way past. The screen being dragged *towards* has nothing to hand over,
because it does not exist yet, so that one really is markup — which is what `screenHTML()`
is for: it builds any screen without putting it anywhere.

**The drag.** Pull left-to-right from anywhere on a stacked screen and it follows your
finger with the destination already behind it. Past a third of the width, or a flick over
0.35px/ms, it carries on; under that it falls back, which has to be as smooth as leaving or
the gesture feels like a trap. `backAction()` decides what the gesture takes off, in the
order `render()` draws them, so the two cannot disagree.

**The back button** is a circle with an arrow in it. The muted "‹ Back" text link that used
to be there was missed so reliably that people thought there was no way back at all.

**Where you were** is remembered on `backY` and put back twice — once immediately, once on
the next frame, because a long feed has not finished laying itself out when the first one
runs. The position is read *before* the screen is redrawn, since rebuilding `#app` changes
how tall the page is and the browser clamps the scroll to fit before anything could read it.

`personView()` draws the same screen for the Profile tab and for a profile opened over
something else. `S.who` is what tells them apart: set means it was opened over something, so
it gets the back button instead of the header with the gear.


A profile, a group, Settings and the three legal documents all open *over* whatever screen
you were on rather than replacing it, so every one of them needs a way back that returns
you to where you were. That is one pair of functions, `stackOn()` and `stackOff()` in
`index.html`: going in pushes the scroll position onto `backY` and slides the new screen
in, coming out pops it, slides back, and puts you where you were. Switching tabs empties
the stack, because a tab is not a way back out of anything.

The position is read *before* the screen is redrawn — rebuilding `#app` changes how tall
the page is, and the browser clamps the scroll to fit before anything could read it — and
put back twice, once immediately and once on the next frame, because a long feed has not
finished laying itself out when the first one runs.

`personView()` draws the same screen for the Profile tab and for a profile opened over
something else. `S.who` is what tells them apart: set means it was opened over something,
so it gets a back button instead of the header with the gear.

## Stories are one line, not one person

`storyPeople()` decides the order once and both the row and the viewer use it: yours first,
then anyone with something unseen, then everyone you are already caught up with. Somebody
already watched stays in the line — being able to go back to them is the point.

The viewer takes a snapshot of that line when it opens and holds it. Working it out again
on every step would reshuffle it underneath you, because watching somebody moves them out
of the unseen half and the next swipe would land on a stranger.

`neighbour(d)` says what one step along the line *is* without going there, and `stepStory()`
goes there. Asking rather than doing is what lets a swipe put the answer on screen beside
the story you are still holding: the moment a drag turns out to be sideways, `armSlide()`
builds that neighbour with the same `paneHTML()` the current one was built with — a
neighbour drawn by different code is a neighbour that looks subtly wrong for the half second
it is up — and drops it into the strip. Then the pair of them move with your finger.

Nothing at either end of the line: it pulls back at a third of the distance and lets go,
rather than tearing off the edge. Thrown forward past the last story is still the way out,
the same as tapping past it.

Swiping and tapping are the same step. The tap zones cover the whole face, so a swipe that
starts and ends inside one would step twice — once on the swipe and again on the click the
browser sends afterwards — and the click is swallowed rather than the zones made smaller,
because tapping to step is how a story has always worked.


`storyPeople()` decides the order once and both the row and the viewer use it: yours
first, then anyone with something unseen, then everyone you are already caught up with.
Somebody already watched stays in the line — being able to go back to them is the point.

The viewer takes a snapshot of that line when it opens and holds it. Working it out again
on every step would reshuffle it underneath you, because watching somebody moves them out
of the unseen half and the next swipe would land on a stranger.

`stepStory()` walks it end to end: off the last of somebody's stories is the next person's
first unseen, off the front is the one before's last, off the end of the line is the way
out. Swiping and tapping are the same step. The tap zones cover the whole face, so a swipe
that starts and ends inside one would step twice — once on the swipe and again on the click
the browser sends afterwards — and the click is swallowed rather than the zones made
smaller, because tapping to step is how a story has always worked.

## The profile picture

Both ways in — **Camera** and **Choose a file** — end at the same circular crop sheet
(`#crop` in `index.html`), and nothing is uploaded until Save. The circle you frame it in
is the circle it ends up in, so it is the preview as well; there is no second confirmation
screen after it.

Drag to move, pinch or scroll or use the slider to zoom. Panning is clamped so an edge can
never be dragged inside the circle. What is saved is a **512px square JPEG**, not a circle:
`.av` is round in CSS, and a picture with transparent corners is a PNG several times the
size for something nobody ever sees.

The camera is the same one the rest of the app uses, opened with `openCam('avatar')`. For a
profile picture it opens on the front camera (without changing which way the camera opens
for a post, which is remembered separately), the video/photo switch is hidden because a
profile picture is never a clip, and the shutter goes straight to the crop rather than to
the camera's own review.

**It does not flip your face.** The front camera preview is mirrored, the way every phone
camera shows it. Proof and stories are saved unmirrored — that picture is of the world. A
profile picture is of you, and what you framed it against was the mirror, so the flip is
kept and the face that lands is the one you were looking at. `mirrorShot()` is the one line
that decides this.

`test/crop.test.mjs` lifts the maths out of `index.html` between the `crop:start` and
`crop:end` markers and runs it: the source rectangle for square, landscape and portrait
pictures, dragging, the zoom floor, the mirror rule, and a property check over awkward
shapes and zooms that the drawn rectangle is always inside the picture. A rectangle that
reads off the edge puts a transparent band down the side of somebody's avatar, and nothing
on screen would say so. `test/boot.test.mjs` drives the whole thing against a real camera.

## What people agree to, and what they cannot type

Three documents live in `index.html` as the `LEGAL` object — a privacy policy, a note on
cookies and local storage, and community guidelines. They are in the page rather than on
pages of their own because the app is one file behind a service worker: a separate page
would be another thing to precache, style, and get wrong offline.

They are reachable from the welcome screen, from the signup form, and from Settings.
Signing up requires ticking a box, and the tick is written to `profiles.terms_accepted_at`
along with `terms_version`, so it is always possible to say which wording somebody agreed
to. **This needs the v25 block of `schema.sql`.** Until it is run the columns do not exist,
and the app deliberately treats that as nobody being held to anything rather than putting
an accept screen nobody can dismiss in front of every account.

Anyone who signed up before v25 ran has `null` there and meets a one-time accept screen on
their next open. If a document changes in a way that matters, bump `TERMS_VERSION` in
`index.html`.

### The word filter

`badWords()` in `index.html` refuses slurs, sexually explicit words and strong swearing
anywhere text is typed — captions, comments, stories, group names, metrics, bios,
usernames. Mild swearing (damn, hell, crap) is deliberately allowed.

It is enforced in **one** place: a `submit` listener on `document` in the capture phase,
which runs before any form's own `onsubmit` and stops it ever being reached. Adding a form
does not mean remembering to add a check. The story editor is the only text box that is not
in a form, so `postStory()` calls the check itself.

Two kinds of match, because one rule cannot serve both. The `any` lists are looked for
anywhere inside what was typed, which is what catches a username like `fuckyou123`; every
word in them is a string no ordinary English word contains. The `word` lists are matched
whole, because each entry sits inside something innocent — assess, raccoon, analysis,
Pakistan, peacock, flame retardant. `NOTBAD` is the short list of place names that contain
a banned word outright, Scunthorpe being the famous one.

`test/language.test.mjs` lifts the filter straight out of `index.html` — between the
`filter:start` and `filter:end` markers — and runs it, so the list and the test cannot
drift. Half the cases are sentences that must **not** be caught; a filter that blocks
"assess" is worse than no filter at all. If you move the filter, move the markers with it.

The filter runs in the browser, which is where the typing is. It is not a server-side
guard, and somebody writing their own requests to Supabase can still put anything they like
in a row. Making it airtight means a trigger on `posts`, `comments`, `stories`, `groups`
and `profiles`; worth doing the first time somebody bothers.

## Tests

```bash
npm install                      # once: playwright, for the boot tests
npx playwright install chromium  # once
npm test
```

`npm test` runs everything, including the recovery-code and notification tests
documented further down. The two worth knowing about:

`test/static.test.mjs` needs nothing installed and checks that `index.html` and
`sw.js` still agree: nothing the page cannot start without may be loaded from
another origin, everything the page asks for exists and is precached, and a
changed precached file comes with a bumped `VERSION`. That last one is recorded
in `test/precache.lock` — when you change a precached file, bump `VERSION` in
`sw.js` and run `node test/static.test.mjs --update` to record it.

`test/boot.test.mjs` loads the real page in a headless browser with a stubbed
Supabase, so the load path can be put into states that are otherwise hard to
reach: an expired token, a refresh that fails, a session read that never
returns, the library failing to arrive. Every check is a way of breaking one
rule — whatever goes wrong, the app must never end up showing an empty page.
It is worth keeping honest, because a regression here is close to invisible:
the site went on working in a browser tab while the installed app opened blank.

It also records a real 1080p clip in the browser and posts it through the
dialog, then checks the bytes that actually reached the wire: that they are
smaller, that they decode at 720p with the full duration, and that the audio is
still on them. That recording is why the file takes a minute or so to run.

CI runs all of it on every push and pull request.

## Wheels

A group can make everyone spin a wheel on a schedule. It is optional; a group with no
wheel behaves exactly as it did before.

A wheel is a **chain** of stages spun together on one schedule — usually "what is the
challenge" and then "for how many days" — because the chain is the thing that has a
cadence and a reminder, and the stages are what you watch spin. A group can have several
chains, each on its own schedule. Cycles are counted from an anchor date, so everyone in
the group is always on the same one, and missed cycles are gone rather than owed.

**The result is the database's, not the browser's.** `spin()` picks the slice and writes
the row before anything is shown; the page then turns the wheel to an answer that already
exists. Force-quitting mid-spin, a dropped connection and a second tap all land on the
same result, and there is no policy that lets anyone insert, edit or delete a spin by
hand. Each spin also stores the slices as they were, so editing a wheel later cannot
redraw a result somebody already got.

**Spinning is a rule, not a prompt.** A trigger on `posts` refuses to insert while a
wheel in that group is unspun. The app checks first and opens the wheel — from the feed,
or when you try to post — so the exception is only ever seen by someone going around the
page. Only the group with the outstanding spin is blocked; the others are untouched.

**A wheel belongs to whoever made it.** Anyone in the group can tap it to see what is on
it — they have to spin it, so they get to look — but only the maker can change the slices,
the schedule or delete it, and that is enforced by policy rather than by hiding a button.
A wheel left behind by someone whose account has gone is claimable by any member, so it
cannot end up frozen with nobody able to touch it.

**Anyone can sit out a cycle.** The choice is offered on the wheel itself, next to Spin:
you post without spinning it, nothing counts against you, and it comes back as normal at
the next cycle. It is stored on the same row a spin would use — one decision per person
per cycle — which is why the posting barrier lifts and the reminder stops chasing you
without either of them needing to know the feature exists. Everyone in the group sees
"sitting out" where they would otherwise see your result.

The choice is made **before** the wheel turns, never after: sitting out once a result
exists would be a way to walk away from an answer you did not like, so the database
refuses it and leaves the result standing. Going the other way is fine — change your mind
and you can still spin it before the cycle is up.

**The challenge rides on the post.** When you post, a checkbox says you did it with your
challenge, and the feed and the notification then say what was actually done — "Bob did 25
decline pushups" rather than "25 pushups". The post records the challenge text, not a
pointer to a wheel that can change later.

**Only the challenge that is yours counts.** Posting 30 knuckle pushups does nothing for a
decline quota: the day only fills for work labelled with the one challenge you are on.
A wheel may carry a "Someone else's challenge" slice — an instruction rather than a
challenge — and landing on it, and only then, lets you take one of the others' for the
rest of the cycle. That is what stops a wheel being optional; otherwise everyone could
simply help themselves to the easiest thing anybody got.

**A wheel with no day wheel on it means every day.** The day wheel says how many days the
challenge runs for; without one, it is the whole stretch until the next spin. That is
worked out from the wheel rather than read off the spin, so it is right for spins taken
before the rule existed.

Days fill themselves. A day counts when the posts marked with the challenge meet that
day's whole quota on their own — posts done without it neither help nor spoil it, so a day
is either a full day of the challenge or it is not. `public.wheel_days`, the old
tick-it-yourself table, is left in place but no longer written to. If the wheel
was set to break the streak, a cycle that closes unfinished ends the streak on the day it
closed. `hit()` stays about the quota alone, so the daily chips and the completion rate
keep meaning what they say.

### Spin-day reminders

Everything else the app pushes happens because someone did something. This one happens at
a time, so it needs two things the rest of the app does not: `pg_cron`, which calls the
`wheelday` function once an hour, and `profiles.tz`, which the browser fills in, because
the server has no other way to know when morning is for anyone. An unset or unrecognised
zone falls back to UTC.

`public.wheel_due_now()` works out whose local clock currently reads the wheel's reminder
hour, on a day that starts a cycle, without a spin already recorded — and claims each
reminder as it returns it, so a retry or an overlapping run cannot wake the same person
twice. Several wheels coming due together are one notification, not one each.

To set it up: run the v7 block (replacing `<HOOK_SECRET>` as in v4) and deploy the
function — `supabase functions deploy wheelday`. It needs no new secrets; it uses the
same VAPID pair and `HOOK_SECRET` as `notify`.

## Limits worth knowing (free tiers)

**Video size: 50 MB per file.** This is Supabase's hard cap on the free plan, verified by
testing (50 MB uploads, 51 MB is rejected). It is set in three places that must agree:
`MAX_MB` in `index.html`, `file_size_limit` on the `proof` bucket in `schema.sql`, and the
project's own global limit. Raising it means upgrading the Supabase project to Pro, which
allows far larger files and 100 GB of storage.

**Total storage: 1 GB.** This is the limit that will actually bite. Rough budget:

| Average clip | Posts before full |
|---|---|
| 50 MB | ~20 |
| 25 MB | ~40 |
| 10 MB | ~100 |
| 3 MB | ~340 |

Compression (below) is what keeps this off the bottom row: clips arrive at a few MB
rather than tens, so the same 1 GB holds hundreds of posts instead of dozens. When it
does get close, either upgrade or delete old proof videos (the posts table keeps the
numbers either way).

## Video is re-encoded before it is uploaded

The camera writes far more than a 4:5 card on a phone screen needs. By Apple's own figures
a minute of 1080p is about 65 MB and a minute of 4K about 170 MB, and all of it used to go
up untouched — which is why posting took so long, and why 1 GB only held about twenty
posts.

Anything over 6 MB is now re-encoded to 720p at about 2.5 Mbps (`TARGET_H`, `VIDEO_BPS`,
`COMPRESS_OVER` in `index.html`) before it is sent, using `MediaRecorder` against a canvas.
Against a 1080p test clip that is a bit over 9x smaller. It costs a "Compressing…" step
that runs at roughly the length of the clip, which is a clear win on a phone connection
and roughly a wash on fast wifi.

Two things it deliberately will not do:

- **It only ever emits H.264 in MP4.** If the browser cannot record that, no compression
  happens at all. A WebM recorded on an Android phone will not play on an iPhone, and
  proof nobody can watch is worse than a slow upload.
- **Every failure returns the original file** — unreadable input, an encoder that throws,
  output that does not decode or is not meaningfully smaller, or a clip longer than
  `LONGEST` seconds. The post still goes through, just bigger.

Because it is the re-encoded file that has to fit under the cap, a clip the camera made
too big for the bucket now usually gets through anyway rather than being turned away.

- Accounts are username + password only. Reset uses recovery codes, not email — see below.
- "Today" is whatever the poster's phone says.

## Password recovery

Accounts have no real email address (`emailFor` makes `you@users.quota.local`), so
Supabase's own reset email can never arrive. Recovery codes take its place.

At signup the app issues **8 single-use codes** and shows them once. To reset, the
user gives their username, one unused code, and a new password. That's it — no email,
no phone, no third-party service.

The codes are bound to the account **when they are issued**. That is the security
property: knowing a username gets you nothing, so nobody can take a name that is
already in use by "resetting" it. It also means an account created before this shipped
has no codes, and can only be reset by hand in the Supabase dashboard.

Also in place: SHA-256 hashes stored rather than the codes themselves, a limit of 5
failed tries per username and per IP every 15 minutes, the same wording whether the
username or the code was wrong, and codes spent before the password changes so a
partial failure can't leave one replayable.

Sessions already signed in on other devices are **not** forcibly ended — GoTrue has no
admin endpoint to revoke them, and "single session per user" is a Pro plan setting.

| Where | What |
| ----- | ---- |
| `schema.sql` v5 | `recovery_codes` and `recovery_attempts`, both RLS-on with no policies |
| `supabase/functions/recovery/` | issues and redeems codes, using the service role key |
| `index.html` | the codes dialog, the reset screen, and the Profile button for a new set |

Deploy the function and run the v5 block before this works:

```bash
supabase functions deploy recovery
node --experimental-strip-types supabase/functions/recovery/codes.test.ts
```

It needs no new secrets: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already
in every function's environment.

## Notifications

When someone posts, everyone else in the group gets a push: "John did 30 pushups",
or "Sydney completed the day's goal" on the post that finishes it.

iOS only allows push for apps **added to the home screen** (iOS 16.4+), never in a
Safari tab, so the Profile toggle shows "add to your home screen first" until then.

The pieces:

| Where | What |
| ----- | ---- |
| `schema.sql` v4 | `push_subscriptions` table + the `posts_notify` trigger |
| `index.html` | the Profile toggle, `VAPID_PUBLIC_KEY`, subscribe/unsubscribe |
| `sw.js` | `push` and `notificationclick` handlers |
| `supabase/functions/notify/` | the sender: VAPID + aes128gcm, run on Supabase |

Subscriptions are per device and per install. Deleting the home screen app orphans
its row; the sender prunes anything the push service reports as `404`/`410`.

To run the checks on the sender:

```bash
cd supabase/functions/notify
node --experimental-strip-types push.test.ts      # encryption round-trip + VAPID JWT
node --experimental-strip-types message.test.ts   # wording and goal-completion rules
```

## Deploying

The `quota` Vercel project builds from this repo, so a push is the only deploy step.
`.vercelignore` keeps this README, the schema and the icon sources out of the
served sites.

| Push to    | URL                                              |
| ---------- | ------------------------------------------------ |
| `main`     | https://quota-jet.vercel.app (the real app)      |
| `redesign` | https://quota-git-redesign-ari-d851.vercel.app   |

So `main` is the published version and `redesign` is the working one, same as
before — the difference is that publishing now happens on push rather than by
uploading files by hand.

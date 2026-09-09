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
The icon is the logo on a full-bleed `#0F4C5C` square, scaled 1.05 so the ring
nearly fills the tile (iOS rounds the corners itself, so no padding is needed).
`icon-src.svg` holds that composition. Render at 512 and downscale — `qlmanage`
pads the canvas with white below about 256px, so never render small directly:

```bash
mkdir -p /tmp/ql && qlmanage -t -s 512 -o /tmp/ql "$PWD/icon-src.svg"   # needs an absolute path
cp /tmp/ql/icon-src.svg.png icon-512.png
sips -z 192 192 icon-512.png --out icon-192.png
sips -z 180 180 icon-512.png --out apple-touch-icon.png
```

After changing any of these, bump `VERSION` in `sw.js` or installed apps keep
the old icons from cache. The icons are deliberately not declared `maskable`:
at this crop Android's mask would clip the ring.

The service worker caches only static assets. Everything from Supabase (sign-in,
database, video upload, signed video URLs) always goes to the network, so the
worker can never serve a stale feed or a stale video.

The Supabase library is vendored under `vendor/` and precached rather than pulled
from a CDN. An installed app is often opened before the phone has a connection, and
every line of `index.html` depends on that file: when it did not arrive, the page
came up blank with nothing on it. See `vendor/supabase-js-2.49.4/README.md` for how
to move to a newer version.

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

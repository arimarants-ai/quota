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

## Limits worth knowing (free tiers)

**Video size: 50 MB per file.** This is Supabase's hard cap on the free plan, verified by
testing (50 MB uploads, 51 MB is rejected). It is set in three places that must agree:
`MAX_MB` in `index.html`, `file_size_limit` on the `proof` bucket in `schema.sql`, and the
project's own global limit. Raising it means upgrading the Supabase project to Pro, which
allows far larger files and 100 GB of storage.

**Total storage: 1 GB.** This is the limit that will actually bite. At 50 MB a video that is
only about 20 posts. Rough budget:

| Average clip | Posts before full |
|---|---|
| 50 MB | ~20 |
| 25 MB | ~40 |
| 10 MB | ~100 |
| 5 MB | ~200 |

Two people posting once a day at 25 MB fills it in about three weeks. When it gets close,
either upgrade, or delete old proof videos (the posts table keeps the numbers either way).

To fit a longer clip under 50 MB, record at 720p instead of 4K
(iPhone: Settings → Camera → Record Video).

- No password reset yet. Accounts are username + password only.
- "Today" is whatever the poster's phone says.

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

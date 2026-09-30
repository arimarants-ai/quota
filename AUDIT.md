# App Store readiness audit

Audited 2026-09-30 against the store checklist, on `main` at v110 (`2bf62bb`).

**Where this work is based.** The brief said the PWA work lives on `redesign`. It no longer
does. `redesign` stopped at v40 on 14 September and was merged long ago; `main` is at v110.
Branching off `redesign` would have thrown away three weeks of work, so this branch
(`claude/app-store`) is cut from `main`.

**What the app is.** One static page (`app/index.html`, about 8,100 lines) plus a service
worker, talking straight to Supabase. There's no build step. It is served by Vercel at
app.hitquota.app, and the website at hitquota.app is `site/index.html`.

Legend: **Had** = already in the app, left alone. **Added** = built on this branch.
**Manual** = only you can do it (see `STORE_SUBMISSION.md`).

## A. User-generated content safety (Guideline 1.2)

| Item | Status | Where |
|---|---|---|
| Terms the user must accept at signup | **Had, extended.** Signup already required ticking a box, and `terms_accepted_at`/`terms_version` recorded it. There was no Terms of Use document, only a privacy policy, a cookie note and community guidelines. **Added** a Terms of Use with zero-tolerance wording, put it first in the list, and bumped `TERMS_VERSION`. `needsTerms()` only checked for a null date, so bumping the version asked nobody again. It now compares versions, so every existing account sees the accept screen once. | `LEGAL.terms`, `needsTerms`, `acceptView` |
| Word filter on everything typed | **Had.** Slurs, sexual words and strong swearing are refused in captions, comments, stories, names, bios and usernames. | `badWords()` |
| Report every video and every user, with a reason, stored for review | **Added.** Report is on others' posts (the ⋯ on the post), others' stories, others' comments and messages (press and hold), and on every profile. It has a reason picker and an optional note. Reports are written to `public.reports`, which nobody can read through the API. You read them in `private.open_reports`. People listed in `public.moderators` get a push notification for each one. | schema v46, `reportDlg()` |
| Block a user, hidden from the blocker at once | **Added.** From the profile, the post ⋯, or after reporting. Their posts, stories, comments, messages, invites and banners disappear on the spot and stay gone on every load. Blocking also ends a friendship and cancels pending invites both ways. Unblock from Settings → Blocked people. | schema v46 `blocks`, `blocked()` filter in `fetchAll` |
| Group creator can remove a video | **Added.** Whoever made the group gets "Remove from the group" in the post ⋯ on anyone's post. It deletes the row and the file, and it's enforced by a policy, not only by hiding a button. Authors could already delete their own. Other members can report a post, block its author, or flag it to the group (a flag was already there). | schema v46 policies, `removePost()` |
| Visible contact for reports and support | **Had, extended.** hello@hitquota.app was in the legal pages and on the website. **Added** a Support section in Settings (email, support page, how reports work). | `settingsView` |
| A documented 24-hour process | **Added.** | `MODERATION.md` |

## B. Account and data

| Item | Status | Where |
|---|---|---|
| Delete my account in the app, with confirmation | **Added.** Settings → Delete my account. You have to type `delete` to confirm. It removes every file you uploaded (proof, stories, profile picture), then calls `delete_account()`. That deletes the auth user, and every table cascades from it. Groups you made that nobody else is in go too. Afterwards the phone is signed out and its local data cleared. | schema v46 `delete_account()`, `deleteAccount()` |
| Sign in with Apple | **Not needed.** Sign-in is email (or username) and password only. There's no Google or other third-party login, so Guideline 4.8 doesn't apply. If a social login is ever added, Sign in with Apple has to come with it. | — |
| Log out | **Had.** | Settings → Account |
| Settings links to Privacy, Terms, Support | **Had** privacy and guidelines. **Added** Terms of Use and Support. | `settingsView` |

## C. Public pages

| Item | Status |
|---|---|
| /privacy | **Added** `site/privacy.html`, generated from the same text the app shows so the two can't drift (`node test/legal-pages.mjs --write`, checked in the test run). |
| /terms | **Added** `site/terms.html`: Terms of Use plus the community guidelines, generated the same way. |
| /support | **Added** `site/support.html`: contact, reporting, blocking, deleting an account, and an FAQ. |
| Clean URLs | **Added** `site/vercel.json` with `cleanUrls`, so `/privacy` serves `privacy.html`. |
| Contact email and legal name | **Filled in, not placeholders.** The app already names Ari Marants and Justin Smith and hello@hitquota.app, so the pages use those. If you set up a company, change `CONTACT` and the first line of `LEGAL.privacy`/`LEGAL.terms` in `app/index.html`, then rerun the generator. The seller name in App Store Connect is a manual step. |

## D. Permissions and native polish

| Item | Status |
|---|---|
| Camera, microphone, photo library usage strings | **Added** in `Info.plist` (camera, microphone, photo library read, photo library add). Recaps can be saved from the share sheet, and that needs the "add" string or the app crashes. Android: `CAMERA` in the manifest. |
| Permission denied → how to turn it back on | **Had** for notifications. **Added** for the camera and photos in the native app: the camera is checked before it opens, and a denial says Settings → Quota → Camera. |
| Offline, upload failure, loading | **Had.** `friendlyError()` turns every error into a sentence, a static test fails if anything technical reaches the screen, uploads queue in an outbox when offline, and there's an offline banner. Nothing to add. |
| Safe areas | **Had** (`env(safe-area-inset-*)` throughout, `viewport-fit=cover`). The native status bar now overlays the page the same way a home-screen app does. |
| Dark mode | **Had** (Settings → Dark mode). **Added:** the native status bar text follows it. It stays light by default, which was a deliberate earlier decision. |
| Tap targets ≥ 44 px | **Checked and improved.** Every visible button on the feed, group, profile, settings and dialogs was measured at 390 px wide. The small ones (⋯, back, settings gear, chats, small buttons) now answer to at least 44×44 without being drawn any bigger. Where icons sit closer together than 44 px (like / react / flag under a post), the enlarged areas overlap and the nearer icon wins. Spreading that row out would change the look, so it was left. |
| Hide Add to Home Screen inside the native app | **Added.** `isStandalone()` is true under Capacitor, so the banner, the install screen after an invite, and the "add to home screen first" notification state never appear. The service worker isn't registered in the native app either. |
| No "website"/"PWA"/other-platform text in the app | **Fixed.** The only in-app mentions were in the install steps (never shown natively now), the notification states (same), and three lines of the privacy and storage documents that said "your browser". Those now read the same on every platform. |

## E. Guideline 4.2 (not a wrapped website)

| Item | Status |
|---|---|
| Native push: goal reminders, a crew member posting, post-before-midnight | **Added.** All three already existed as web push: `notify` sends posts, `wheelday` sends the daily prompt and the conditional last call before midnight. The native app registers with APNs (iOS) or FCM (Android) and stores the token in the same `push_subscriptions` table (endpoint `apns:<token>` or `fcm:<token>`). `send()` in `push.ts` delivers to whichever kind the row is. One setting controls it, the Notifications switch in Settings, same as the web app. |
| Haptics | **Added**: posting proof, a streak milestone, a reaction, and a report sent. |
| Native camera and library | **Added**: profile and group pictures come through the native photo picker (Capacitor Camera). Proof still goes through the system camera the web view opens, because proof can be a clip and the Camera plugin only takes photos. It's the same native camera UI, with no library option. |
| Splash screen and icons | **Added**: generated from `native/assets/` (1024 px icon rendered from `app/icon-src.svg`). |

## Capacitor

**Added** `native/`: its own `package.json`, `capacitor.config.json` (appId
`app.hitquota.quota`, webDir `../app`), `ios/` and `android/` projects, plugins (Camera,
Push Notifications, Haptics, Splash Screen, Status Bar, App), generated icons and splash,
Info.plist strings, entitlements for push, and the AndroidManifest permissions. It lives
in its own folder so CI and Vercel don't install or deploy any of it.

**Not verified by building.** This Mac has no Xcode, Java or Android SDK, so neither
project has been compiled. The web app they wrap was tested in Chromium with a stand-in
`window.Capacitor`.

## Android / Samsung / PWABuilder

| Item | Status |
|---|---|
| `.well-known/assetlinks.json` | **Added** as a placeholder at `app/.well-known/assetlinks.json`; `STORE_SUBMISSION.md` says how to fill in the fingerprint. |
| Manifest, maskable icons, service worker | **Had**, and `test/static.test.mjs` already checks every field PWABuilder requires: id, names, start_url, scope, display, colours, 192 and 512 icons in both `any` and `maskable`, and screenshots. |

## Not done, and why

- **Invite links open the web app, not the installed one.** That needs universal links / app links (an `apple-app-site-association` file plus associated domains). It isn't needed for review; it's listed as a next step.
- **Android push needs `google-services.json`** from a Firebase project you create. Until it's in `native/android/app/`, don't turn notifications on in an Android build.
- **Nothing native has been compiled here** (no Xcode, JDK or Android SDK on this Mac).
- **Dark mode stays opt-in.** The app opens light unless you switch, as before; only the status bar was taught to follow it.

## Docs

`MODERATION.md`, `STORE_SUBMISSION.md` and this file are new, at the repo root.

# Store submission

Everything needed to put Quota on the App Store, Google Play and the Galaxy Store. What
was built and why is in `AUDIT.md`. How reports are handled is in `MODERATION.md`.

Bundle ID / application ID: **`app.hitquota.quota`** (set in `native/capacitor.config.json`,
the Xcode project and `native/android/app/build.gradle`). It is permanent once registered
with Apple, so change it now if you want something else.

> **Before every store build: build from the latest `main`.** The store apps carry their
> own copy of `app/` from the moment they are built, and the private numbers page
> (`hitquota.app/n/…`, `site/n/`) counts **active users** from the app calling `seen()`
> as it opens (schema v53, `pingOpen()` in `app/index.html`). A build made from older code
> still counts towards posts and users, but its people never show as active. So: build
> from current `main`, keep `pingOpen()` in the app, and after a release check the numbers
> page shows active users from phones on the new build. Posts and users need nothing; they
> come straight from the database whatever the app version.

> **Front and back at the same time (store apps only).** Both store apps have their own
> camera for front and back that runs both cameras at once, for pictures and videos, with
> the flash on both (the back camera's light, and the screen for the front):
> `native/ios/App/App/DualCamPlugin.swift` (iPhone XS / XR or newer) and
> `native/android/.../DualCamPlugin.java` + `DualCamActivity.java` (Android 11+ phones that
> support two cameras at once). The page finds it by itself: in the store app, tapping the
> front-and-back button opens it. In a browser, or on a phone that can't do it, the button
> falls back to the back camera and then the front. Nothing here could run it on a phone
> (the Android code was compiled against Android's own framework; the iPhone code
> couldn't be compiled here), so before the first submission, on a real phone of each kind
> (Xcode → Run / TestFlight; Android Studio → Run / internal testing), check that:
> - the button shows in Video and Photo;
> - a picture of both comes back side by side, the right way up, you not mirrored;
> - a video of both records with sound and posts;
> - with the flash on, the back light comes on, and a picture lights your face with a full white screen at full brightness;
> - a call or locking the phone mid-video doesn't lose it;
> - ✕ goes back to the normal camera.

---

## 0. Readiness checklist (checked 17 November 2026)

Quota checked against the App Store Review Guidelines as they stood on 17 November 2026
(last updated by Apple on 16 October 2026), Apple's list of common rejections ("over 40% of
unresolved issues are related to guideline 2.1: App Completeness"), and the age rating,
privacy manifest and account deletion pages. Riskiest first.

**done** = handled in the app or this repo · **needs Ari** = only you can do it, in App Store
Connect, Xcode or on a phone · **risk** = could still draw a rejection; what lowers it is said.

| # | Status | Guideline | What | Where |
|---|---|---|---|---|
| 1 | **needs Ari** | 2.1 App Completeness (the most common rejection) | **There is no demo account yet.** On 17 Nov there was no `appreview@` user and no "App Review" group in the live database. Create both accounts, the group, and the buddy's content (section 4). Post the buddy's proof on the **day before** you submit, and again the day before any resubmission: today's posts from others stay locked until you post your own, so a reviewer opening the app sees "Post yours to unlock" over anything from today. The review notes now say so. Check the login still works on the day review starts. | §4, §6 step 6 |
| 2 | **needs Ari** | Upcoming requirements | **Build with Xcode 26 and the iOS 26 SDK.** Required for uploads since 28 April 2026; this file used to say Xcode 16. The deployment targets (iOS 15 app, iOS 16.2 widgets) are fine; the minimum is iOS 13. | §6 Build iOS |
| 3 | **risk** · needs Ari | 2.1, "crashes and bugs" | The native code (both-cameras plugin, widgets, Live Activity) has never been compiled here. Run it on a real iPhone through TestFlight before submitting, using the checks at the top of this file, and try every screen the review notes mention. | top of file |
| 4 | **done** · needs Ari to build | Privacy manifests (required since 1 May 2024) | **There was no `PrivacyInfo.xcprivacy`.** Both targets use a required-reason API (UserDefaults through the App Group: the app writes what the widgets show, the widgets read it), and App Store Connect refuses such a build without a manifest. Added `App/PrivacyInfo.xcprivacy` and `QuotaWidget/PrivacyInfo.xcprivacy`: no tracking, UserDefaults with reason `1C8F.1` (App Group), and the app's collected data types matching §3. Both are in their target's Resources phase (`test/native.test.mjs` checks). The project file was edited by hand: after archiving, Xcode → Organizer → right-click the archive → **Generate Privacy Report** should list both. Capacitor and its plugins bring their own. | `native/ios/App/*/PrivacyInfo.xcprivacy` |
| 5 | **needs Ari** | 2.3.6 Age rating | The age rating questionnaire changed (13+, 16+ and 18+ added; new questions on capabilities, social media, wellness, shared location and dating; the social media and new descriptor answers are required for any submission now). §2 has the answers for the current questions. Expected: **13+**, with a Social Media descriptor. | §2 |
| 6 | **risk** · needs Ari | Age assurance (Texas SB 2420, from 4 June 2026) | Quota accepts people from 13 and checks age only from the birthday typed at sign-up. Apple's guidance is for apps that serve minors to use the Declared Age Range API (and the Significant Change API for parental consent) where state laws require it. Nothing in the guidelines makes it a rejection reason for a 13+ app today, but it is a legal question about under-18s in Texas and similar states. Decide with a lawyer whether to adopt the API or raise the minimum age to 18. | — |
| 7 | **risk** (lowered) | 4.2 Minimum Functionality | A Capacitor app is a web view, which is what 4.2 is about. What is genuinely native in Quota: its own camera that films with the front and back cameras at once (AVFoundation, `DualCamPlugin.swift`), push notifications through APNs, three home screen widgets (Streak, Motivation, Countdown) and a lock screen Live Activity counting down to midnight (WidgetKit / ActivityKit), haptics, the system photo picker and saving recaps to Photos, keeping the screen awake while recording, and invite links that open the app (once the Team ID is in, item 13). Every screen is bundled in the app and opens offline (only the typefaces come from Google Fonts); no page is loaded from a website, and there is no browser UI or link out of the app to sign in. The review notes list all of this. | §4 |
| 8 | **risk** (lowered) | 1.4.5 Physical harm | Apps must not urge "challenges … in a way that risks physical harm". Quota is daily fitness goals, with wheels of challenges and forfeits. The terms now have a "Your health" section (not medical advice, only take on what is safe for you), and the guidelines say a wheel challenge must be safe for everybody in the group and nobody has to do one that is not. Keep screenshots and the description about consistency, not extremes. | terms, guidelines |
| 9 | **needs Ari** | 5.1.1, 2.3 App Privacy | The App Privacy answers (§3) now include **Audio Data** (clips have sound) and the processors added in the privacy policy (Cloudflare R2 for clips, Anthropic for rewording a moderator's note, Google Fonts). They have to match the manifest and the policy; enter them in App Store Connect as §3 says. | §3 |
| 10 | **done** | 1.2 User-generated content | Filter: slurs, sexual words and strong swearing are refused in every typed field. Report: every post, story, comment, message and profile, from inside the app; reported content is hidden until reviewed. Block: from a profile or a post's ⋯, instant. Moderation within 24 hours, strikes, take-down emails (`MODERATION.md`). Published contact: support@hitquota.app in Settings → Support, in every document, and on hitquota.app/support. Terms (EULA) with zero tolerance, agreed at sign-up and again when they change. **Needs Ari:** keep reading Reports and support@ every day; the Oct 2026 text makes it "your responsibility to remove content that violates" the terms. | `MODERATION.md` |
| 11 | **done** | 5.1.1(v) Account deletion | Settings → Delete account → type "delete" → Delete everything. Deletes the account, every post, story and file (shared content included) straight away, and clears the phone. Not hidden, no email or call needed. | `deleteAccount()` |
| 12 | **done** | 5.1.1(i) Privacy policy | In the app (Settings, and the sign-up screen's fine print) and at https://hitquota.app/privacy for App Store Connect. Covers what is collected, who handles it (now including third-party AI, which 5.1.2 asks to be disclosed), how long it is kept, and how to delete it. **Needs Ari:** open the link the day you submit; a broken privacy or support link is a listed rejection. | `LEGAL` |
| 13 | **needs Ari** | Placeholders | `app/.well-known/apple-app-site-association` still says `REPLACE_WITH_TEAM_ID`; fill it in from the Membership page and redeploy (§6 step 17). It is not in the app binary, but invite links will not open the app until it is done. | §6 |
| 14 | **done** | 5.1.1(ii), (iv) Purpose strings | Camera, microphone, photos and save-to-photos each name the feature and an example ("…when you record proof of your daily goal, a story, or a profile picture"). The microphone is asked for only when recording video, never for a photo. English is the only localisation, so there is nothing else to translate. | `Info.plist` |
| 15 | **done** | 4.8 Login Services | Sign in with Apple is **not required**: the iOS app offers only Quota's own email (or username) and password. The Apple and Google buttons exist only on the website, when switched on in Supabase, and never in the native app (`offers()` returns nothing when `NATIVE`). If a third-party login is ever added to the iOS app, Sign in with Apple has to come with it. On 17 Nov nobody had ever signed in with Apple or Google. | `offers()` |
| 16 | **needs Ari** | 2.3.3, 2.3.9 Screenshots | More than half of each set has to show the app in use (not a login or splash). Use the demo accounts, not real people's faces or names. | §5 |
| 17 | **needs Ari** | Push | `App.entitlements` says `aps-environment: development`. With automatic signing Xcode switches it to production when you distribute to App Store Connect; check the archive's entitlements (Organizer → Distribute → the summary) say `production`. Push must never be required: it is not, the app works with notifications off. | `App.entitlements` |
| 18 | **done** | 2.5.2, 2.5.19 | No code is downloaded or changed after review: `app/` is bundled at build time (`webDir`), no remote server URL. Every feature is reachable and described in the review notes; nothing hidden or switched on later. | `capacitor.config.json` |
| 19 | **done** | 4.5.3, 4.5.4 | Notifications are opt-in and only about your groups; the Live Activity is the countdown to midnight on a day your quota is due, nothing else. | — |
| 20 | **done** | Export compliance | `ITSAppUsesNonExemptEncryption` is `false` (HTTPS only), so no encryption questions on each upload. | `Info.plist` |
| 21 | **done** | Out-of-date parts of this file | Fixed: Xcode 16 → 26; the age rating section rewritten for the current questions; the App Privacy table (Audio Data) and the list of processors; "run the v46 block" (the live database is well past it, at v56 and later); the privacy and terms pages "go live when this branch merges" (they are live); the Sign in with Apple review note, which said there is no social login anywhere (the website shows Apple and Google buttons when they are switched on in Supabase; the app never does); the review notes on locked proof and on the native features. | this file |

---

## 1. Listing text

### App Store

| Field | Text | Limit |
|---|---|---|
| Name | Quota | 30 |
| Subtitle | Daily goals with your crew | 30 (26) |
| Promotional text | New: home screen widgets and monthly awards. Pick a daily goal with your crew, post proof before midnight, and keep one streak going across every group. | 170 (152) |
| Keywords | `habit,streak,accountability,friends,workout,fitness,challenge,goals,pushups,daily,group,proof,widget` | 100 (100) |
| Category | Health & Fitness (secondary: Social Networking) | |
| Support URL | https://hitquota.app/support | |
| Marketing URL | https://hitquota.app | |
| Privacy Policy URL | https://hitquota.app/privacy | |
| Copyright | 2026 Ari Marants and Justin Smith | |

**Description** (also used on Google Play):

> Quota is accountability with the people who'll actually notice.
>
> Pick a daily goal with your crew — 100 pushups, a 5k, an hour of reading, anything you can prove. On every day it counts, before midnight where you are, post proof: a photo or a short clip, taken with Quota's camera that day. No camera roll, no old videos, no "trust me".
>
> Hit your quota and your streak grows. Miss it and your crew sees. Set a forfeit if you want the stakes higher.
>
> WHAT'S IN IT
> • Groups with one or more goals, on the days you choose
> • Proof that has to be real: taken in the app, that day
> • One streak across all your groups, plus each group's own
> • Badges from 10 days, and a crew bonus when everyone shows up
> • Monthly awards in every group of two or more: most in one video, longest streak, never missed a day
> • Home screen widgets with a mascot that cheers you on (and panics with you when time's running out)
> • Today's proof stays locked until you've posted your own
> • Comments, reactions, stories and group chat
> • Month views and recaps you can share
> • Reminders before midnight, and a heads-up when your crew posts
> • Question a post that doesn't count, and let the group decide
>
> PRIVATE BY DESIGN
> Your proof is seen by your group, and by your friends only if you put it on your profile. No public feed, no ads, no trackers.
>
> SAFE
> Report any post, story, comment, message or person from inside the app, and block anyone. Reports are reviewed within 24 hours. Terms: hitquota.app/terms
>
> Free. Made by two friends who started with 100 pushups a day.

### Google Play

| Field | Text | Limit |
|---|---|---|
| App name | Quota: Daily goals with your crew | 30 — use **Quota** if it complains |
| Short description | Daily goals with your crew. Post proof before midnight or owe the forfeit. | 80 (74) |
| Full description | The App Store description above | 4000 (1539) |
| Category | Health & Fitness | |
| Tags | Fitness, Habit tracker, Social | |
| Contact email | support@hitquota.app | |
| Privacy policy | https://hitquota.app/privacy | |

Galaxy Store uses the same text.

---

## 2. Age rating

It has user-generated video, chat, and no in-app purchases. Quota itself requires users to be 13+.

**Apple (App Store Connect → App Information → Age Rating).** The questionnaire was
rebuilt in 2025 (ratings 4+, 9+, 13+, 16+, 18+) and has had more questions added since: the
social media ones (required since September 2026) and Shared Location and Dating (required
for any submission from 16 November 2026). Answer every one; the ones below are all of them
as of 17 November 2026.

| Question | Answer |
|---|---|
| Parental controls | No |
| Age assurance | No (the birthday typed at sign-up is not one of Apple's methods; see checklist item 6) |
| Unrestricted web access | No |
| User-generated content | **Yes** (videos and photos shared in groups) |
| Messaging and chat | **Yes** |
| Social media | **Yes**: a feed of friends' posts with likes, comments and stories. This sets a minimum of 13+ and adds the Social Media descriptor. |
| Social media disabled for users under 13 | Not applicable: nobody under 13 can make an account |
| Shared location | No |
| Dating and relationships | No |
| Advertising | No |
| Contests | Infrequent (a group's streaks and monthly awards are a friendly fitness contest; Apple counts "sport or fitness contests") |
| Gambling, simulated gambling | None / No (the wheel picks a challenge; nothing is staked) |
| Health or wellness topics | **Yes** (exercise goals). This alone is 9+. |
| Medical or treatment information | None |
| Violence (cartoon, realistic, graphic), violent themes | None |
| Sexual content or nudity, suggestive themes | None |
| Profanity or crude humour | None (strong words are filtered out) |
| Alcohol, tobacco, drugs; horror or fear; mature themes | None |

Expected result: **13+** with the Social Media descriptor. If the calculator ever offers
less, set 13+ yourself (allowed: you can choose a higher rating); the terms say 13+.

**Google Play (IARC questionnaire):** category *Social* or *All other app types*. Violence,
sexuality, language, controlled substances, gambling: No. "Can users interact or exchange
content?": **Yes**. "Shares user's location?": No. "Allows purchases of digital goods?": No.
Expected: **Teen / PEGI 12**. Also fill in **Target audience** as 13–15, 16–17 and 18+ (not
under 13), which keeps it out of the Families programme.

---

## 3. App Privacy ("nutrition label") and Google Data safety

**Tracking: No.** No ads, no analytics services, no third-party SDKs that track. The one
usage figure (when the app was last opened, for counting active users) stays in Quota's
own database and is never shared, which is not tracking in Apple's sense.

| Apple data type | Collected | Linked to the user | Used for | Google Data safety equivalent |
|---|---|---|---|---|
| Contact Info → Email Address | Yes | Yes | App Functionality | Personal info → Email address |
| Contact Info → Name | Yes (display name) | Yes | App Functionality | Personal info → Name |
| User Content → Photos or Videos | Yes (proof, stories, pictures) | Yes | App Functionality | Photos and videos → Photos, Videos |
| User Content → Audio Data | Yes (the sound on proof clips and stories) | Yes | App Functionality | Audio → Voice or sound recordings |
| User Content → Other User Content | Yes (captions, comments, stories, group names) | Yes | App Functionality | App activity → Other user-generated content |
| User Content → Emails or Text Messages | Yes (in-app chat) | Yes | App Functionality | Messages → Other in-app messages |
| User Content → Customer Support | Yes (if they email) | Yes | App Functionality | — |
| Identifiers → User ID | Yes | Yes | App Functionality | App info → User IDs |
| Identifiers → Device ID | Yes (push token, only if notifications are on) | Yes | App Functionality | Device or other IDs |
| Other Data | Yes (date of birth, gender, time zone) | Yes | App Functionality | Personal info → Other info |
| Usage Data → Product Interaction | Yes (when the app was last opened, one time per account, to count active users) | Yes | Analytics | App activity → App interactions |
| Diagnostics, Location, Financial, Health, Browsing, Search, Contacts, other Usage Data | **No** | | | Not collected |

Google also asks: data encrypted in transit **Yes**; users can request deletion **Yes** (in
the app, and at hitquota.app/support); data shared with third parties **No** (Supabase,
Cloudflare, Vercel, Resend and Anthropic are processors acting for Quota, which doesn't count as sharing).

Every type in this table except Customer Support (which arrives by email, outside the app) is
also declared in `native/ios/App/App/PrivacyInfo.xcprivacy`, and `test/native.test.mjs` fails if
the manifest names a type this table does not. Change the policy, the manifest and these
answers together.

---

## 4. App Review notes (Apple) and testing instructions (Google)

**You need to create these first** (see step 6):

- Demo account: `appreview@hitquota.app` / `<PASSWORD>`
- A second account, e.g. `@quotareviewbuddy`, that has posted a couple of times
- A group "App Review" containing both, with at least one post, a comment and a story from the buddy

Paste this, with the password filled in:

> **Demo account:** appreview@hitquota.app / `<PASSWORD>`. It's already a member of a group called "App Review" with another user who has posted, so every feature can be seen without creating content.
>
> **Locked proof:** today's proof from other people in a group stays locked ("Post yours to unlock") until you post your own, which is the point of the app. Earlier days are never locked. To see today's posts, tap + and post a photo of anything.
>
> **Joining a group:** the demo account is already in one. To try joining, tap Groups → + → create one, then Invite; or open the invite link we can send on request.
>
> **Posting proof:** tap + and record a photo or clip with the camera. Proof must be taken in the app that day, so the photo library isn't offered for proof. It is used for profile and group pictures.
>
> **User-generated content safeguards (Guideline 1.2):**
> - *Terms / EULA:* agreed to at sign-up ("By continuing you agree to Quota's terms, privacy policy and guidelines, which allow no abuse or objectionable content"), and again on an "I agree" screen whenever they change. All of them are under Settings → Legal.
> - *Report:* tap ⋯ on any post or story → Report; press and hold any comment or message → Report; open any profile → Report. A reason is required.
> - *Block:* open any profile → Block, or ⋯ on their post → Block. Their content disappears immediately. Settings → Blocked to undo.
> - *Remove content:* the creator of a group can remove any post in it (⋯ → "Remove from <group name>"). Authors can delete their own.
> - *Filtering:* slurs, sexual words and strong profanity are refused in all typed text.
> - *Moderation:* reports are reviewed within 24 hours; contact support@hitquota.app, also shown in Settings → Support.
>
> **Account deletion (5.1.1(v)):** Settings (gear on the Profile tab) → Delete account → type "delete" → Delete everything. It deletes the account and all its data immediately.
>
> **Sign in with Apple (4.8):** the app offers only Quota's own sign-in, an email or username and a password. There is no third-party or social login in the app.
>
> **Native features (4.2):** Quota's own camera, which can film with the front and back cameras at once (AVFoundation); three home screen widgets (Streak, Motivation, Countdown) and a lock screen countdown to midnight (Live Activity); push notifications (daily reminder, a crew member posting, a last call before midnight); haptics; the system photo picker and saving recaps to Photos. The app's screens are bundled in the app and open offline; none is loaded from a website.
>
> **Safety of challenges (1.4.5):** goals and wheel challenges are chosen by each group. The terms say Quota is not medical advice and to take on only what is safe for you, and the guidelines that a challenge must be safe for everybody in the group and nobody has to do one that is not.
>
> **In-app purchases:** none. Everything in the app is free, so there is nothing to restore.

Google Play → App content → App access: "All or some functionality is restricted", with the same demo account and the first three paragraphs above.

---

## 5. Screenshots

Take them on real devices or simulators signed into the demo account with the App Review
group full of posts. `node test/screenshots.mjs` renders the web versions (1284×2778) if you
need a stand-in: the feed, a group, posting, the month and a monthly awards card.

| Store | Required | Size (portrait) |
|---|---|---|
| App Store | iPhone 6.9" display, 3–10 screenshots | 1320×2868 (or 1290×2796) |
| App Store | iPhone 6.5" — only if the 6.9" set isn't given | 1284×2778 or 1242×2688 |
| App Store | iPad — **not needed**: the app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`) | — |
| App Store | App icon | Taken from the build (1024×1024, no transparency; done) |
| Google Play | Phone, 2–8 screenshots | 1080×1920 or larger, 9:16 |
| Google Play | Feature graphic | 1024×500 PNG/JPG: `native/store/google-play/feature-graphic.jpg`, the mascot beside the name (redraw with `node test/feature-graphic.mjs`) |
| Google Play | App icon | 512×512 PNG (`native/assets/icon-only.png` resized: `sips -z 512 512 native/assets/icon-only.png --out play-icon.png`) |
| Galaxy Store | 3+ screenshots, icon 512×512 | Same as Play |

Suggested set: 1) the feed with today's proof, 2) a group with everyone's streak,
3) the camera recording proof, 4) the locked day ("post to see"), 5) the month view,
6) a streak milestone, 7) the Streak widget on the home screen, 8) a monthly awards card
(the first screen of a month's recap). Don't show the web address bar, "Add to Home
Screen", or anything Android in the iPhone set.

The widget shots have to be taken on a real phone (or the simulator / emulator) with the
store app installed: widgets only exist there, so `node test/screenshots.mjs` cannot render
them. It does render the awards card (`app/screenshot-awards.png`) as a stand-in.

---

## 6. What only you can do

In roughly this order.

**Database and functions (before any build is reviewed)**
1. The live database must be on the latest block of `supabase/schema.sql` (v64 when this was written; it was past v56 on 17 November 2026). Run any block it has not seen, oldest first, as the README says.
2. Every function in `supabase/functions/` deployed from current `main`: `notify`, `wheelday`, `media` and `moderation` from their `bundled.ts`, `welcome` and `signin` from `index.ts`.
3. Make yourselves moderators (SQL in `MODERATION.md`) and turn notifications on in the app.

**Accounts and legal**
4. Apple Developer Program ($99/yr). As an individual, the seller name shown is your legal name. As a company, you need a D-U-N-S number first. Google Play Console ($25 one-off; new personal accounts must run a closed test with 12 testers for 14 days before production). Samsung Seller Portal (free).
5. Decide whose name is on it. The terms and privacy policy name Ari Marants and Justin Smith. If you set up a company, change the first line of `LEGAL.privacy` and `LEGAL.terms` in `app/index.html`, then run `node test/legal-pages.mjs --write`.
6. Create the review accounts in section 4, the App Review group, and some content (checklist item 1: none of it existed on 17 November 2026). The buddy's proof goes up the day before you submit, so it is not locked for the reviewer.

**Push credentials**
7. **Apple:** Certificates, Identifiers & Profiles → Keys → + → Apple Push Notifications service → download the `.p8` (you only get it once). Also register the identifier `app.hitquota.quota` with Push Notifications ticked.
8. **Google:** create a Firebase project → add an Android app with package `app.hitquota.quota` → download `google-services.json` into `native/android/app/`. **Without this file, turning notifications on in the Android build will fail or crash.** Then Project settings → Service accounts → Generate new private key.
9. Supabase → Edge Functions → Secrets, add:
   - `APNS_KEY` = the whole contents of the `.p8` file
   - `APNS_KEY_ID` = the key's ID (10 characters)
   - `APNS_TEAM_ID` = your Team ID (Membership page)
   - `APNS_TOPIC` = `app.hitquota.quota`
   - `FCM_SERVICE_ACCOUNT` = the whole service account JSON

**Build iOS** (needs a Mac with **Xcode 26** or later: App Store Connect has refused builds from older SDKs since 28 April 2026):

```bash
cd native && npm ci && npx cap sync ios && npx cap open ios
```

In Xcode: select the **App** target → Signing & Capabilities → pick your Team. Push
Notifications is already declared in `App.entitlements`; if Xcode flags it, click
"+ Capability → Push Notifications". Set Version (1.0) and Build (1). Then choose Any iOS
Device → Product → Archive → Distribute App → App Store Connect. Test with TestFlight
before submitting.

**Build Android** (needs Android Studio, which brings the JDK and SDK):

```bash
cd native && npm ci && npx cap sync android && npx cap open android
```

In Android Studio: Build → Generate Signed App Bundle or APK → Android App Bundle → create a
new keystore (**back it up; losing it means you can never update the app**) → release. The
file lands in `native/android/app/release/app-release.aab`. Or, once a keystore is set up
in `android/app/build.gradle`:

```bash
cd native/android && ./gradlew bundleRelease     # app/build/outputs/bundle/release/app-release.aab
cd native/android && ./gradlew assembleRelease   # an APK, if the Galaxy Store asks for one
```

Enrol in **Play App Signing** when you upload (the default).

**After the first Play upload**
10. Fill in `app/.well-known/assetlinks.json`: Play Console → your app → Setup → App signing → "App signing key certificate" → SHA-256 fingerprint. Paste it in place of the placeholder, keeping the colons. If you also sign builds yourself for testing, add your upload key's fingerprint as a second entry in the array (`keytool -list -v -keystore your.keystore`). It's served at `https://app.hitquota.app/.well-known/assetlinks.json`. You only need it if you add app links, or if you publish the PWABuilder/TWA package instead of the Capacitor one.

**Store setup**
11. App Store Connect → new app: name, bundle ID, SKU `quota-ios`, primary language English. Fill in section 1, 2, 3, 4 and upload the screenshots. Pricing: free. Availability: your choice.
12. Play Console → create app → the same sections, plus Data safety, Target audience, Content rating, App access and Ads (No).
13. Galaxy Store → the same, uploading the APK or AAB.

**Domain and email** (already done, check they still hold)
14. hitquota.app/privacy, /terms and /support are served by the `quota-site` project from `site/`. Open each one the day you submit: a broken support or privacy link is one of Apple's listed rejections.
15. support@hitquota.app forwards to your inbox (Cloudflare Email Routing) and is the address in the app. Someone has to read it daily for the 24-hour promise.

**After launch**
16. Update the website's "Get the app" badges and the FAQ answer "Is it on the App Store?", and point the site's QR code at the store listing.
17. Invite links are `app.hitquota.app/join/<code>` and open the installed app when it's there (old `#join-` links still work, in the browser). Two placeholders to fill in once the accounts exist, then redeploy the app project:
    - `app/.well-known/apple-app-site-association`: replace `REPLACE_WITH_TEAM_ID` with your Team ID (Membership page). The Associated Domains entitlement is already in `App.entitlements`.
    - `app/.well-known/assetlinks.json`: the SHA-256 fingerprint from step 10.
    Check both with `curl -sI https://app.hitquota.app/.well-known/apple-app-site-association` (it should answer 200 with `application/json`).

---

## PWABuilder (optional)

If you'd rather package the Android app with PWABuilder (a Trusted Web Activity) than use
the Capacitor project, the manifest, maskable icons and service worker already pass what
it checks. `test/static.test.mjs` enforces every required manifest field. Enter
`https://app.hitquota.app` at pwabuilder.com, use package ID `app.hitquota.quota`, and fill
in `assetlinks.json` (step 10) with the fingerprint it gives you. The Capacitor build is
the recommended one: it has native push, camera, haptics, and none of Apple's
"repackaged website" risk.

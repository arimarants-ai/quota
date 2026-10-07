# Store submission

Everything needed to put Quota on the App Store, Google Play and the Galaxy Store. What
was built and why is in `AUDIT.md`. How reports are handled is in `MODERATION.md`.

Bundle ID / application ID: **`app.hitquota.quota`** (set in `native/capacitor.config.json`,
the Xcode project and `native/android/app/build.gradle`). It is permanent once registered
with Apple, so change it now if you want something else.

---

## 1. Listing text

### App Store

| Field | Text | Limit |
|---|---|---|
| Name | Quota | 30 |
| Subtitle | Daily goals with your crew | 30 (26) |
| Promotional text | Your crew is waiting on your proof. Pick a daily goal together, post a photo or clip before midnight, and keep the streak alive. | 170 (128) |
| Keywords | `habit,streak,accountability,friends,workout,fitness,challenge,goals,pushups,daily,group,proof,crew` | 100 (98) |
| Category | Health & Fitness (secondary: Social Networking) | |
| Support URL | https://hitquota.app/support | |
| Marketing URL | https://hitquota.app | |
| Privacy Policy URL | https://hitquota.app/privacy | |
| Copyright | 2026 Ari Marants and Justin Smith | |

**Description** (also used on Google Play):

> Quota is accountability with the people who'll actually notice.
>
> Pick a daily goal with your crew — 100 pushups, a 5k, an hour of reading, anything you can prove. Every day, before midnight where you are, post proof: a photo or a short clip, taken with Quota's camera that day. No camera roll, no old videos, no "trust me".
>
> Hit your quota and your streak grows. Miss it and your crew sees. Set a forfeit if you want the stakes higher.
>
> WHAT'S IN IT
> • Groups with one or more daily quotas, on the days you choose
> • Proof that has to be real: taken in the app, that day
> • Your own streak, a crew bonus when everyone shows up, and one pass a month
> • Today's proof stays locked until you've posted your own
> • Comments, reactions, stories and group chat
> • Month views, stats and weekly recaps you can share
> • Reminders before midnight, and a heads-up when your crew posts
> • Question a post that doesn't count, and let the group decide
>
> PRIVATE BY DESIGN
> Your proof is seen by your group and nobody else. No public feed, no ads, no trackers.
>
> SAFE
> Report any post, story, comment, message or person from inside the app, and block anyone. Reports are reviewed within 24 hours. Terms: hitquota.app/terms
>
> Free. Made by two friends who started with 100 pushups a day.

### Google Play

| Field | Text | Limit |
|---|---|---|
| App name | Quota: Daily goals with your crew | 30 — use **Quota** if it complains |
| Short description | Pick a daily goal with your crew. Post proof before midnight or owe the forfeit. | 80 (80) |
| Full description | The App Store description above | 4000 |
| Category | Health & Fitness | |
| Tags | Fitness, Habit tracker, Social | |
| Contact email | hello@hitquota.app | |
| Privacy policy | https://hitquota.app/privacy | |

Galaxy Store uses the same text.

---

## 2. Age rating

It has user-generated video, chat, and no in-app purchases. Quota itself requires users to be 13+.

**Apple (App Store Connect → App Information → Age Rating):**

| Question | Answer |
|---|---|
| Violence (cartoon, realistic, graphic) | None |
| Sexual content or nudity | None |
| Profanity or crude humour | None (strong words are filtered out) |
| Alcohol, tobacco, drugs; horror; mature themes; gambling; simulated gambling; contests | None / No |
| Medical or treatment information | None |
| Health or wellness topics | Yes, infrequent (fitness goals). Answer No if it pushes the rating up; it's not medical. |
| Unrestricted web access | No |
| User-generated content | **Yes** |
| Messaging and chat | **Yes** |
| Parental controls / age assurance | No |
| Advertising | No |

Expected result: **13+**. Pick 13+ even if the calculator offers lower; the terms say 13+.

**Google Play (IARC questionnaire):** category *Social* or *All other app types*. Violence,
sexuality, language, controlled substances, gambling: No. "Can users interact or exchange
content?": **Yes**. "Shares user's location?": No. "Allows purchases of digital goods?": No.
Expected: **Teen / PEGI 12**. Also fill in **Target audience** as 13–15, 16–17 and 18+ (not
under 13), which keeps it out of the Families programme.

---

## 3. App Privacy ("nutrition label") and Google Data safety

**Tracking: No.** No ads, no analytics, no third-party SDKs that track.

| Apple data type | Collected | Linked to the user | Used for | Google Data safety equivalent |
|---|---|---|---|---|
| Contact Info → Email Address | Yes | Yes | App Functionality | Personal info → Email address |
| Contact Info → Name | Yes (display name) | Yes | App Functionality | Personal info → Name |
| User Content → Photos or Videos | Yes (proof, stories, pictures) | Yes | App Functionality | Photos and videos → Photos, Videos |
| User Content → Other User Content | Yes (captions, comments, stories, group names) | Yes | App Functionality | App activity → Other user-generated content |
| User Content → Emails or Text Messages | Yes (in-app chat) | Yes | App Functionality | Messages → Other in-app messages |
| User Content → Customer Support | Yes (if they email) | Yes | App Functionality | — |
| Identifiers → User ID | Yes | Yes | App Functionality | App info → User IDs |
| Identifiers → Device ID | Yes (push token, only if notifications are on) | Yes | App Functionality | Device or other IDs |
| Other Data | Yes (date of birth, gender, time zone) | Yes | App Functionality | Personal info → Other info |
| Usage Data, Diagnostics, Location, Financial, Health, Browsing, Search, Contacts | **No** | | | Not collected |

Google also asks: data encrypted in transit **Yes**; users can request deletion **Yes** (in
the app, and at hitquota.app/support); data shared with third parties **No** (Supabase,
Vercel and Resend are processors acting for Quota, which doesn't count as sharing).

---

## 4. App Review notes (Apple) and testing instructions (Google)

**You need to create these first** (see step 6):

- Demo account: `appreview@hitquota.app` / `<PASSWORD>`
- A second account, e.g. `@quotareviewbuddy`, that has posted a couple of times
- A group "App Review" containing both, with at least one post, a comment and a story from the buddy

Paste this, with the password filled in:

> **Demo account:** appreview@hitquota.app / `<PASSWORD>`. It's already a member of a group called "App Review" with another user who has posted, so every feature can be seen without creating content.
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
> - *Moderation:* reports are reviewed within 24 hours; contact hello@hitquota.app, also shown in Settings → Support.
>
> **Account deletion (5.1.1(v)):** Settings (gear on the Profile tab) → Delete account → type "delete" → Delete everything. It deletes the account and all its data immediately.
>
> **Sign in with Apple:** not offered because Quota has no third-party or social login, only email and password.
>
> **Native features:** home-screen streak widgets, a lock-screen countdown to midnight (Live Activity), push notifications (daily reminder, a crew member posting, a last call before midnight), haptics and the camera. The app's screens are bundled in the app, not loaded from a website.
>
> **In-app purchases:** none. Everything in the app is free, so there is nothing to restore.

Google Play → App content → App access: "All or some functionality is restricted", with the same demo account and the first three paragraphs above.

---

## 5. Screenshots

Take them on real devices or simulators signed into the demo account with the App Review
group full of posts. `node test/screenshots.mjs` renders the web versions (1284×2778) if you
need a stand-in.

| Store | Required | Size (portrait) |
|---|---|---|
| App Store | iPhone 6.9" display, 3–10 screenshots | 1320×2868 (or 1290×2796) |
| App Store | iPhone 6.5" — only if the 6.9" set isn't given | 1284×2778 or 1242×2688 |
| App Store | iPad — **not needed**: the app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`) | — |
| App Store | App icon | Taken from the build (1024×1024, no transparency; done) |
| Google Play | Phone, 2–8 screenshots | 1080×1920 or larger, 9:16 |
| Google Play | Feature graphic | 1024×500 PNG/JPG |
| Google Play | App icon | 512×512 PNG (`native/assets/icon-only.png` resized: `sips -z 512 512 native/assets/icon-only.png --out play-icon.png`) |
| Galaxy Store | 3+ screenshots, icon 512×512 | Same as Play |

Suggested set: 1) the feed with today's proof, 2) a group with everyone's streak,
3) the camera recording proof, 4) the locked day ("post to see"), 5) the month view,
6) a streak milestone. Don't show the web address bar, "Add to Home Screen", or anything
Android in the iPhone set.

---

## 6. What only you can do

In roughly this order.

**Database and functions (before any build is reviewed)**
1. Run the **v46** block of `supabase/schema.sql` in the SQL editor.
2. Redeploy **notify** and **wheelday** from their `bundled.ts` (full replace). Both send push, and both now know the native kinds.
3. Make yourselves moderators (SQL in `MODERATION.md`) and turn notifications on in the app.

**Accounts and legal**
4. Apple Developer Program ($99/yr). As an individual, the seller name shown is your legal name. As a company, you need a D-U-N-S number first. Google Play Console ($25 one-off; new personal accounts must run a closed test with 12 testers for 14 days before production). Samsung Seller Portal (free).
5. Decide whose name is on it. The terms and privacy policy name Ari Marants and Justin Smith. If you set up a company, change the first line of `LEGAL.privacy` and `LEGAL.terms` in `app/index.html`, then run `node test/legal-pages.mjs --write`.
6. Create the review accounts in section 4, the App Review group, and some content.

**Push credentials**
7. **Apple:** Certificates, Identifiers & Profiles → Keys → + → Apple Push Notifications service → download the `.p8` (you only get it once). Also register the identifier `app.hitquota.quota` with Push Notifications ticked.
8. **Google:** create a Firebase project → add an Android app with package `app.hitquota.quota` → download `google-services.json` into `native/android/app/`. **Without this file, turning notifications on in the Android build will fail or crash.** Then Project settings → Service accounts → Generate new private key.
9. Supabase → Edge Functions → Secrets, add:
   - `APNS_KEY` = the whole contents of the `.p8` file
   - `APNS_KEY_ID` = the key's ID (10 characters)
   - `APNS_TEAM_ID` = your Team ID (Membership page)
   - `APNS_TOPIC` = `app.hitquota.quota`
   - `FCM_SERVICE_ACCOUNT` = the whole service account JSON

**Build iOS** (needs a Mac with Xcode 16+ from the App Store):

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
14. hitquota.app/privacy, /terms and /support go live when this branch merges (the `quota-site` project). Open each one before you submit.
15. hello@hitquota.app forwards to your inbox (Cloudflare Email Routing) and is the address in the app. Someone has to read it daily for the 24-hour promise.

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

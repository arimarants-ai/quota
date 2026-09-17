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

## Your profile holds everything; everyone else's holds what you chose

Your own profile is where you go to find your own work, so every post you ever made is on
it. The ones other people can see wear an eye in the corner of the tile, and the sentence
above the grid says which is which. Anybody else's profile holds only what they marked,
exactly as before.

`loadProfile()` drops the `on_profile` filter for your own id and nothing else. What other
people are served is decided by the policy in the database rather than by that line, so the
filter coming off cannot show a private post to anyone but you. **This needs the v26 block
of `schema.sql`**: a post in a group you have since left is yours, but `is_member()` is
false and `on_profile` may be false too, so without `user_id = auth.uid()` on the select
policy your own rows are invisible to you.

### One post, opened on its own

Tapping a tile opens that post in `#one`, a layer over the screen. It is a layer rather than
a screen because a tile can be a post from a group this account is not in, so sending you to
the feed to find it would send you nowhere. Three things follow from it being a layer, and
all three were wrong:

- `watchClips()` was scoped to `#app`, so the clip you had just tapped through to was the
  one element on the page that never got its source. It sat there black and the tap had to
  fetch, sign, attach and start it all at once. The selector now names `#one` as well.
- It was drawn once and never again, so a reply written there did not appear until it was
  closed and opened, and a like counted up everywhere except in front of you. `redraw()` is
  what `render()` uses on `#app`, and it now runs over `#one` too — keeping the playing clip,
  the half-typed reply and the open emoji tray, which is what `redraw()` was always for.
- The screen's own back-drag works off `#app`, so a pull on this one slid the feed out from
  under it and left it sitting on top of the result. It has the same gesture on itself now,
  and needs no ghost: what it is covering is really there, not a photograph of it.

`postById()` is the other half. The feed carries the last two hundred posts; a profile grid
is fetched separately and reaches further back and into groups this account is not in. Any
function taking a post id has to look in both or it works in the feed and quietly fails
everywhere else — which is what left `freshUrl()` unable to re-sign a clip on somebody's
profile, so the one retry that would have fixed it could never fire.

## Proof on a story

The ⋯ on your own post offers to put it on your story. It goes on as a **card** — inset, a
little off square, with the story's own background showing past its edges — because that is
what it is: a thing lifted from somewhere else and stuck on. Filling the screen with it would
say it was shot for the story. It drags about the card like the words and the stickers do,
by the same `dragify()`, and tapping it while somebody is watching opens that post.

The story points at the post rather than carrying a copy of it. Copying would double what a
minute of video costs against a 1 GB bucket for something that is gone in a day. What makes
pointing safe is that sharing puts the post **on your profile**, and a post on your profile
is readable by exactly the people a story is — `can_see_user()` decides both — so there is
nobody who can be shown the card and cannot be shown what is on it. The sheet says that
before it does it rather than after.

It needs no new table and no new block of `schema.sql`. The post id lives in `style`, the
jsonb that already holds everything about how one story looks, as `post` with `px`/`py` for
where it was dragged to. `storyPosts()` fetches the ones the feed does not already carry —
somebody's older post, or one in a group shared with them but not with you — and signs them,
only when a story on screen actually points at one. A post that has gone since draws as a
card saying so rather than as a hole.

## The bar at the bottom, and putting it away

`showErr()` carries two different things and they want opposite treatment. A load that
failed keeps its bar up: there is a Retry on it and the app is showing whatever it had
before until that is pressed. Anything caught by the last-resort `error` and
`unhandledrejection` handlers is a report of something that has already happened, with
nothing to press — so it says its piece, offers no Retry, and goes after nine seconds.

Both can be dismissed. There was no way to put the bar away at all before, so a fault that
repeats on every load meant a bar parked across a working app for the rest of the session,
which is exactly what "it never goes away" described.

`noise()` is the short list of rejections that never reach it: a clip swapped out while it
was starting rejects with `AbortError`, a browser that will not start one unprompted rejects
with `NotAllowedError`, and a request dropped because the screen it belonged to has gone
rejects with nothing worth reading. None of the three is a fault anybody can act on.

## What is happening while you are looking

One channel for the whole app rather than one per screen: what you can see changes as you
move about, and a subscription torn down and rebuilt on every navigation is one that is
sometimes missing.

**Nothing patches `S` by hand off a payload.** A row arriving is only a reason to *ask*, and
`load()` already knows how to ask properly — an update that gets one table right and its
neighbour wrong is worse than a round trip. Bursts are collapsed on a 600ms timer, so ten
people liking a post at once is one load.

**Realtime has to be switched on per table** in the Supabase dashboard (Database →
Replication); the v29 block adds them to the publication. Where it is not on, none of this
fires and the app behaves exactly as it did before: the visibility refetch, and in a chat
`refreshChat()`. Row level security still decides who hears what — a publication grants
nothing a policy does not already allow. There is a boot test for the app with no realtime
at all, because this must never be something the app needs in order to work.

### The line down from the top

A push notification is for somebody who is not looking. `#drop` is the other half, and it is
not a notification: it lives in the app, it goes away after five seconds, and the whole card
is the way to the thing it is about.

Two things never earn one, and both were asked for:

- **Somebody in your group posting.** The feed fills in underneath you, and a banner would
  only say what you can already see.
- **Anything in the chat that is open in front of you.** You are reading it.

Neither is a special case bolted on: `bannerFor()` returns nothing for `posts` at all, and
returns nothing for a message whose chat is `S.chat`.

Banners are **resolved after the load, not off the payload**. A row names ids, and whether a
comment is on your post — or who somebody is — is only knowable once the tables it points at
have caught up. `goTarget()` is the dispatch a banner and a notification both go through, so
tapping either lands in exactly the same place; it checks that a chat key names a real
conversation rather than that it is shaped like one, because a key that looks right and
points at nobody opens an empty chat with "?" at the top of it.

### Two things that happen at a time rather than because somebody did something

`wheelday` already ran hourly on `profiles.tz` to work out whose morning it is. It answers a
second question on the same beat now — whose evening it is, and who has not finished — so
there is no new cron job, no new function and no new secret. `day_due_now()` claims each
reminder as it returns it, the same as `wheel_due_now()`, so an overlapping run cannot chase
anybody twice, and it leaves out a post an upheld flag took off the day, or the reminder
would say a day was finished that the app shows as open. A rest day is not a day anybody is
behind on.

The other is **somebody saying yes**. A friend request accepted and a group invite accepted
both end as a row, and until now whoever sent the invitation heard nothing at all.
`notify_hook()` gained one field for it: a friendship names a pair and nothing else, and
`auth.uid()` is the only thing that knows which half just accepted — and it is only knowable
in the trigger, because by the time `pg_net`'s call lands there is no session left to ask.

**This needs the v29 block of `schema.sql`**, and `wheelday` redeployed as well as `notify`.

## Talking to each other

Two kinds of chat and one table, because a message is a message. A group's chat **is** the
group: every group has one the moment it exists, with nothing to create and nothing to join,
and anybody who joins later can read all of it, the way a channel works. A private one is a
pair of friends, and the pair is stored sorted — which is exactly what `friendships` already
does, so "is there a chat between these two" and "are these two friends" are the same shape
of question. A row is one or the other, never both and never neither, and that is a
constraint rather than a convention.

Writing needs one thing more than reading: a private chat is **between friends**. Somebody
who can see you is not somebody who can message you.

Text only. Proof is what the video budget is for, and a chat that can carry clips is a 1 GB
bucket with a hole in it.

The way in is the icon at the top right of the feed, with what is waiting on it. A group's
own chat is also on the group screen, and a friend can be messaged straight from Friends —
`openChat(key, from)` takes where it was opened from, so the way back is the list when it
came off the list and the group when it came off the group.

**The tab bar goes away for the length of a conversation**, the way it does in every app
that has one. Not only because it would sit under the box you type in: the box is pinned to
the bottom, and it used to move whenever the keyboard class flipped — including between the
press and the release of a tap on Send, and a press and a release in two different places is
not a click the browser ever reports. So Send did nothing, silently. The box now follows the
viewport on `--vvb` and rides the keyboard up on `--kb`, in one expression with nothing in it
that flips on focus alone.

`redraw()` learned about the composer for the same sort of reason. A conversation redraws
itself every few seconds while it is open, so it is the one screen where a redraw is most
likely to land mid-sentence; what was typed and where the caret was are carried across, and
focus is put back, or the keyboard slides away under somebody mid-word. `refreshChat()`
avoids the question entirely by swapping only the lines — two queries rather than the twenty
a whole load runs, because nothing else on the page changed because somebody typed.

That poll is a **stopgap** and is marked as one. It goes when the realtime pass replaces it
with a subscription.

**This needs the v28 block of `schema.sql`**, and the `notify` function redeployed for
`message` and `message_reaction`. Until the block is run the tables do not exist, the app
loads them softly, and no way in is offered anywhere — same as flags, same as comments.

## Questioning somebody's proof

A flag is one person saying a post does not meet the challenge, and the group deciding. It
is deliberately not a report to a moderator: there is no moderator, and the people who know
whether twenty pushups were twenty pushups are the people in the group.

The outline beside the like and the reaction opens a sheet asking why — the reason is what
everybody else votes on, so there is no flagging without one. It fills in once a flag exists,
and a line across the bottom of the post says where the question got to, on your own post
too, which carries no flag button at all.

**What an upheld flag does** is stop the post counting towards its day. The clip is not
deleted and nothing on it is rewritten — the group can still watch what it decided about.
The day simply goes back to what it was without it, and every rule already written on top
of the totals follows on its own: the chips, the streak, the completion rate, whether a
challenge is finished. None of them know flags exist. A flagged day that is never redone is
an ordinary missed day, with no special case anywhere.

That is also why nothing here writes to `posts`. A column there would have to be written by
something, and the only things allowed to write a post are its author and
`post_edit_guard()`, which exists precisely to stop a post changing after the group saw it.
So the post is left alone and the flag carries the verdict, which the app reads off rows it
already loads.

**Three rules are in the database** rather than in the page, because all three stop being
true the moment somebody writes their own request: you cannot flag your own post or vote on
the flag against it; one flag per post, ever, so a post the group already stood behind is
not re-litigated; and **when it closes is the database's**, not the browser's — a `closes_at`
the client picks is a clock the client can move.

It closes **three hours before the flagged person's own midnight**, wherever in the world
they are, worked out from `profiles.tz` — the same column the spin-day reminder runs on —
so there is still time to redo it. A flag raised after that hour has already gone gets half
an hour instead, so a late one still decides today rather than expiring on the spot or
running past the day it is about. Everybody eligible having voted closes it early.

**More agreeing than not upholds it; anything else, a tie included, leaves the post
standing.** A tie is not a coin toss — the post stands and its day stays counted, exactly as
if nothing had been said.

`close_due_flags()` is the one thing that writes an outcome, runs as the owner, and decides
by the same rule however it was reached: from the app at the top of every load, so whoever
is looking sees a result rather than a dead clock, and from `pg_cron` every ten minutes for
everybody who is not. Ten rather than the hour the wheel reminder uses, because a flag
closes at whatever minute its half hour lands on and a result fifty minutes late is one that
arrives after the person could have done anything about it.

`leftOf()` and `keepClocks()` are the running clock. One interval for every clock on the
page, started when there is one and stopped the moment there is not, because `render()`
calls it after it draws — a timer running on a screen with no clock on it is a wake-up every
second for nothing. A clock reaching zero asks the server for the answer rather than working
one out, throttled on `lastLoad`.

**This needs the v27 block of `schema.sql`.** Until it is run the two tables do not exist,
and the app loads them softly and draws itself without the feature — the same way comments
have worked since v2. A feature that is not switched on must not be a page that will not
come up. It also wants the `notify` function redeployed, which adds `flag` and `flag_closed`.

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

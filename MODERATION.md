# Moderation

Apple (Guideline 1.2) and Google both require an app with user posts to act on reports of
objectionable content **within 24 hours**. This is how Quota does that.

## What people can do in the app

| Action | Where | What happens |
|---|---|---|
| Report a post | ⋯ on the post → Report this post | A row in `public.reports` (`what = 'post'`) |
| Report a story | ⋯ on the story → Report this story | `what = 'story'` |
| Report a comment or message | Press and hold it → Report | `what = 'comment'` / `'message'` |
| Report a person | Their profile → Report | `what = 'user'` |
| Block a person | Their profile, a post's ⋯, or after reporting | Everything they make is hidden from the blocker at once; friendship and pending invites end. They are not told. |
| Remove a post from a group | ⋯ on the post, for whoever made the group | The post and its file are deleted |
| Delete own account | Settings → Delete my account | Everything is deleted straight away |

A report stores who reported, who was reported, the reason, an optional note, and a copy
of the words and the file path that were on screen, since the original may be deleted
before anyone looks. Only the accounts in `public.moderators` can read reports, through
Settings → Reports in the app. Anybody can file at most 10 reports in 24 hours.

## Setup, once

1. Run the v56 block of `supabase/schema.sql` (after v46), then deploy `moderation` and
   redeploy `notify`, `media` and `wheelday`.
2. Secrets the `moderation` function reads: `RESEND_API_KEY` (already there for the welcome
   email), `ANTHROPIC_API_KEY` (for polishing the reason; without it, or without credit, the
   moderator's own words are used, tidied, and nothing complains), and the push keys `notify`
   already has.
3. Moderators are the rows in `public.moderators`:

   ```sql
   insert into public.moderators (user_id, name)
     select id, case username when 'amarants' then 'Ari' else 'Justin' end
       from public.profiles where username in ('amarants', 'jsmith');
   ```

   `name` (v57) is what the Reports screen calls a moderator: "Only you and Justin can see
   this", and who decided something on Done. It falls back to the display name if empty.

   Notifications must be on in the app on that phone for the report push to arrive.
4. Put a daily reminder in your calendar to open Reports anyway. A push that doesn't
   arrive fails silently, and the 24-hour promise doesn't depend on it.

## The 24-hour process, in the app (v56)

**Settings → Reports**, or tap the push ("Sam's video in Mornings was reported for
harassment. Tap to review.").

- **The moment somebody reports a post, story, comment or message it is hidden** from
  everybody but whoever posted it (who sees it marked *Under review*) and the moderators.
  While it waits it still counts for the poster's day and streak.
- **Open** lists what is waiting, oldest first, one card per thing however many people
  reported it, with the poster's active strikes. **Done** is the record.
- **Keep it up** puts it back for everybody and closes every open report on it. No strike,
  no email to the poster. The reporters get "Thanks for reporting. We looked into it and
  it's staying up."
- **Take it down** removes it for good (the file is kept, privately), gives the poster a
  strike and emails them from safety@hitquota.app with the reason. Type the reason the way
  you would say it; the box underneath shows what the email will say, rewritten politely,
  and **Edit** changes it by hand. The reporters get "Thanks for reporting. We took it down."

| Strikes in the last 180 days | What happens |
|---|---|
| 1 | Warning email |
| 2 | Final warning email |
| 3 | Account suspended |
| **Serious** ticked (nudity, threats, hate) | Suspended now, whatever the count |
| Reported for self-harm | No strike. A supportive email with crisis resources instead |

While a report is open, whoever posted the thing can't delete it ("This is under review and
can't be deleted right now"), so the evidence is still there when you look. The database
enforces it in the delete policies (v57); once you decide either way, the usual rules apply.

Deleting a post still deletes the comments under it (and a reply goes with the comment it
answers). A report on any of those stays open anyway (v58): nothing deletes a report along
with what it is about. Reports shows the copy the database saved when it was filed (the words,
and the clip if the file is still there) under "The original was deleted. This is the copy
saved when it was reported." Take it down still strikes, emails and thanks the reporter;
Keep it up just closes it.

A report also outlives its reporter (v59): if whoever filed it deletes their account, the
report stays open and Reports says "Reporter deleted their account" where their name would
be. Deciding it works the same; there is just nobody left to thank.

Dates in the emails are on the poster's own calendar (their `profiles.tz`), or US Central if
the app has never seen their time zone.

A suspended account can still sign in and look, and sees a banner saying so. It cannot
post, story, comment or message: the database refuses it. **Lift suspension** is on the
report and on the Done item. If an email failed to send, **Retry email** is on the Done item.

Anything involving a minor: take it down with Serious ticked, report it to NCMEC
(CyberTipline, report.cybertip.org), and keep the evidence. Don't delete the account until
that's done; removed posts and their files are kept for exactly this.

A report filed by email gets the same treatment within the same 24 hours.

## The same, by hand (if the app is unavailable)

Everything above is `public.moderate_report()` underneath, and the SQL editor is still there:

```sql
select * from private.open_reports;   -- what is waiting, oldest first
```

Taking something down by hand is `update public.posts set removed_at = now() where id = <thing_id>;`
(likewise `stories`, `comments`, `messages`) and closing the report with
`update public.reports set resolved_at = now(), resolution = 'removed' where id = <id>;`.
That sends no email and gives no strike, so prefer the app.

To ban an account outright (they can't sign in again):

```sql
update auth.users set banned_until = 'infinity' where id = '<reported_id>';
```

## Reports by email

hello@hitquota.app is listed as the contact in the app, the terms and the support page.
Treat an emailed report the same way, within the same 24 hours. If it's about something
the email doesn't identify, ask for a username and a screenshot.

## Records

Resolved reports stay in `public.reports` with `resolved_at`, `resolution` (`kept` or
`removed`), who decided (`decided_by`), the reason that was emailed (`polished_reason`), the
strike it was, and whether the email went (`email_sent_at` / `email_error`). Strikes are in
`public.strikes`. That's the record if Apple or Google ever ask how a report was handled. To look back:

```sql
select * from public.reports where resolved_at is not null order by resolved_at desc;
```

## Proof that somebody agreed to the terms

Every time somebody agrees to the terms, the community guidelines and the privacy policy
(signing up, or agreeing again after the documents change), the database writes a row in
`public.consents` (v51). Nobody can change or delete these rows, including the account they
are about, the app, and the service key. They are kept after an account is deleted, which the
privacy policy says.

Each row has:
- when, by the database's clock
- the username and email at the time
- the version of the documents (`TERMS_VERSION` in `app/index.html`)
- a SHA-256 fingerprint of the exact wording the app showed
- how it happened: `signup`, `reaccept`, or `backfill` (carried over from the old profile
  column when v51 was run)
- the network address and browser it came from
- the app build

In the app: Settings → **Users & agreements** (moderators only, v52). Every account with
whether it is on the current terms, a search, a filter for anyone who isn't and for deleted
accounts, every agreement on record when you tap a person, and **Download CSV** for a
spreadsheet of all of it.

Or, in the Supabase SQL editor:

```sql
select * from private.agreements where email = 'someone@example.com';
select * from private.agreements where username = 'someone';
```

The wording behind any version is in this repository's history: check out the commit where
`TERMS_VERSION` was that date, and `site/terms.html` and `site/privacy.html` are the text.

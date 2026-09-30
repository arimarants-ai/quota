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
before anyone looks. Nobody can read reports through the app or the API.

## Setup, once

1. Run the v46 block of `supabase/schema.sql`, and redeploy `notify` (it gains the `report` kind).
2. Make yourselves moderators so each report sends a push notification to your phones:

   ```sql
   insert into public.moderators select id from public.profiles where username in ('ari', 'justin');
   ```

   (Use your real usernames. Notifications must be on in the app on that phone.)
3. Put a daily reminder in your calendar to check the queue anyway. A push that doesn't
   arrive fails silently, and the 24-hour promise doesn't depend on it.

## The 24-hour process

**Every day, and whenever a report notification arrives:**

1. Open the Supabase dashboard → SQL Editor and run:

   ```sql
   select * from private.open_reports;
   ```

   Oldest first. `waiting` is how long it has been open. Anything near 24 hours comes first.

2. **Look at it.** `body` is the text as reported. For a post or story, `media_path` is the
   file: Storage → `proof` (posts) or `stories` → that path. For the live row, use
   `thing_id` in `posts`, `stories`, `comments` or `messages`.

3. **Decide** against the Terms of Use and community guidelines (in the app, and at
   hitquota.app/terms):

   | Finding | Action |
   |---|---|
   | Doesn't break the rules | Resolve as `no action`. |
   | Breaks them, first time, not severe | Remove the content. Resolve as `removed`. |
   | Repeated, or harassment of a person | Remove the content and **ban** the account. |
   | Slurs, threats, sexual content, anything sexual involving a minor | Remove it and ban on the first time. For anything involving a minor, also report it to NCMEC (CyberTipline, report.cybertip.org) and keep the evidence. Don't delete the account until that's done. |

4. **Remove content** (this is the database; the file is removed in Storage):

   ```sql
   delete from public.posts where id = <thing_id>;        -- then delete media_path in Storage → proof
   delete from public.stories where id = <thing_id>;      -- then delete media_path in Storage → stories
   delete from public.comments where id = <thing_id>;
   delete from public.messages where id = <thing_id>;
   ```

5. **Ban an account** (they can't sign in again, and their session stops working when it next refreshes):

   ```sql
   update auth.users set banned_until = 'infinity' where id = '<reported_id>';
   -- and hide everything they made from everyone:
   delete from public.posts where user_id = '<reported_id>';
   delete from public.stories where user_id = '<reported_id>';
   delete from public.comments where user_id = '<reported_id>';
   ```

   Their files stay in Storage until the account is deleted. To delete the account too,
   remove their folders in Storage first (`proof/*/<id>/`, `stories/<id>/`, `avatars/<id>/`),
   then Authentication → Users → delete.

6. **Close the report:**

   ```sql
   update public.reports set resolved_at = now(), resolution = 'removed, banned'   -- or 'no action'
    where id = <id>;
   ```

7. If the reporter emailed as well, reply from hello@hitquota.app to say it was dealt with.
   Don't name what was done to the other person.

## Reports by email

hello@hitquota.app is listed as the contact in the app, the terms and the support page.
Treat an emailed report the same way, within the same 24 hours. If it's about something
the email doesn't identify, ask for a username and a screenshot.

## Records

Resolved reports stay in `public.reports` with `resolved_at` and `resolution`. That's the
record if Apple or Google ever ask how a report was handled. To look back:

```sql
select * from public.reports where resolved_at is not null order by resolved_at desc;
```

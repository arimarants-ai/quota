-- What row level security is supposed to stop, from a normal user's seat.
--
-- These policies had no tests at all until now: test/schema.test.sh was applying the
-- tables without the "enable row level security" statements, so every one of them was
-- being exercised against a database where RLS was simply switched off. Anything below
-- would have passed no matter what the policies said.
--
-- Run through test/schema.test.sh, which builds the database first.
\set ON_ERROR_STOP on

insert into auth.users values
  ('aaaaaaaa-0000-0000-0000-000000000001'),   -- in the group
  ('aaaaaaaa-0000-0000-0000-000000000002'),   -- in the group
  ('aaaaaaaa-0000-0000-0000-000000000003');   -- not in it
insert into public.profiles (id, username) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'polari'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'polsam'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'polnosy');
insert into public.groups (id, name, quotas) overriding system value
  values (90, 'Mornings', '[{"metric":"pushups","target":50}]');
insert into public.group_members values
  (90, 'aaaaaaaa-0000-0000-0000-000000000001'),
  (90, 'aaaaaaaa-0000-0000-0000-000000000002');
insert into public.posts (id, group_id, user_id, metric, amount, video_path, day) overriding system value
  values (900, 90, 'aaaaaaaa-0000-0000-0000-000000000001', 'pushups', 50, 'ari.mp4', current_date);
insert into public.comments (id, post_id, user_id, body) overriding system value
  values (900, 900, 'aaaaaaaa-0000-0000-0000-000000000001', 'nice');
select setval(pg_get_serial_sequence('public.groups', 'id'), 1);
select setval(pg_get_serial_sequence('public.posts', 'id'), 1);
select setval(pg_get_serial_sequence('public.comments', 'id'), 1);

-- ---- what the anon key can reach (v31, v32)
--
-- Checked here, before the blanket grant below hands app2 everything: this is about the
-- grant a function is created with, not about what a test role was given afterwards.
--
-- `revoke ... from public` alone does not do this on Supabase, and a plain Postgres cannot
-- show you that: Supabase grants EXECUTE on functions in `public` to anon and authenticated
-- *directly*, and revoking from PUBLIC leaves a direct grant standing. So every revoke here
-- names the roles, and these checks passed for a while against a database where two of them
-- were not true. Name the roles.
--
-- Both due_now functions claim what they return, so calling one is not a read — it spends
-- the reminder. PostgREST serves everything in `public` to whoever holds the anon key, and
-- that key ships inside index.html on purpose, so a function left on its default grant was
-- one POST away from anybody who viewed source. Repeated calls would have claimed every
-- pending reminder and sent none, with nothing anywhere saying why.
do $$
begin
  if has_function_privilege('anon', 'public.wheel_due_now()', 'EXECUTE') then
    raise exception 'anyone with the anon key could spend everybody''s spin-day reminders';
  end if;
  -- v34 replaced day_due_now() with one decision per person per day. The rule is the same
  -- and it matters more: this one claims all three kinds, so a caller who could spend them
  -- could silence somebody's whole day.
  if has_function_privilege('anon', 'public.notices_due_now()', 'EXECUTE') then
    raise exception 'anyone with the anon key could spend everybody''s notifications';
  end if;
  if has_function_privilege('authenticated', 'public.notices_due_now()', 'EXECUTE') then
    raise exception 'any signed-in account could spend everybody''s notifications';
  end if;
  -- And the one caller that does need it still has it.
  if not has_function_privilege('service_role', 'public.notices_due_now()', 'EXECUTE') then
    raise exception 'the cron cannot call notices_due_now, so no reminder would ever go out';
  end if;
  -- The window onto cron.job_run_details is the cron's own. It reports what is broken
  -- about the project, which is nobody else's business.
  if has_function_privilege('anon', 'public.cron_health(int)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cron_health(int)', 'EXECUTE') then
    raise exception 'the app can read which scheduled jobs are failing';
  end if;
  if not has_function_privilege('service_role', 'public.cron_health(int)', 'EXECUTE') then
    raise exception 'the cron cannot read its own health, so a failure stays silent';
  end if;
  -- How far into a challenge somebody is, is theirs and their group's, not the world's.
  if has_function_privilege('anon', 'public.challenge_day_count(bigint, date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.challenge_required(bigint)', 'EXECUTE') then
    raise exception 'a signed-out caller could read challenge progress';
  end if;
  -- The hour a prompt lands is not anybody's to look up for somebody else.
  if has_function_privilege('anon', 'public.slot_hour(uuid, date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.slot_hour(uuid, date)', 'EXECUTE') then
    raise exception 'the notification hour is readable by the app';
  end if;
  -- And the one v34 replaced is gone rather than left claiming rows under a default kind.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'day_due_now') then
    raise exception 'day_due_now is still here and would double-send against notices_due_now';
  end if;
  -- v33's invite link. code_group is deliberately open to anon: whoever follows a link has
  -- no account yet, and it answers with a name and nothing else. The other two are not.
  if not has_function_privilege('anon', 'public.code_group(text)', 'EXECUTE') then
    raise exception 'somebody following an invite link cannot be told which group it is for';
  end if;
  if has_function_privilege('anon', 'public.join_by_code(text)', 'EXECUTE') then
    raise exception 'a signed-out caller could add themselves to a group';
  end if;
  if has_function_privilege('anon', 'public.group_code(bigint, boolean)', 'EXECUTE') then
    raise exception 'a signed-out caller could mint an invite link for any group';
  end if;
  if not has_function_privilege('authenticated', 'public.join_by_code(text)', 'EXECUTE') then
    raise exception 'a signed-in account cannot take an invite link';
  end if;
  -- Muting is set through a function, not an update policy: a policy letting you write
  -- your own membership row would also let you rewrite its group_id, which is joining any
  -- group you can name. So there must be no update policy on that table at all.
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'group_members' and cmd = 'UPDATE') then
    raise exception 'group_members has an update policy, which is a way into any group';
  end if;
  if has_function_privilege('anon', 'public.mute_group(bigint, boolean)', 'EXECUTE') then
    raise exception 'a signed-out caller could mute somebody';
  end if;
  if not has_function_privilege('authenticated', 'public.mute_group(bigint, boolean)', 'EXECUTE') then
    raise exception 'a member cannot mute their own group';
  end if;
  -- Closing a flag is the other way round: the app calls it on every load, and applying a
  -- rule that is already true costs nothing and claims nothing.
  if not has_function_privilege('authenticated', 'public.close_due_flags()', 'EXECUTE') then
    raise exception 'the app cannot close a flag whose time is up';
  end if;
  if has_function_privilege('anon', 'public.close_due_flags()', 'EXECUTE') then
    raise exception 'a signed-out caller could close flags';
  end if;
end $$;

create role app2 nologin;
grant usage on schema public, auth to app2;
grant select, insert, update, delete on all tables in schema public to app2;
grant usage, select on all sequences in schema public to app2;
grant execute on all functions in schema public, auth to app2;
set role app2;

-- Helper: run a statement and say whether it was refused or silently affected nothing.
-- RLS refuses a write two different ways — an error on insert, zero rows on update and
-- delete — so both have to count as "stopped".
--
-- EXECUTE does not set FOUND, only GET DIAGNOSTICS. Reading FOUND here instead returns
-- whatever some earlier statement left behind, which made every update and delete check
-- below pass without touching the policies at all.
create or replace function pg_temp.blocked(stmt text) returns boolean
language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n = 0;              -- filtered out by the policy
exception when others then
  return true;               -- refused outright
end $$;

do $$
declare n int;
begin
  ---- somebody outside the group
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000003', true);

  select count(*) into n from public.posts;
  if n <> 0 then raise exception 'an outsider can read % posts', n; end if;

  select count(*) into n from public.comments;
  if n <> 0 then raise exception 'an outsider can read % comments', n; end if;

  select count(*) into n from public.group_members;
  if n <> 0 then raise exception 'an outsider can read the member list'; end if;

  if not pg_temp.blocked($q$insert into public.posts (group_id, user_id, metric, amount, video_path, day)
      values (90, 'aaaaaaaa-0000-0000-0000-000000000003', 'pushups', 50, 'x.mp4', current_date)$q$) then
    raise exception 'an outsider posted to a group they are not in';
  end if;

  if not pg_temp.blocked($q$insert into public.comments (post_id, user_id, body)
      values (900, 'aaaaaaaa-0000-0000-0000-000000000003', 'hello')$q$) then
    raise exception 'an outsider commented on a group they are not in';
  end if;

  -- Usernames are deliberately public: that is how you find someone to add.
  select count(*) into n from public.profiles;
  if n < 3 then raise exception 'usernames should be public, saw %', n; end if;

  ---- somebody inside the group, but not the author
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000002', true);

  select count(*) into n from public.posts;
  if n <> 1 then raise exception 'a member should see the group''s posts, saw %', n; end if;

  if not pg_temp.blocked($q$delete from public.posts where id = 900$q$) then
    raise exception 'a member deleted somebody else''s post';
  end if;

  if not pg_temp.blocked($q$delete from public.comments where id = 900$q$) then
    raise exception 'a member deleted somebody else''s comment';
  end if;

  if not pg_temp.blocked($q$update public.profiles set display_name = 'Nicked' where username = 'polari'$q$) then
    raise exception 'somebody edited another person''s profile';
  end if;

  -- Posting as someone else, from inside the group, is still forbidden.
  if not pg_temp.blocked($q$insert into public.posts (group_id, user_id, metric, amount, video_path, day)
      values (90, 'aaaaaaaa-0000-0000-0000-000000000001', 'pushups', 50, 'forged.mp4', current_date)$q$) then
    raise exception 'a member posted under somebody else''s name';
  end if;

  -- Nor is sending an invite in someone else's name.
  if not pg_temp.blocked($q$insert into public.invites (type, from_user, to_user)
      values ('friend', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003')$q$) then
    raise exception 'an invite was sent in somebody else''s name';
  end if;

  ---- the author
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000001', true);

  update public.profiles set display_name = 'Ari' where id = auth.uid();
  if (select display_name from public.profiles where id = auth.uid()) <> 'Ari' then
    raise exception 'nobody could edit their own profile';
  end if;

  delete from public.comments where id = 900;
  if exists (select 1 from public.comments where id = 900) then raise exception 'the author could not delete their own comment'; end if;

  delete from public.posts where id = 900;
  if exists (select 1 from public.posts where id = 900) then raise exception 'the author could not delete their own post'; end if;
end $$;

reset role;
\echo 'PASS: base policies'

-- v14: a like is governed by the post it is on.
-- Seeded as the owner: the fixtures are not what is under test. Someone outside the group can neither
-- see one nor leave one, and nobody can like as somebody else.
do $$
declare gid bigint; pid bigint;
begin
  insert into auth.users (id) values
    ('00000000-0000-0000-0000-0000000000e1'), ('00000000-0000-0000-0000-0000000000e2')
    on conflict do nothing;
  insert into public.profiles (id, username) values
    ('00000000-0000-0000-0000-0000000000e1', 'liker'), ('00000000-0000-0000-0000-0000000000e2', 'notinvited')
    on conflict do nothing;

  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e1', true);
  insert into public.groups (name, quotas, created_by)
    values ('likes', '[{"metric":"pushups","target":10}]', '00000000-0000-0000-0000-0000000000e1') returning id into gid;
  insert into public.group_members (group_id, user_id) values (gid, '00000000-0000-0000-0000-0000000000e1');
  insert into public.posts (group_id, user_id, metric, amount, video_path, day)
    values (gid, '00000000-0000-0000-0000-0000000000e1', 'pushups', 10, 'x.mp4', current_date) returning id into pid;
  -- From here on as app2, or the owner bypasses every policy below.
  set local role app2;

  -- A member may like it, once, and liking again is the same as having liked it.
  insert into public.likes (post_id, user_id) values (pid, '00000000-0000-0000-0000-0000000000e1');
  begin
    insert into public.likes (post_id, user_id) values (pid, '00000000-0000-0000-0000-0000000000e1');
    raise exception 'the same person liked the same post twice';
  exception when unique_violation then null; end;

  -- Not as somebody else, even from inside the group.
  if pg_temp.blocked(format($q$insert into public.likes (post_id, user_id) values (%s, '00000000-0000-0000-0000-0000000000e2')$q$, pid)) is false then
    raise exception 'a member liked a post as another person';
  end if;

  -- And not at all from outside it.
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e2', true);
  if pg_temp.blocked(format($q$insert into public.likes (post_id, user_id) values (%s, '00000000-0000-0000-0000-0000000000e2')$q$, pid)) is false then
    raise exception 'somebody outside the group liked a post in it';
  end if;
  if exists (select 1 from public.likes where post_id = pid) then
    raise exception 'somebody outside the group can see who liked a post in it';
  end if;

  -- The person who left it can take it back; nobody else can.
  if pg_temp.blocked(format($q$delete from public.likes where post_id = %s$q$, pid)) is false then
    raise exception 'somebody else removed a like that was not theirs';
  end if;
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e1', true);
  delete from public.likes where post_id = pid and user_id = '00000000-0000-0000-0000-0000000000e1';
  if exists (select 1 from public.likes where post_id = pid) then
    raise exception 'taking back your own like did nothing';
  end if;
end $$;

\echo 'PASS: like policies'


-- ---- questioning somebody's proof (v27)
--
-- Almost all of this feature is a rule about who may do what and when, so almost all of it
-- is policy. A line dropped here fails nowhere else: it lets somebody flag their own post,
-- or vote on the flag against it, or move the clock until they like the answer, and nothing
-- on screen would say a thing.
--
-- The group is four: the author and three who may vote on them.
reset role;
insert into auth.users values
  ('aaaaaaaa-0000-0000-0000-000000000004'),
  ('aaaaaaaa-0000-0000-0000-000000000005');
insert into public.profiles (id, username) values
  ('aaaaaaaa-0000-0000-0000-000000000004', 'polkit'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'polrose');
-- The author's own clock is what a flag closes against, so it is deliberately nowhere near
-- whatever this database is set to.
update public.profiles set tz = 'Pacific/Auckland' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into public.group_members values
  (90, 'aaaaaaaa-0000-0000-0000-000000000004'),
  (90, 'aaaaaaaa-0000-0000-0000-000000000005');
insert into public.posts (id, group_id, user_id, metric, amount, video_path, day) overriding system value
  values (901, 90, 'aaaaaaaa-0000-0000-0000-000000000001', 'pushups', 20, 'ari2.mp4', current_date),
         (903, 90, 'aaaaaaaa-0000-0000-0000-000000000001', 'pushups', 30, 'ari4.mp4', current_date),
         (904, 90, 'aaaaaaaa-0000-0000-0000-000000000001', 'pushups', 30, 'ari5.mp4', current_date),
         (905, 90, 'aaaaaaaa-0000-0000-0000-000000000001', 'pushups', 30, 'ari6.mp4', current_date);
set role app2;

-- Who may raise one, and who decides when it ends.
do $$
declare n int; fid bigint; shuts timestamptz; zone text; raiser uuid;
begin
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000003', true);
  if not pg_temp.blocked($q$insert into public.flags (post_id, by_user, reason)
      values (901, 'aaaaaaaa-0000-0000-0000-000000000003', 'nope')$q$) then
    raise exception 'an outsider flagged a post in a group they are not in';
  end if;
  select count(*) into n from public.flags;
  if n <> 0 then raise exception 'an outsider can read % flags', n; end if;

  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  if not pg_temp.blocked($q$insert into public.flags (post_id, by_user, reason)
      values (901, 'aaaaaaaa-0000-0000-0000-000000000001', 'flagging myself')$q$) then
    raise exception 'somebody flagged their own post';
  end if;

  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000002', true);
  -- Two things are sent deliberately wrong here, and neither is supposed to survive.
  --
  -- by_user names somebody else. That does not get refused, it gets overwritten: the guard
  -- puts auth.uid() there before the policy is even looked at. Refusing would be fine too —
  -- what must never happen is a row carrying the name of somebody who did not raise it.
  --
  -- closes_at is 400 days out. The database is supposed to throw it away and work out its
  -- own, or the clock is one the browser can move.
  insert into public.flags (post_id, by_user, reason, closes_at)
    values (901, 'aaaaaaaa-0000-0000-0000-000000000001', 'elbows barely bent', now() + interval '400 days')
    returning id, closes_at, by_user into fid, shuts, raiser;
  if raiser <> 'aaaaaaaa-0000-0000-0000-000000000002' then
    raise exception 'a flag was stored against somebody who did not raise it: %', raiser;
  end if;
  if shuts > now() + interval '2 days' then
    raise exception 'the browser set when the flag closes: %', shuts;
  end if;
  if shuts <= now() then raise exception 'a flag opened already closed'; end if;
  -- Three hours before the flagged person's own midnight, wherever in the world they are.
  -- Unless that hour has already gone, in which case half an hour, which is the other arm.
  select coalesce(nullif(tz, ''), 'UTC') into zone from public.profiles
    where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if (shuts at time zone zone)::time <> time '21:00'
     and shuts > now() + interval '31 minutes' then
    raise exception 'a flag with time on the clock closes at % local, not 21:00',
      (shuts at time zone zone)::time;
  end if;

  -- Raising one is a vote, or "everybody has voted" could never be reached in a pair. And
  -- it is a vote by whoever really raised it, not by the name that was sent.
  select count(*) into n from public.flag_votes where flag_id = fid and agree
    and user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  if n <> 1 then raise exception 'raising a flag did not count as agreeing with it, saw %', n; end if;

  -- One per post, ever: a post the group already stood behind is not asked about twice.
  if not pg_temp.blocked($q$insert into public.flags (post_id, by_user, reason)
      values (901, 'aaaaaaaa-0000-0000-0000-000000000002', 'again')$q$) then
    raise exception 'the same post was flagged twice';
  end if;

  -- Nobody writes an outcome or a deadline by hand: flags has no update policy at all.
  if not pg_temp.blocked(format($q$update public.flags set outcome = 'dismissed' where id = %s$q$, fid)) then
    raise exception 'somebody decided a flag by writing the answer straight in';
  end if;
  if not pg_temp.blocked(format($q$update public.flags set closes_at = now() - interval '1 hour' where id = %s$q$, fid)) then
    raise exception 'somebody moved the clock on a flag';
  end if;

  -- The person being flagged gets no vote, but does get to see it and read what was said.
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  if not pg_temp.blocked(format($q$insert into public.flag_votes (flag_id, user_id, agree)
      values (%s, 'aaaaaaaa-0000-0000-0000-000000000001', false)$q$, fid)) then
    raise exception 'the flagged person voted on their own flag';
  end if;
  select count(*) into n from public.flags where id = fid;
  if n <> 1 then raise exception 'the flagged person cannot see the flag against them'; end if;

  -- Voting in somebody else's name is not a thing either.
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000004', true);
  if not pg_temp.blocked(format($q$insert into public.flag_votes (flag_id, user_id, agree)
      values (%s, 'aaaaaaaa-0000-0000-0000-000000000002', false)$q$, fid)) then
    raise exception 'somebody voted in another person''s name';
  end if;

  -- One vote each is the primary key's job; changing it before the result is out is not a
  -- second vote, and a mis-tap nobody can undo is not a decision anyone wants to live with.
  insert into public.flag_votes (flag_id, user_id, agree) values (fid, auth.uid(), false);
  update public.flag_votes set agree = true where flag_id = fid and user_id = auth.uid();
  if not (select agree from public.flag_votes where flag_id = fid and user_id = auth.uid()) then
    raise exception 'nobody could change their mind before it closed';
  end if;

  -- Three eligible, three voted, two of them agreeing: it ends early and it is upheld.
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000005', true);
  insert into public.flag_votes (flag_id, user_id, agree) values (fid, auth.uid(), false);
  perform public.close_due_flags();
  if (select outcome from public.flags where id = fid) <> 'upheld' then
    raise exception 'everybody voting did not end it, or 2 against 1 did not uphold it: %',
      (select coalesce(outcome, 'still open') from public.flags where id = fid);
  end if;
  if (select closed_at from public.flags where id = fid) is null then
    raise exception 'a closed flag carries no closing time';
  end if;

  -- And once it is decided, it is decided.
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000004', true);
  if not pg_temp.blocked(format($q$update public.flag_votes set agree = false
      where flag_id = %s and user_id = auth.uid()$q$, fid)) then
    raise exception 'somebody changed their vote after the result was out';
  end if;
end $$;

-- More against than for: the post stands.
do $$
declare fid bigint;
begin
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000002', true);
  insert into public.flags (post_id, by_user, reason) values (905, auth.uid(), 'looks short') returning id into fid;
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000004', true);
  insert into public.flag_votes (flag_id, user_id, agree) values (fid, auth.uid(), false);
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000005', true);
  insert into public.flag_votes (flag_id, user_id, agree) values (fid, auth.uid(), false);
  perform public.close_due_flags();
  if (select outcome from public.flags where id = fid) <> 'dismissed' then
    raise exception 'one for and two against should leave the post standing, got %',
      (select coalesce(outcome, 'still open') from public.flags where id = fid);
  end if;
end $$;

-- An open one, still waiting on people, with time left on the clock, is left alone.
do $$
declare fid bigint;
begin
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000002', true);
  insert into public.flags (post_id, by_user, reason) values (904, auth.uid(), 'still thinking') returning id into fid;
  perform public.close_due_flags();
  if (select outcome from public.flags where id = fid) is not null then
    raise exception 'a flag still open and still waiting on people was closed early';
  end if;
end $$;

-- An even split is the case the rule is really about: a push, and the post stands. One of
-- the three never voted, so it is the clock that ends this one rather than a full house —
-- and the clock is wound back from outside, because no policy lets anybody move it.
do $$
begin
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000002', true);
  insert into public.flags (post_id, by_user, reason) values (903, auth.uid(), 'not sure about these');
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000004', true);
  insert into public.flag_votes (flag_id, user_id, agree)
    values ((select id from public.flags where post_id = 903), auth.uid(), false);
end $$;

reset role;
update public.flags set closes_at = now() - interval '1 minute' where post_id = 903;
set role app2;

do $$
begin
  perform set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000002', true);
  perform public.close_due_flags();
  if (select outcome from public.flags where post_id = 903) <> 'dismissed' then
    raise exception 'one each way is a push and the post stands, got %',
      (select coalesce(outcome, 'still open') from public.flags where post_id = 903);
  end if;
  if (select closed_at from public.flags where post_id = 903) is null then
    raise exception 'the clock running out did not close it';
  end if;
end $$;

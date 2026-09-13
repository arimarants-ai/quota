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

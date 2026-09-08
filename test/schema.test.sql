-- Assertions about schema.sql's v6 block. Every check raises on failure, so the file
-- either runs to the end or stops at the first thing that is wrong.
-- Run it with test/schema.test.sh, which builds a throwaway database first.
\set ON_ERROR_STOP on

insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222'), ('33333333-3333-3333-3333-333333333333');
insert into public.profiles (id, username) values
  ('11111111-1111-1111-1111-111111111111','ari'), ('22222222-2222-2222-2222-222222222222','sam'), ('33333333-3333-3333-3333-333333333333','outsider');
insert into public.groups (id, name, quotas) overriding system value values (1,'Mornings','[{"metric":"pushups","target":50}]');
insert into public.group_members values (1,'11111111-1111-1111-1111-111111111111'), (1,'22222222-2222-2222-2222-222222222222');

-- A chain of two: what the challenge is, then how many days it runs for. The day wheel is
-- deliberately impossible — 9 days on a 5-day cycle — to prove it gets clamped.
insert into public.wheels (id, group_id, name, every_days, starts_on) overriding system value
  values (1, 1, 'Challenge', 5, current_date - 10);
insert into public.wheel_stages (wheel_id, seq, kind, label, segments) values
  (1, 0, 'challenge', 'Your challenge', '["100 burpees","5k run","plank 3 min","cold shower"]'),
  (1, 1, 'days', 'On how many days', '[9,9,9,9]');

do $$
declare s public.spins; a bigint; b bigint; n int;
begin
  -- cycles are counted from the anchor, so everyone in the group is on the same one
  if public.wheel_cycle((select w from public.wheels w where id = 1), current_date) <> 2 then
    raise exception 'cycle math is wrong';
  end if;

  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  s := public.spin(1, current_date);
  if jsonb_array_length(s.results) <> 2 then raise exception 'both stages should be spun, got %', s.results; end if;
  if s.results->0->>'value' is null then raise exception 'the challenge landed on nothing'; end if;
  -- a day wheel can never ask for more days than the cycle has
  if s.days_required <> 5 then raise exception 'days_required should clamp to 5, got %', s.days_required; end if;

  -- Spinning again must return the same row. A dropped connection, a double tap or a
  -- force-quit mid-animation must not become a second roll.
  a := s.id;
  b := (public.spin(1, current_date)).id;
  if a <> b then raise exception 'spinning twice rolled again (% then %)', a, b; end if;
  select count(*) into n from public.spins where wheel_id = 1 and user_id = auth.uid();
  if n <> 1 then raise exception 'expected one spin row, found %', n; end if;

  -- a clock set forward cannot reach a cycle that has not arrived
  if (public.spin(1, current_date + 30)).cycle <> 2 then raise exception 'a wrong clock reached a future cycle'; end if;
end $$;

-- Posting is blocked until you have spun.
do $$
begin
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  insert into public.posts (group_id, user_id, metric, amount, video_path, day)
    values (1, '22222222-2222-2222-2222-222222222222', 'pushups', 50, 'x.mp4', current_date);
  raise exception 'a post went through without spinning';
exception when sqlstate 'P0001' then
  if sqlerrm = 'a post went through without spinning' then raise; end if;
  if sqlerrm not like 'Spin %' then raise exception 'wrong refusal: %', sqlerrm; end if;
end $$;

-- ...and goes through once you have.
do $$
declare n int;
begin
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  perform public.spin(1, current_date);
  insert into public.posts (group_id, user_id, metric, amount, video_path, day)
    values (1, '22222222-2222-2222-2222-222222222222', 'pushups', 50, 'x.mp4', current_date);
  select count(*) into n from public.unspun(1, '22222222-2222-2222-2222-222222222222', current_date);
  if n <> 0 then raise exception 'still % outstanding after spinning', n; end if;
end $$;

-- Only members, and only once the chain has started.
do $$
begin
  perform set_config('test.uid', '33333333-3333-3333-3333-333333333333', true);
  perform public.spin(1, current_date);
  raise exception 'someone outside the group spun';
exception when others then
  if sqlerrm = 'someone outside the group spun' then raise; end if;
  if sqlerrm not like '%not a member%' then raise exception 'wrong refusal: %', sqlerrm; end if;
end $$;

insert into public.wheels (id, group_id, name, every_days, starts_on) overriding system value
  values (2, 1, 'Future', 7, current_date + 3);
insert into public.wheel_stages (wheel_id, seq, kind, segments) values (2, 0, 'challenge', '["a","b"]');
do $$
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  perform public.spin(2, current_date);
  raise exception 'a wheel was spun before it started';
exception when others then
  if sqlerrm = 'a wheel was spun before it started' then raise; end if;
  if sqlerrm not like '%has not started%' then raise exception 'wrong refusal: %', sqlerrm; end if;
end $$;

-- ---- the same rules from a normal user's seat, where row level security applies
create role app nologin;
grant usage on schema public, auth to app;
grant select, insert, update, delete on all tables in schema public to app;
grant usage, select on all sequences in schema public to app;
grant execute on all functions in schema public, auth to app;
set role app;

do $$
declare n int; other bigint;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);

  -- A result you do not like cannot be forged, rewritten, or deleted and rolled again.
  begin
    insert into public.spins (wheel_id, user_id, cycle, results, days_required)
      values (1, auth.uid(), 99, '[{"value":"nothing at all"}]', 0);
    raise exception 'a spin was forged by hand';
  exception when insufficient_privilege or others then
    if sqlerrm = 'a spin was forged by hand' then raise; end if;
  end;

  update public.spins set results = '[{"value":"something easier"}]' where user_id = auth.uid();
  if found then raise exception 'a spin was rewritten'; end if;

  select count(*) into n from public.spins where user_id = auth.uid();
  delete from public.spins where user_id = auth.uid();
  if (select count(*) from public.spins where user_id = auth.uid()) <> n then
    raise exception 'a spin was deleted, so it could be rolled again';
  end if;

  -- Ticking days: your own only.
  insert into public.wheel_days (spin_id, day) select id, current_date from public.spins where user_id = auth.uid() limit 1;
  select id into other from public.spins where user_id <> auth.uid() limit 1;
  begin
    insert into public.wheel_days (spin_id, day) values (other, current_date - 1);
    raise exception 'ticked a day on someone else''s spin';
  exception when others then
    if sqlerrm = 'ticked a day on someone else''s spin' then raise; end if;
  end;

  -- Everyone in the group sees everyone's result. That is the whole point of it.
  select count(*) into n from public.spins;
  if n < 2 then raise exception 'group members should see each other''s spins, saw %', n; end if;

  -- Nobody outside it sees any of it.
  perform set_config('test.uid', '33333333-3333-3333-3333-333333333333', true);
  if (select count(*) from public.spins) <> 0 then raise exception 'an outsider can see spins'; end if;
  if (select count(*) from public.wheels) <> 0 then raise exception 'an outsider can see wheels'; end if;
  if (select count(*) from public.wheel_days) <> 0 then raise exception 'an outsider can see ticks'; end if;
end $$;

reset role;
\echo 'PASS: wheels schema'

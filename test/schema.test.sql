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
  -- the animation needs to know which slice, and needs the slices as they were
  if (s.results->0->>'i')::int is null then raise exception 'the spin did not record which slice it landed on'; end if;
  if s.results->0->'segs' <> '["100 burpees","5k run","plank 3 min","cold shower"]'::jsonb then
    raise exception 'the spin did not snapshot the slices, got %', s.results->0->'segs';
  end if;
  if s.results->0->'segs'->((s.results->0->>'i')::int) <> s.results->0->'value' then
    raise exception 'the recorded slice is not the one the value came from';
  end if;
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
-- The fixtures above set ids by hand, which leaves the identity sequence behind. Nothing
-- does that in the real app, so catch it up rather than letting it fail the next insert.
select setval(pg_get_serial_sequence('public.wheels', 'id'), (select max(id) from public.wheels));
select setval(pg_get_serial_sequence('public.groups', 'id'), (select max(id) from public.groups));
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

-- ---- save_wheel: one call, or nothing
do $$
declare wid bigint; n int;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  wid := public.save_wheel(null, 1, 'Extra', 4, current_date, 8, false,
    '[{"kind":"challenge","label":"What","segments":["a","b","c"]},{"kind":"days","label":"How long","segments":["1","2","3"]}]');
  select count(*) into n from public.wheel_stages where wheel_id = wid;
  if n <> 2 then raise exception 'expected 2 stages, got %', n; end if;

  -- editing replaces the slices wholesale
  perform public.save_wheel(wid, 1, 'Extra', 4, current_date, 9, true,
    '[{"kind":"challenge","label":"What","segments":["x","y"]}]');
  select count(*) into n from public.wheel_stages where wheel_id = wid;
  if n <> 1 then raise exception 'stages were not replaced, got %', n; end if;
  if not (select breaks_streak from public.wheels where id = wid) then raise exception 'breaks_streak did not save'; end if;

  -- a day wheel cannot ask for days the cycle does not have
  begin
    perform public.save_wheel(null, 1, 'Bad', 3, current_date, 8, false,
      '[{"kind":"challenge","segments":["a","b"]},{"kind":"days","segments":["1","9"]}]');
    raise exception 'a day wheel asked for more days than the cycle has';
  exception when others then
    if sqlerrm like 'a day wheel asked for%' then raise; end if;
  end;

  -- and the schedule is frozen once anyone has spun, or cycles would renumber underneath them
  begin
    perform public.save_wheel(1, 1, 'Challenge', 6, current_date - 10, 8, false,
      '[{"kind":"challenge","segments":["a","b"]}]');
    raise exception 'the schedule changed after people had spun';
  exception when others then
    if sqlerrm like 'the schedule changed%' then raise; end if;
  end;

  -- someone outside the group cannot make one
  perform set_config('test.uid', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.save_wheel(null, 1, 'Sneaky', 5, current_date, 8, false, '[{"kind":"challenge","segments":["a","b"]}]');
    raise exception 'an outsider made a wheel';
  exception when others then
    if sqlerrm like 'an outsider made%' then raise; end if;
  end;
end $$;

-- ---- v7: who gets told it is spin day, and when
-- The hard part is that "morning" is a different moment for everyone, and that a cron
-- firing twice must not wake anyone twice.
do $$
declare n int; today_utc date := current_date;
begin
  -- Only wheel 1 is in play. The save_wheel block above leaves an 'Extra' wheel in this
  -- same group, active, starting today, on a four-day cycle, with remind_hour 9 — so on any
  -- run where Ari's local hour happens to be 9 the counts below saw two wheels come due and
  -- read it as one person being reminded twice. It failed at 16:42 UTC, which is 09:42 in
  -- Los Angeles, and passed every other hour of the day.
  update public.wheels set active = false where id <> 1;
  -- Said out loud, so a block added above this one that leaves a wheel behind fails here
  -- rather than at whatever hour its remind_hour happens to collide on.
  select count(*) into n from public.wheels where active;
  if n <> 1 then raise exception 'this block counts every wheel that comes due, and % are active', n; end if;

  -- A wheel whose cycle starts today, for two people in very different places.
  update public.profiles set tz = 'America/Los_Angeles' where username = 'ari';
  update public.profiles set tz = 'Australia/Sydney' where username = 'sam';
  delete from public.spins;
  delete from public.wheel_reminders;
  update public.wheels set starts_on = (now() at time zone 'America/Los_Angeles')::date, every_days = 5, remind_hour = 8 where id = 1;

  -- Nobody is due unless it is their own 8am, so at most one of them can match right now.
  select count(*) into n from public.wheel_due_now();
  if n > 1 then raise exception 'two people in different zones were both due at once'; end if;

  -- Pin the hour: make it 8am for Ari wherever the clock happens to be.
  update public.wheels set remind_hour = extract(hour from (now() at time zone 'America/Los_Angeles'))::int where id = 1;
  update public.profiles set tz = 'Australia/Sydney' where username = 'sam';
  delete from public.wheel_reminders;
  select count(*) into n from public.wheel_due_now() where user_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'the person whose local hour matched was not due, got %', n; end if;

  -- ...and asking again returns nothing, because the reminder was already claimed.
  select count(*) into n from public.wheel_due_now();
  if n <> 0 then raise exception 'a second run would have sent the reminder twice, got %', n; end if;

  -- Someone who has already spun is not chased.
  delete from public.wheel_reminders;
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  perform public.spin(1, (now() at time zone 'America/Los_Angeles')::date);
  select count(*) into n from public.wheel_due_now() where user_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then raise exception 'someone who had already spun was reminded'; end if;

  -- A day that is not the start of a cycle is not spin day.
  delete from public.spins; delete from public.wheel_reminders;
  update public.wheels set starts_on = (now() at time zone 'America/Los_Angeles')::date - 2 where id = 1;
  select count(*) into n from public.wheel_due_now();
  if n <> 0 then raise exception 'a reminder went out two days into a five-day cycle'; end if;

  -- A wheel switched off says nothing.
  delete from public.wheel_reminders;
  update public.wheels set starts_on = (now() at time zone 'America/Los_Angeles')::date, active = false where id = 1;
  select count(*) into n from public.wheel_due_now();
  if n <> 0 then raise exception 'an inactive wheel still sent a reminder'; end if;
  update public.wheels set active = true where id = 1;

  -- Someone with no timezone recorded still gets one, worked out in UTC.
  delete from public.wheel_reminders;
  update public.profiles set tz = null where username = 'ari';
  update public.wheels set remind_hour = extract(hour from (now() at time zone 'UTC'))::int,
                           starts_on = (now() at time zone 'UTC')::date where id = 1;
  select count(*) into n from public.wheel_due_now() where user_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'someone with no timezone was skipped, got %', n; end if;
end $$;

-- ---- v8: a wheel belongs to whoever made it
do $$
declare wid bigint; n int;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  wid := public.save_wheel(null, 1, 'Ari''s wheel', 5, current_date, 8, false,
    '[{"kind":"challenge","segments":["a","b","c"]}]');

  -- Someone else in the group cannot rewrite it through the app...
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.save_wheel(wid, 1, 'Sam''s wheel now', 5, current_date, 8, false,
      '[{"kind":"challenge","segments":["easy","easier"]}]');
    raise exception 'someone else edited the wheel';
  exception when others then
    if sqlerrm = 'someone else edited the wheel' then raise; end if;
    if sqlerrm not like 'only whoever made this wheel%' then raise exception 'wrong refusal: %', sqlerrm; end if;
  end;

  -- ...but can still read what is on it, because they have to spin it.
  select count(*) into n from public.wheel_stages where wheel_id = wid;
  if n <> 1 then raise exception 'a member cannot see the slices they have to spin'; end if;

  -- The maker still can.
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  perform public.save_wheel(wid, 1, 'Renamed', 5, current_date, 8, false,
    '[{"kind":"challenge","segments":["a","b","c","d"]}]');
  if (select name from public.wheels where id = wid) <> 'Renamed' then raise exception 'the maker could not edit their own wheel'; end if;
end $$;

-- And the same from a normal seat, where row level security is what stops it.
set role app;
do $$
declare wid bigint; before text;
begin
  -- set_config(..., true) is transaction-local and each DO block is its own transaction,
  -- so the seat has to be taken before anything is read, or RLS hides the row and the
  -- checks below pass against nothing.
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  select id, name into wid, before from public.wheels where name = 'Renamed';
  if wid is null then raise exception 'the wheel to test against was not visible'; end if;

  update public.wheels set name = 'taken over' where id = wid;
  if (select name from public.wheels where id = wid) <> before then raise exception 'a non-maker renamed the wheel directly'; end if;

  delete from public.wheels where id = wid;
  if not exists (select 1 from public.wheels where id = wid) then raise exception 'a non-maker deleted the wheel'; end if;

  update public.wheel_stages set segments = '["easy","easy"]' where wheel_id = wid;
  if exists (select 1 from public.wheel_stages where wheel_id = wid and segments = '["easy","easy"]'::jsonb) then
    raise exception 'a non-maker rewrote the slices directly';
  end if;

  -- Reading is still open to the group.
  if not exists (select 1 from public.wheel_stages where wheel_id = wid) then
    raise exception 'a member can no longer see the slices';
  end if;

  -- The maker can still delete their own.
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  delete from public.wheels where id = wid;
  if exists (select 1 from public.wheels where id = wid) then raise exception 'the maker could not delete their own wheel'; end if;
end $$;
reset role;

-- ---- v9: sitting a cycle out
do $$
declare wid bigint; sp public.spins; n int; rolled jsonb;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  wid := public.save_wheel(null, 1, 'Sittable', 5, current_date, 8, false,
    '[{"kind":"challenge","segments":["a","b","c"]},{"kind":"days","segments":["1","2"]}]');

  -- Sam sits this one out.
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  sp := public.sit_out(wid, current_date);
  if not sp.sat_out then raise exception 'sitting out did not take'; end if;
  if sp.days_required <> 0 then raise exception 'a sat-out cycle should ask for no days, got %', sp.days_required; end if;

  -- ...which lifts the posting barrier for it, without a spin.
  -- Scoped to this wheel: earlier blocks left other wheels in the group unspun.
  select count(*) into n from public.unspun(1, '22222222-2222-2222-2222-222222222222', current_date) where id = wid;
  if n <> 0 then raise exception 'sitting out did not clear the barrier for this wheel'; end if;

  -- ...and stops the reminder chasing them.
  delete from public.wheel_reminders;
  update public.wheels set remind_hour = extract(hour from (now() at time zone 'UTC'))::int,
                           starts_on = (now() at time zone 'UTC')::date where id = wid;
  update public.profiles set tz = null;
  -- Ari, who has done nothing about it, is due; Sam, who sat out, is not. Checking both
  -- ways round, or "not reminded" would pass just as well if nobody were ever reminded.
  create temp table due_now on commit drop as select * from public.wheel_due_now();
  select count(*) into n from due_now where wheel_name = 'Sittable' and user_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'the person who has not dealt with it was not reminded, got %', n; end if;
  select count(*) into n from due_now where wheel_name = 'Sittable' and user_id = '22222222-2222-2222-2222-222222222222';
  if n <> 0 then raise exception 'someone sitting out was still reminded'; end if;
  update public.wheels set starts_on = current_date where id = wid;

  -- Changing your mind the other way round is allowed: a spin overwrites a sit-out.
  sp := public.spin(wid, current_date);
  if sp.sat_out then raise exception 'spinning after sitting out left it sat out'; end if;
  if jsonb_array_length(sp.results) <> 2 then raise exception 'the spin did not actually roll'; end if;
  select count(*) into n from public.spins where wheel_id = wid and user_id = '22222222-2222-2222-2222-222222222222';
  if n <> 1 then raise exception 'expected one row per person per cycle, found %', n; end if;

  -- But not back again. Sitting out after seeing a result would be a way to walk away
  -- from an answer you did not like, which is the whole thing this design prevents.
  rolled := sp.results;
  sp := public.sit_out(wid, current_date);
  if sp.sat_out then raise exception 'a result was escaped by sitting out afterwards'; end if;
  if sp.results <> rolled then raise exception 'sitting out changed an existing result'; end if;

  -- And spinning again still cannot re-roll.
  sp := public.spin(wid, current_date);
  if sp.results <> rolled then raise exception 'a second spin rolled again'; end if;
end $$;

-- ---- v10: a post carries the challenge it was done with
do $$
declare wid bigint; sp public.spins; other public.spins;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  -- Earlier blocks left several wheels running in this group, and the barrier quite
  -- rightly blocks on all of them. Only the new one matters here.
  update public.wheels set active = false where group_id = 1;
  wid := public.save_wheel(null, 1, 'Modifier', 5, current_date, 8, false,
    '[{"kind":"challenge","segments":["decline","diamond"]}]');
  sp := public.spin(wid, current_date);

  -- Ari pins a post to his own spin: fine.
  insert into public.posts (group_id, user_id, metric, amount, video_path, day, challenge, spin_id)
    values (1, '11111111-1111-1111-1111-111111111111', 'pushups', 25, 'a.mp4', current_date, 'decline', sp.id);
  if not exists (select 1 from public.posts where spin_id = sp.id and challenge = 'decline') then
    raise exception 'the challenge did not save onto the post';
  end if;

  -- A post with no challenge at all is still fine.
  insert into public.posts (group_id, user_id, metric, amount, video_path, day)
    values (1, '11111111-1111-1111-1111-111111111111', 'pushups', 25, 'b.mp4', current_date);
end $$;

-- Pinning a post to someone else's spin would fill their days, so row level security stops it.
set role app;
do $$
declare mine bigint;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  select id into mine from public.spins where user_id = '11111111-1111-1111-1111-111111111111' order by id desc limit 1;

  -- Sam sits the wheel out so the posting barrier is satisfied, leaving the spin_id rule
  -- as the only thing that can refuse this.
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  perform public.sit_out((select wheel_id from public.spins where id = mine), current_date);
  begin
    insert into public.posts (group_id, user_id, metric, amount, video_path, day, challenge, spin_id)
      values (1, '22222222-2222-2222-2222-222222222222', 'pushups', 25, 'c.mp4', current_date, 'decline', mine);
    raise exception 'a post was pinned to someone else''s spin';
  exception when others then
    if sqlerrm = 'a post was pinned to someone else''s spin' then raise; end if;
  end;
end $$;
reset role;

-- ---- v11: only your own challenge counts, and swapping is a decision about the cycle
do $$
declare wid bigint; mine public.spins; theirs public.spins; got text;
begin
  update public.wheels set active = false where group_id = 1;
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  wid := public.save_wheel(null, 1, 'Whose', 5, current_date, 8, false,
    '[{"kind":"challenge","segments":["decline","knuckle"]}]');
  mine := public.spin(wid, current_date);
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  theirs := public.spin(wid, current_date);
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);

  -- Ari spun a real challenge, so he may not take anyone else's: that is only for
  -- whoever lands on the borrow slice.
  got := (select r->>'value' from jsonb_array_elements(theirs.results) r where r->>'kind' = 'challenge' limit 1);
  begin
    perform public.use_challenge(mine.id, got);
    raise exception 'a challenge was swapped without landing on the borrow slice';
  exception when others then
    if sqlerrm like 'a challenge was swapped%' then raise; end if;
    if sqlerrm not like 'the wheel did not give you%' then raise exception 'wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- ---- v12: landing on the borrow slice, and only then
do $$
declare wid bigint; mine public.spins; theirs public.spins; got text;
begin
  update public.wheels set active = false where group_id = 1;
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  -- Every slice is the borrow slice, so Ari is certain to land on it.
  wid := public.save_wheel(null, 1, 'Borrow', 5, current_date, 8, false,
    format('[{"kind":"challenge","segments":[%s,%s]}]', to_json(public.borrow_slice()), to_json(public.borrow_slice()))::jsonb);
  mine := public.spin(wid, current_date);

  -- Sam needs a real challenge to lend, so his own wheel gives him one.
  update public.wheel_stages set segments = '["decline","decline"]' where wheel_id = wid;
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  theirs := public.spin(wid, current_date);
  got := (select r->>'value' from jsonb_array_elements(theirs.results) r where r->>'kind' = 'challenge' limit 1);
  if got <> 'decline' then raise exception 'the lender did not get a real challenge, got %', got; end if;

  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);

  -- Taking something nobody got is refused, or you could hand yourself anything.
  begin
    perform public.use_challenge(mine.id, 'one finger');
    raise exception 'a made-up challenge was accepted';
  exception when others then
    if sqlerrm like 'a made-up challenge was accepted' then raise; end if;
    if sqlerrm not like 'nobody else on this wheel got%' then raise exception 'wrong refusal: %', sqlerrm; end if;
  end;

  -- Nor the borrow slice itself: landing on it is an instruction, not a challenge.
  begin
    perform public.use_challenge(mine.id, public.borrow_slice());
    raise exception 'the borrow slice was taken as a challenge';
  exception when others then
    if sqlerrm like 'the borrow slice was taken%' then raise; end if;
  end;

  -- Taking what somebody else actually got is what it is for.
  mine := public.use_challenge(mine.id, got);
  if mine.challenge_override <> got then raise exception 'the swap did not take'; end if;

  -- Somebody else cannot swap it for you.
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.use_challenge(mine.id, got);
    raise exception 'someone else changed my challenge';
  exception when others then
    if sqlerrm like 'someone else changed%' then raise; end if;
    if sqlerrm not like 'that is not your spin%' then raise exception 'wrong refusal: %', sqlerrm; end if;
  end;
end $$;

\echo 'PASS: wheels schema'

-- v13: a group's rest days. All seven by default, and never nonsense.
do $$
declare gid bigint;
begin
  insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000d1') on conflict do nothing;
  insert into public.profiles (id, username) values ('00000000-0000-0000-0000-0000000000d1', 'restdays') on conflict do nothing;
  insert into public.groups (name, quotas, created_by)
    values ('every day', '[{"metric":"pushups","target":10}]', '00000000-0000-0000-0000-0000000000d1')
    returning id into gid;
  if (select active_days from public.groups where id = gid) <> array[0,1,2,3,4,5,6]::smallint[] then
    raise exception 'a group with nothing said about days should expect all seven';
  end if;

  update public.groups set active_days = array[1,3,5]::smallint[] where id = gid;
  if (select array_length(active_days, 1) from public.groups where id = gid) <> 3 then
    raise exception 'picking days did not stick';
  end if;

  begin
    update public.groups set active_days = array[]::smallint[] where id = gid;
    raise exception 'a group expecting nothing on any day should not be allowed';
  exception when check_violation then null; end;

  begin
    update public.groups set active_days = array[0,9]::smallint[] where id = gid;
    raise exception 'there is no ninth day of the week';
  exception when check_violation then null; end;
end $$;

-- v13: proof can be a picture as well as a clip.
do $$
begin
  if not (select allowed_mime_types @> array['image/*'] and allowed_mime_types @> array['video/*']
          from storage.buckets where id = 'proof') then
    raise exception 'the proof bucket should take both';
  end if;
end $$;

-- v40: the cron alert asks only about jobs that still run. An unscheduled job's failures
-- stay in the run history for a day, and v37 alerted on them as "unnamed job 3" after the
-- job had already been retired.
do $$
begin
  insert into cron.job (jobid, jobname) values (901, 'still-here'), (902, 'switched-off');
  update cron.job set active = false where jobid = 902;
  insert into cron.job_run_details (jobid, runid, status, return_message, start_time) values
    (901, 1, 'failed', 'ERROR: broken', now() - interval '1 hour'),
    (902, 2, 'failed', 'ERROR: paused', now() - interval '1 hour'),
    (903, 3, 'failed', 'ERROR: gone', now() - interval '1 hour'),   -- unscheduled: no cron.job row
    (901, 4, 'failed', 'ERROR: old', now() - interval '30 hours');
  if (select count(*) from public.cron_health()) <> 1
     or (select jobname from public.cron_health()) <> 'still-here'
     or (select failures from public.cron_health()) <> 1 then
    raise exception 'cron_health should report only scheduled, active jobs inside the window: %',
      (select json_agg(h) from public.cron_health() h);
  end if;
  delete from cron.job_run_details where jobid in (901, 902, 903);
  delete from cron.job where jobid in (901, 902);
end $$;

-- v41: the author can change a caption, and nothing the group saw moves with it.
reset role;
update public.wheels set active = false where group_id = 1;   -- no spin barrier in the way
set role app;
do $$
declare pid bigint; p public.posts;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  insert into public.posts (group_id, user_id, metric, amount, video_path, day, caption)
    values (1, auth.uid(), 'pushups', 30, 'caption.mp4', current_date, 'before') returning id into pid;
  update public.posts set caption = 'after', amount = 999, day = current_date - 5,
    challenge = 'forged', video_path = 'swapped.mp4' where id = pid;
  select * into p from public.posts where id = pid;
  if p.caption is distinct from 'after' then
    raise exception 'a caption edit did not save, it is still %', p.caption;
  end if;
  if p.amount <> 30 or p.day <> current_date or p.video_path <> 'caption.mp4' or p.challenge is not null then
    raise exception 'something the group saw changed after posting: %', row_to_json(p);
  end if;
end $$;

-- v42: an account can exist before it has a username, and a username once taken stays.
reset role;
insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777', 'new@example.com');
insert into public.profiles (id) values ('77777777-7777-7777-7777-777777777777');
do $$
begin
  if to_regclass('public.recovery_codes') is not null or to_regclass('public.recovery_attempts') is not null then
    raise exception 'recovery codes are gone with email resets, and their tables should be too';
  end if;
end $$;
set role app;
do $$
declare n int;
begin
  -- Somebody else cannot see an account that is not finished: it has no name to find it by.
  perform set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into n from public.profiles where id = '77777777-7777-7777-7777-777777777777';
  if n <> 0 then raise exception 'a half-made account showed up for somebody else'; end if;

  -- Its owner can see it, and finish it.
  perform set_config('test.uid', '77777777-7777-7777-7777-777777777777', true);
  select count(*) into n from public.profiles where id = auth.uid();
  if n <> 1 then raise exception 'you should always see your own row, finished or not'; end if;
  update public.profiles set username = 'newbie' where id = auth.uid();
  if (select username from public.profiles where id = auth.uid()) is distinct from 'newbie' then
    raise exception 'claiming a username on your own unfinished account did not save';
  end if;

  -- And then it is fixed.
  begin
    update public.profiles set username = 'renamed' where id = auth.uid();
    raise exception 'a username changed after it was taken';
  exception when raise_exception then
    if sqlerrm = 'a username changed after it was taken' then raise; end if;
  end;
end $$;


reset role;
-- v43: one row per person, and it had better not be an endpoint.
do $$
declare full_id uuid := '55555555-5555-5555-5555-555555555555';
        half_id uuid := '66666666-6666-6666-6666-666666666666';
        got record;
begin
  -- The whole point of putting it in `private`: PostgREST serves public, so a view of
  -- email addresses there would be a URL that hands them out.
  if exists (select 1 from information_schema.views where table_schema = 'public' and table_name = 'people') then
    raise exception 'private.people must not have a twin in the public schema';
  end if;
  if not exists (select 1 from information_schema.views where table_schema = 'private' and table_name = 'people') then
    raise exception 'private.people is missing';
  end if;

  -- The profile row is inserted rather than left to the signup trigger: this harness
  -- applies the tables without it, so an update here would quietly touch nothing.
  insert into auth.users (id, email, email_confirmed_at) values (full_id, 'nobody@example.com', now());
  insert into public.profiles (id, username, display_name, birthday, gender)
    values (full_id, 'viewtest', 'View Test', current_date - interval '30 years', 'unsaid');

  select * into got from private.people where id = full_id;
  if got is null then raise exception 'the view has no row for somebody who exists'; end if;
  if got.email is distinct from 'nobody@example.com' then raise exception 'the address did not come through'; end if;
  if got.full_name is distinct from 'View Test' then raise exception 'the name did not come through'; end if;
  if got.username is distinct from 'viewtest' then raise exception 'the username did not come through'; end if;
  if got.gender is distinct from 'unsaid' then raise exception 'the gender did not come through'; end if;
  if got.confirmed is not true then raise exception 'confirmed should be true'; end if;
  if got.finished_setup is not true then raise exception 'a row with a username is finished'; end if;
  -- Worked out rather than stored, so it cannot go stale.
  if got.age is distinct from 30 then raise exception 'age should be 30, got %', got.age; end if;

  -- Somebody who signed up and never finished. A second account rather than unpicking the
  -- first, because v42 refuses to let a username be changed once it is taken.
  insert into auth.users (id, email) values (half_id, 'halfway@example.com');
  insert into public.profiles (id) values (half_id);

  select * into got from private.people where id = half_id;
  if got is null then raise exception 'an unfinished account should still be in the view'; end if;
  if got.finished_setup is not false then raise exception 'a row with no username is not finished'; end if;
  if got.confirmed is not false then raise exception 'an unconfirmed address is not confirmed'; end if;
  if got.email is distinct from 'halfway@example.com' then raise exception 'the address is there either way'; end if;
  if got.age is not null then raise exception 'no birthday means no age'; end if;
end $$;

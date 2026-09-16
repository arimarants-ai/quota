-- Quota database. Paste this whole file into Supabase → SQL Editor → Run.

-- profiles: one row per account, created automatically on signup
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  created_at timestamptz default now()
);

create table public.groups (
  id bigint generated always as identity primary key,
  name text not null,
  goal text not null default '',
  quotas jsonb not null,               -- [{"metric":"pushups","target":100}]
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz default now()
);

create table public.group_members (
  group_id bigint references public.groups on delete cascade,
  user_id uuid references public.profiles on delete cascade,
  primary key (group_id, user_id)
);

-- one row per friendship, a < b so a pair can only exist once
create table public.friendships (
  a uuid references public.profiles on delete cascade,
  b uuid references public.profiles on delete cascade,
  primary key (a, b),
  check (a < b)
);

create table public.invites (
  id bigint generated always as identity primary key,
  type text not null check (type in ('friend', 'group')),
  from_user uuid not null references public.profiles on delete cascade,
  to_user uuid not null references public.profiles on delete cascade,
  group_id bigint references public.groups on delete cascade,
  created_at timestamptz default now(),
  check (from_user <> to_user),
  check ((type = 'group') = (group_id is not null))
);
create unique index invites_once on public.invites (type, from_user, to_user, coalesce(group_id, 0));

create table public.posts (
  id bigint generated always as identity primary key,
  group_id bigint not null references public.groups on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  metric text not null,
  amount int not null check (amount > 0),
  caption text not null default '',
  video_path text not null,            -- storage path: <group_id>/<user_id>/<file>
  day date not null,                   -- the poster's local calendar day
  created_at timestamptz default now()
);
create index posts_group_day on public.posts (group_id, day);

-- create a profile row whenever someone signs up (username comes from signUp metadata)
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username) values (new.id, lower(new.raw_user_meta_data->>'username'));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- helper used by every policy below. security definer so policies don't recurse.
create function public.is_member(gid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = gid and user_id = auth.uid());
$$;

create function public.create_group(p_name text, p_goal text, p_quotas jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare gid bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.groups (name, goal, quotas, created_by) values (p_name, p_goal, p_quotas, auth.uid()) returning id into gid;
  insert into public.group_members (group_id, user_id) values (gid, auth.uid());
  return gid;
end $$;

-- only the invited person can accept; does both sides of the write in one go
create function public.accept_invite(invite_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare i public.invites;
begin
  select * into i from public.invites where id = invite_id and to_user = auth.uid();
  if i.id is null then raise exception 'invite not found'; end if;
  if i.type = 'friend' then
    insert into public.friendships (a, b) values (least(i.from_user, i.to_user), greatest(i.from_user, i.to_user)) on conflict do nothing;
  else
    insert into public.group_members (group_id, user_id) values (i.group_id, i.to_user) on conflict do nothing;
  end if;
  delete from public.invites where id = invite_id;
end $$;

-- row level security: who can see and change what
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.friendships enable row level security;
alter table public.invites enable row level security;
alter table public.posts enable row level security;

create policy "usernames are public" on public.profiles for select using (true);

create policy "members and invitees see the group" on public.groups for select
  using (public.is_member(id) or exists (select 1 from public.invites i where i.group_id = groups.id and i.to_user = auth.uid()));
create policy "members edit the group" on public.groups for update using (public.is_member(id));

create policy "members see the member list" on public.group_members for select using (public.is_member(group_id));
create policy "leave a group" on public.group_members for delete using (user_id = auth.uid());

create policy "see own friendships" on public.friendships for select using (auth.uid() in (a, b));
create policy "unfriend" on public.friendships for delete using (auth.uid() in (a, b));

create policy "see own invites" on public.invites for select using (auth.uid() in (from_user, to_user));
create policy "send invites" on public.invites for insert with check (from_user = auth.uid() and (type = 'friend' or public.is_member(group_id)));
create policy "cancel or decline invites" on public.invites for delete using (auth.uid() in (from_user, to_user));

create policy "members see posts" on public.posts for select using (public.is_member(group_id));
create policy "members post" on public.posts for insert with check (user_id = auth.uid() and public.is_member(group_id));
create policy "delete own posts" on public.posts for delete using (user_id = auth.uid());

-- video storage: private bucket, files live at <group_id>/<user_id>/<file>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('proof', 'proof', false, 52428800, array['video/*']);
create policy "members watch proof" on storage.objects for select
  using (bucket_id = 'proof' and public.is_member(((storage.foldername(name))[1])::bigint));
create policy "members upload own proof" on storage.objects for insert
  with check (bucket_id = 'proof' and (storage.foldername(name))[2] = auth.uid()::text and public.is_member(((storage.foldername(name))[1])::bigint));
create policy "delete own proof" on storage.objects for delete
  using (bucket_id = 'proof' and (storage.foldername(name))[2] = auth.uid()::text);

-- ============================================================
-- v2 (redesign): comments on posts. Safe to run on an existing project.
-- ============================================================
create table if not exists public.comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  body text not null check (length(body) between 1 and 500),
  created_at timestamptz default now()
);
create index if not exists comments_post on public.comments (post_id);
alter table public.comments enable row level security;
drop policy if exists "members see comments" on public.comments;
drop policy if exists "members comment" on public.comments;
drop policy if exists "delete own comments" on public.comments;
create policy "members see comments" on public.comments for select
  using (public.is_member((select group_id from public.posts where id = post_id)));
create policy "members comment" on public.comments for insert
  with check (user_id = auth.uid() and public.is_member((select group_id from public.posts where id = post_id)));
create policy "delete own comments" on public.comments for delete using (user_id = auth.uid());

-- ============================================================
-- v3 (profile): display name + profile picture. Safe to run on an existing project.
-- ============================================================
alter table public.profiles add column if not exists display_name text check (length(display_name) between 1 and 40);
alter table public.profiles add column if not exists avatar_path text;
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', true, 5242880, array['image/*']) on conflict (id) do nothing;
drop policy if exists "avatars are public" on storage.objects;
drop policy if exists "upload own avatar" on storage.objects;
drop policy if exists "replace own avatar" on storage.objects;
drop policy if exists "delete own avatar" on storage.objects;
create policy "avatars are public" on storage.objects for select using (bucket_id = 'avatars');
create policy "upload own avatar" on storage.objects for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "replace own avatar" on storage.objects for update using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own avatar" on storage.objects for delete using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- v4 (push): notify a group when someone posts. Safe to run on an existing project.
-- Replace <HOOK_SECRET> with the same value you set as the function's HOOK_SECRET.
-- ============================================================

-- one row per installed app; the endpoint is unique per device+install
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "own push subscriptions" on public.push_subscriptions;
create policy "own push subscriptions" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- pg_net lets a trigger call the edge function without blocking the insert
create extension if not exists pg_net;

create or replace function public.notify_group_of_post() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://txvjakpeyfnzigtsvmja.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', '<HOOK_SECRET>'),
    body    := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end $$;

drop trigger if exists posts_notify on public.posts;
create trigger posts_notify after insert on public.posts
  for each row execute function public.notify_group_of_post();

-- ============================================================
-- v5 (recovery codes): reset a forgotten password without email.
-- Safe to run on an existing project.
-- ============================================================

-- One row per issued code. Only the recovery edge function, running as the service
-- role, ever touches these tables. RLS is on with no policies at all, which means the
-- anon and authenticated keys can read and write exactly nothing here.
create table if not exists public.recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  code_hash text not null,          -- sha-256 of the code; the code itself is shown once and never stored
  used_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists recovery_codes_unused on public.recovery_codes (user_id, code_hash) where used_at is null;
alter table public.recovery_codes enable row level security;

-- Failed redeem attempts, so a known username can't be brute-forced against the code space.
create table if not exists public.recovery_attempts (
  id bigint generated always as identity primary key,
  key text not null,                -- 'u:<username>' or 'ip:<address>'
  at timestamptz not null default now()
);
create index if not exists recovery_attempts_key_at on public.recovery_attempts (key, at desc);
alter table public.recovery_attempts enable row level security;

-- ============================================================
-- v6 (wheels): a group can make everyone spin a wheel on a schedule.
-- Safe to run on an existing project.
-- ============================================================

-- A wheel is a CHAIN of stages spun together on one schedule: usually "what is the
-- challenge" followed by "for how many days". The chain is the thing that has a cadence,
-- a reminder and a spin; the stages are what you actually see spin, one after another.
-- A group can have several chains, each on its own schedule.
create table if not exists public.wheels (
  id bigint generated always as identity primary key,
  group_id bigint not null references public.groups on delete cascade,
  name text not null check (length(name) between 1 and 40),
  every_days int not null check (every_days between 1 and 60),
  starts_on date not null,             -- the anchor. cycle n runs from starts_on + n*every_days
  remind_hour int not null default 8 check (remind_hour between 0 and 23),
  breaks_streak boolean not null default false,   -- does missing the challenge break the group streak
  active boolean not null default true,
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz default now()
);
create index if not exists wheels_group on public.wheels (group_id) where active;

create table if not exists public.wheel_stages (
  id bigint generated always as identity primary key,
  wheel_id bigint not null references public.wheels on delete cascade,
  seq int not null,                    -- 0 spins first, then 1, and so on
  kind text not null check (kind in ('challenge', 'days')),
  label text not null default '',
  segments jsonb not null,             -- challenge: ["100 burpees", ...]   days: [0, 1, 2, 3]
  unique (wheel_id, seq),
  check (jsonb_typeof(segments) = 'array' and jsonb_array_length(segments) between 2 and 24)
);

-- One row per person per chain per cycle. This is the record of what you got, written
-- BEFORE the wheel is animated: the client draws whatever this says. Force-quitting
-- mid-spin, a dropped connection or a second tap all land on the same result, so there
-- is no way to spin until you like the answer.
create table if not exists public.spins (
  id bigint generated always as identity primary key,
  wheel_id bigint not null references public.wheels on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  cycle int not null,
  results jsonb not null,              -- [{"seq":0,"kind":"challenge","label":"…","value":"100 burpees"}, …]
  days_required int not null default 1 check (days_required >= 0),
  created_at timestamptz default now(),
  unique (wheel_id, user_id, cycle)
);
create index if not exists spins_wheel_cycle on public.spins (wheel_id, cycle);

-- Ticking off a day you did the challenge. Any day inside the cycle counts.
create table if not exists public.wheel_days (
  spin_id bigint not null references public.spins on delete cascade,
  day date not null,
  primary key (spin_id, day)
);

-- ---- helpers

-- Which cycle a date falls in. Negative before the chain starts, which is how "not
-- running yet" is expressed without a second column.
create or replace function public.wheel_cycle(w public.wheels, d date) returns int
language sql immutable as $$ select floor((d - w.starts_on)::numeric / w.every_days)::int $$;

-- The chains in a group that are due right now and that this person has not spun.
-- Used by the barrier below and by the app to decide what to put in front of you.
create or replace function public.unspun(gid bigint, uid uuid, d date) returns setof public.wheels
language sql stable security definer set search_path = public as $$
  select w.* from public.wheels w
  where w.group_id = gid and w.active and d >= w.starts_on
    and not exists (
      select 1 from public.spins s
      where s.wheel_id = w.id and s.user_id = uid and s.cycle = public.wheel_cycle(w, d)
    )
$$;

-- ---- spinning
-- The server picks the segment, not the browser. Two reasons: the result cannot be
-- chosen by editing the page, and the row exists before anyone has seen it.
-- Re-running this for a cycle already spun returns the original row untouched.
create or replace function public.spin(p_wheel bigint, p_day date default null)
returns public.spins
language plpgsql security definer set search_path = public as $$
declare
  w public.wheels;
  d date;
  c int;
  st public.wheel_stages;
  picked jsonb := '[]'::jsonb;
  value jsonb;
  idx int;
  req int := 1;
  out public.spins;
begin
  select * into w from public.wheels where id = p_wheel;
  if not found or not w.active then raise exception 'no such wheel'; end if;
  if not public.is_member(w.group_id) then raise exception 'not a member of that group'; end if;

  -- The caller's own calendar day, the way posts already work, but never more than a day
  -- away from the server's, so a wrong clock cannot spin a cycle that has not arrived.
  d := coalesce(p_day, current_date);
  if d > current_date + 1 or d < current_date - 1 then d := current_date; end if;
  if d < w.starts_on then raise exception 'that wheel has not started yet'; end if;
  c := public.wheel_cycle(w, d);

  for st in select * from public.wheel_stages where wheel_id = w.id order by seq loop
    idx := floor(random() * jsonb_array_length(st.segments))::int;
    value := st.segments -> idx;
    -- 'i' is which slice, so the wheel can be animated to the answer it already has.
    -- 'segs' is the slices as they were, so editing the wheel later cannot rewrite the
    -- picture of a spin somebody already did.
    picked := picked || jsonb_build_object('seq', st.seq, 'kind', st.kind, 'label', st.label,
                                           'value', value, 'i', idx, 'segs', st.segments);
    -- A day stage says how many days the challenge has to be done on. Never more days
    -- than the cycle is long, whatever someone typed onto the wheel.
    if st.kind = 'days' then req := least(greatest(coalesce((value #>> '{}')::int, 1), 0), w.every_days); end if;
  end loop;

  insert into public.spins (wheel_id, user_id, cycle, results, days_required)
  values (w.id, auth.uid(), c, picked, req)
  on conflict (wheel_id, user_id, cycle) do nothing;

  select * into out from public.spins where wheel_id = w.id and user_id = auth.uid() and cycle = c;
  return out;
end $$;

-- ---- creating and editing
-- Stages are replaced wholesale on an edit; spins keep their own snapshot, so history is
-- not touched by it.
create or replace function public.save_wheel(
  p_id bigint, p_group bigint, p_name text, p_every int, p_starts date,
  p_hour int, p_breaks boolean, p_stages jsonb
) returns bigint
language plpgsql security definer set search_path = public as $$
declare wid bigint; st jsonb; seg jsonb; n int; existing public.wheels;
begin
  if not public.is_member(p_group) then raise exception 'not a member of that group'; end if;
  if p_every < 1 or p_every > 60 then raise exception 'a wheel has to be spun somewhere between every day and every 60 days'; end if;
  if jsonb_array_length(p_stages) < 1 then raise exception 'a wheel needs something on it'; end if;

  for st in select value from jsonb_array_elements(p_stages) loop
    n := jsonb_array_length(st->'segments');
    if n < 2 or n > 24 then raise exception 'each wheel needs between 2 and 24 slices, got %', n; end if;
    -- A day wheel can only ask for days the cycle actually contains.
    if st->>'kind' = 'days' then
      for seg in select value from jsonb_array_elements(st->'segments') loop
        if (seg #>> '{}') !~ '^[0-9]+$' or (seg #>> '{}')::int > p_every then
          raise exception 'a day wheel spun every % days cannot ask for %', p_every, seg #>> '{}';
        end if;
      end loop;
    end if;
  end loop;

  if p_id is null or p_id = 0 then
    insert into public.wheels (group_id, name, every_days, starts_on, remind_hour, breaks_streak, created_by)
      values (p_group, p_name, p_every, p_starts, p_hour, p_breaks, auth.uid()) returning id into wid;
  else
    select * into existing from public.wheels where id = p_id;
    if not found or not public.is_member(existing.group_id) then raise exception 'no such wheel'; end if;
    -- Cycles are counted from the anchor, so moving it once people have spun would
    -- renumber history and strand results in cycles that no longer exist.
    if exists (select 1 from public.spins where wheel_id = p_id)
       and (existing.every_days <> p_every or existing.starts_on <> p_starts) then
      raise exception 'the schedule cannot change once people have started spinning';
    end if;
    update public.wheels set name = p_name, every_days = p_every, starts_on = p_starts,
      remind_hour = p_hour, breaks_streak = p_breaks where id = p_id;
    wid := p_id;
    delete from public.wheel_stages where wheel_id = wid;
  end if;

  insert into public.wheel_stages (wheel_id, seq, kind, label, segments)
  select wid, (ord - 1)::int, t.st->>'kind', coalesce(t.st->>'label', ''), t.st->'segments'
  from jsonb_array_elements(p_stages) with ordinality as t(st, ord);
  return wid;
end $$;

-- ---- the barrier
-- Spinning is a rule, not a suggestion, so it is enforced here rather than in the page.
-- The app checks first and opens the wheel, so this exception is the backstop for anyone
-- who goes around it.
create or replace function public.require_spin() returns trigger
language plpgsql security definer set search_path = public as $$
declare pending text;
begin
  select string_agg(name, ', ') into pending from public.unspun(new.group_id, new.user_id, new.day);
  if pending is not null then
    raise exception 'Spin % before posting to this group', pending using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists posts_require_spin on public.posts;
create trigger posts_require_spin before insert on public.posts
  for each row execute function public.require_spin();

-- ---- who can see and change what
alter table public.wheels enable row level security;
alter table public.wheel_stages enable row level security;
alter table public.spins enable row level security;
alter table public.wheel_days enable row level security;

drop policy if exists "members see wheels" on public.wheels;
drop policy if exists "members make wheels" on public.wheels;
drop policy if exists "members edit wheels" on public.wheels;
drop policy if exists "members delete wheels" on public.wheels;
create policy "members see wheels" on public.wheels for select using (public.is_member(group_id));
create policy "members make wheels" on public.wheels for insert with check (public.is_member(group_id));
create policy "members edit wheels" on public.wheels for update using (public.is_member(group_id));
create policy "members delete wheels" on public.wheels for delete using (public.is_member(group_id));

drop policy if exists "members see stages" on public.wheel_stages;
drop policy if exists "members write stages" on public.wheel_stages;
create policy "members see stages" on public.wheel_stages for select
  using (exists (select 1 from public.wheels w where w.id = wheel_id and public.is_member(w.group_id)));
create policy "members write stages" on public.wheel_stages for all
  using (exists (select 1 from public.wheels w where w.id = wheel_id and public.is_member(w.group_id)))
  with check (exists (select 1 from public.wheels w where w.id = wheel_id and public.is_member(w.group_id)));

-- Everyone in the group sees everyone's result: that is the point of it.
-- Nobody can write one by hand, though — public.spin() is the only way in.
drop policy if exists "members see spins" on public.spins;
create policy "members see spins" on public.spins for select
  using (exists (select 1 from public.wheels w where w.id = wheel_id and public.is_member(w.group_id)));

drop policy if exists "members see ticks" on public.wheel_days;
drop policy if exists "tick your own days" on public.wheel_days;
drop policy if exists "untick your own days" on public.wheel_days;
create policy "members see ticks" on public.wheel_days for select
  using (exists (select 1 from public.spins s join public.wheels w on w.id = s.wheel_id
                 where s.id = spin_id and public.is_member(w.group_id)));
create policy "tick your own days" on public.wheel_days for insert
  with check (exists (select 1 from public.spins s where s.id = spin_id and s.user_id = auth.uid()));
create policy "untick your own days" on public.wheel_days for delete
  using (exists (select 1 from public.spins s where s.id = spin_id and s.user_id = auth.uid()));

-- ============================================================
-- v7 (wheel reminders): tell everyone in the morning that today is spin day.
-- Safe to run on an existing project. Replace <HOOK_SECRET> as in v4.
-- ============================================================

-- Everything before this happened in response to something. A reminder has to happen at a
-- time instead, and "morning" is different for everyone, so the browser tells us where it
-- is. Nothing depends on it being right: an unset or unknown zone falls back to UTC.
alter table public.profiles add column if not exists tz text;

-- One row per reminder actually sent, so a retry, an overlapping run or a cron that fires
-- twice cannot wake someone twice for the same spin.
create table if not exists public.wheel_reminders (
  wheel_id bigint not null references public.wheels on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  cycle int not null,
  sent_at timestamptz default now(),
  primary key (wheel_id, user_id, cycle)
);
alter table public.wheel_reminders enable row level security;   -- service role only, no policies

-- Who to wake right now, claimed as it goes: the insert is what decides, so two callers
-- racing cannot both take the same person. Called once an hour; each person matches in
-- exactly one of those runs, the one where their own clock says remind_hour.
create or replace function public.wheel_due_now()
returns table (user_id uuid, wheel_name text, group_name text)
language sql security definer set search_path = public as $$
  with due as (
    select gm.user_id as uid, w.id as wid, w.name as wname, g.name as gname,
           -- the cycle is worked out from the person's own date, so someone far enough
           -- east that their morning is yesterday in UTC still gets the right one
           public.wheel_cycle(w, (now() at time zone coalesce(p.tz, 'UTC'))::date) as cyc
    from public.wheels w
    join public.groups g on g.id = w.group_id
    join public.group_members gm on gm.group_id = w.group_id
    join public.profiles p on p.id = gm.user_id
    where w.active
      and extract(hour from (now() at time zone coalesce(p.tz, 'UTC')))::int = w.remind_hour
      and (now() at time zone coalesce(p.tz, 'UTC'))::date >= w.starts_on
      -- today is the first day of a cycle: spin day
      and ((now() at time zone coalesce(p.tz, 'UTC'))::date - w.starts_on) % w.every_days = 0
      and not exists (
        select 1 from public.spins s
        where s.wheel_id = w.id and s.user_id = gm.user_id
          and s.cycle = public.wheel_cycle(w, (now() at time zone coalesce(p.tz, 'UTC'))::date))
  ), claimed as (
    insert into public.wheel_reminders (wheel_id, user_id, cycle)
    select wid, uid, cyc from due
    on conflict do nothing
    returning wheel_id, user_id
  )
  select d.uid, d.wname, d.gname from due d
  join claimed c on c.wheel_id = d.wid and c.user_id = d.uid;
$$;

-- pg_cron runs it every hour on the hour; the function itself works out whose morning it is.
create extension if not exists pg_cron;
select cron.unschedule('wheel-reminders') where exists (select 1 from cron.job where jobname = 'wheel-reminders');
select cron.schedule('wheel-reminders', '0 * * * *', $cron$
  select net.http_post(
    url     := 'https://txvjakpeyfnzigtsvmja.supabase.co/functions/v1/wheelday',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', '<HOOK_SECRET>'),
    body    := '{}'::jsonb
  );
$cron$);

-- ============================================================
-- v8 (wheel ownership): only whoever made a wheel can change it. Everyone else in
-- the group can look at it. Safe to run on an existing project.
-- ============================================================

-- v6 let any member edit or delete any wheel, which was too loose once a wheel is
-- something the whole group is made to spin: one person could quietly rewrite the
-- challenges, or delete the wheel and everyone's results with it.
--
-- A wheel whose creator has left the group entirely (created_by went null when their
-- account went) is claimable by any member, so it cannot end up frozen with nobody
-- able to touch it.
drop policy if exists "members edit wheels" on public.wheels;
drop policy if exists "members delete wheels" on public.wheels;
drop policy if exists "members write stages" on public.wheel_stages;

create policy "the maker edits the wheel" on public.wheels for update
  using (public.is_member(group_id) and (created_by = auth.uid() or created_by is null))
  with check (public.is_member(group_id) and (created_by = auth.uid() or created_by is null));
create policy "the maker deletes the wheel" on public.wheels for delete
  using (public.is_member(group_id) and (created_by = auth.uid() or created_by is null));

-- Reading stays open to the group: "members see stages" from v6 is untouched, so
-- everyone can still see what is on a wheel they have to spin.
create policy "the maker writes stages" on public.wheel_stages for all
  using (exists (select 1 from public.wheels w where w.id = wheel_id and public.is_member(w.group_id)
                 and (w.created_by = auth.uid() or w.created_by is null)))
  with check (exists (select 1 from public.wheels w where w.id = wheel_id and public.is_member(w.group_id)
                      and (w.created_by = auth.uid() or w.created_by is null)));

-- save_wheel runs as the definer and so goes around all of the above; it has to make
-- the same check itself. Otherwise editing through the app would still be open to
-- anyone in the group.
create or replace function public.save_wheel(
  p_id bigint, p_group bigint, p_name text, p_every int, p_starts date,
  p_hour int, p_breaks boolean, p_stages jsonb
) returns bigint
language plpgsql security definer set search_path = public as $$
declare wid bigint; st jsonb; seg jsonb; n int; existing public.wheels;
begin
  if not public.is_member(p_group) then raise exception 'not a member of that group'; end if;
  if p_every < 1 or p_every > 60 then raise exception 'a wheel has to be spun somewhere between every day and every 60 days'; end if;
  if jsonb_array_length(p_stages) < 1 then raise exception 'a wheel needs something on it'; end if;

  for st in select value from jsonb_array_elements(p_stages) loop
    n := jsonb_array_length(st->'segments');
    if n < 2 or n > 24 then raise exception 'each wheel needs between 2 and 24 slices, got %', n; end if;
    -- A day wheel can only ask for days the cycle actually contains.
    if st->>'kind' = 'days' then
      for seg in select value from jsonb_array_elements(st->'segments') loop
        if (seg #>> '{}') !~ '^[0-9]+$' or (seg #>> '{}')::int > p_every then
          raise exception 'a day wheel spun every % days cannot ask for %', p_every, seg #>> '{}';
        end if;
      end loop;
    end if;
  end loop;

  if p_id is null or p_id = 0 then
    insert into public.wheels (group_id, name, every_days, starts_on, remind_hour, breaks_streak, created_by)
      values (p_group, p_name, p_every, p_starts, p_hour, p_breaks, auth.uid()) returning id into wid;
  else
    select * into existing from public.wheels where id = p_id;
    if not found or not public.is_member(existing.group_id) then raise exception 'no such wheel'; end if;
    if existing.created_by is not null and existing.created_by <> auth.uid() then
      raise exception 'only whoever made this wheel can change it';
    end if;
    -- Cycles are counted from the anchor, so moving it once people have spun would
    -- renumber history and strand results in cycles that no longer exist.
    if exists (select 1 from public.spins where wheel_id = p_id)
       and (existing.every_days <> p_every or existing.starts_on <> p_starts) then
      raise exception 'the schedule cannot change once people have started spinning';
    end if;
    update public.wheels set name = p_name, every_days = p_every, starts_on = p_starts,
      remind_hour = p_hour, breaks_streak = p_breaks, created_by = coalesce(existing.created_by, auth.uid())
      where id = p_id;
    wid := p_id;
    delete from public.wheel_stages where wheel_id = wid;
  end if;

  insert into public.wheel_stages (wheel_id, seq, kind, label, segments)
  select wid, (ord - 1)::int, t.st->>'kind', coalesce(t.st->>'label', ''), t.st->'segments'
  from jsonb_array_elements(p_stages) with ordinality as t(st, ord);
  return wid;
end $$;

-- ============================================================
-- v9 (sitting out): skip one cycle of a wheel without leaving it.
-- Safe to run on an existing project.
-- ============================================================

-- Sitting out is the same shape as spinning — one decision per person per cycle — so it
-- lives on the same row rather than in a table of its own. That is what makes the rest
-- of this free: unspun() only asks whether a row exists, so the posting barrier lifts,
-- and wheel_due_now() stops chasing them, with neither needing to know about it.
alter table public.spins add column if not exists sat_out boolean not null default false;

-- You choose before you see the wheel, never after. Sitting out once a result exists
-- would be a way to spin, dislike the answer, and walk away from it — exactly what the
-- rest of this design is built to stop. So this is a no-op on a cycle already spun, and
-- returns whatever is already there.
create or replace function public.sit_out(p_wheel bigint, p_day date default null)
returns public.spins
language plpgsql security definer set search_path = public as $$
declare w public.wheels; d date; c int; out public.spins;
begin
  select * into w from public.wheels where id = p_wheel;
  if not found or not w.active then raise exception 'no such wheel'; end if;
  if not public.is_member(w.group_id) then raise exception 'not a member of that group'; end if;

  d := coalesce(p_day, current_date);
  if d > current_date + 1 or d < current_date - 1 then d := current_date; end if;
  if d < w.starts_on then raise exception 'that wheel has not started yet'; end if;
  c := public.wheel_cycle(w, d);

  insert into public.spins (wheel_id, user_id, cycle, results, days_required, sat_out)
  values (w.id, auth.uid(), c, '[]'::jsonb, 0, true)
  on conflict (wheel_id, user_id, cycle) do nothing;

  select * into out from public.spins where wheel_id = w.id and user_id = auth.uid() and cycle = c;
  return out;
end $$;

-- Changing your mind the other way is fine: taking on an obligation you had skipped costs
-- nobody anything. So a spin may overwrite a sit-out, and only a sit-out — the `where`
-- keeps a real result from ever being rolled a second time.
create or replace function public.spin(p_wheel bigint, p_day date default null)
returns public.spins
language plpgsql security definer set search_path = public as $$
declare
  w public.wheels;
  d date;
  c int;
  st public.wheel_stages;
  picked jsonb := '[]'::jsonb;
  value jsonb;
  idx int;
  req int := 1;
  out public.spins;
begin
  select * into w from public.wheels where id = p_wheel;
  if not found or not w.active then raise exception 'no such wheel'; end if;
  if not public.is_member(w.group_id) then raise exception 'not a member of that group'; end if;

  -- The caller's own calendar day, the way posts already work, but never more than a day
  -- away from the server's, so a wrong clock cannot spin a cycle that has not arrived.
  d := coalesce(p_day, current_date);
  if d > current_date + 1 or d < current_date - 1 then d := current_date; end if;
  if d < w.starts_on then raise exception 'that wheel has not started yet'; end if;
  c := public.wheel_cycle(w, d);

  for st in select * from public.wheel_stages where wheel_id = w.id order by seq loop
    idx := floor(random() * jsonb_array_length(st.segments))::int;
    value := st.segments -> idx;
    -- 'i' is which slice, so the wheel can be animated to the answer it already has.
    -- 'segs' is the slices as they were, so editing the wheel later cannot rewrite the
    -- picture of a spin somebody already did.
    picked := picked || jsonb_build_object('seq', st.seq, 'kind', st.kind, 'label', st.label,
                                           'value', value, 'i', idx, 'segs', st.segments);
    -- A day stage says how many days the challenge has to be done on. Never more days
    -- than the cycle is long, whatever someone typed onto the wheel.
    if st.kind = 'days' then req := least(greatest(coalesce((value #>> '{}')::int, 1), 0), w.every_days); end if;
  end loop;

  insert into public.spins (wheel_id, user_id, cycle, results, days_required, sat_out)
  values (w.id, auth.uid(), c, picked, req, false)
  on conflict (wheel_id, user_id, cycle) do update
    set results = excluded.results, days_required = excluded.days_required, sat_out = false
    where spins.sat_out;

  select * into out from public.spins where wheel_id = w.id and user_id = auth.uid() and cycle = c;
  return out;
end $$;

-- ============================================================
-- v10 (challenge on a post): tick your challenge as you post, and let the days
-- fill themselves. Safe to run on an existing project.
-- ============================================================

-- The challenge text is copied onto the post rather than looked up through the spin,
-- because you are allowed to do somebody else's instead of your own — and because a
-- wheel edited later must never rewrite what a post says it was.
alter table public.posts add column if not exists challenge text;

-- Which spin this counts towards: always your own for the cycle, even when the challenge
-- itself came from someone else.
alter table public.posts add column if not exists spin_id bigint references public.spins on delete set null;
create index if not exists posts_spin on public.posts (spin_id) where spin_id is not null;

-- A post may only be pinned to a spin that belongs to the person posting, or the days
-- could be filled against somebody else's obligation.
drop policy if exists "members post" on public.posts;
create policy "members post" on public.posts for insert with check (
  user_id = auth.uid() and public.is_member(group_id)
  and (spin_id is null or exists (select 1 from public.spins s where s.id = spin_id and s.user_id = auth.uid()))
);

-- public.wheel_days is left in place but no longer written to: a day now counts when the
-- posts marked with the challenge meet that day's quota on their own, rather than being
-- ticked by hand. The old rows are harmless history.

-- ============================================================
-- v11 (whose challenge): only your own counts, and swapping to someone else's is a
-- decision about the cycle rather than about one post. Safe to run on an existing project.
-- ============================================================

-- v10 let a post name any challenge in the group and still fill your days, so posting
-- knuckle pushups filled a decline quota. Only one challenge is yours at a time: whatever
-- you spun, or the one you took from someone else instead.
alter table public.spins add column if not exists challenge_override text;

-- Taking someone else's for the cycle. It must be one somebody on this wheel actually got
-- this cycle, or you could hand yourself anything you liked. Passing null goes back to
-- your own.
create or replace function public.use_challenge(p_spin bigint, p_text text)
returns public.spins
language plpgsql security definer set search_path = public as $$
declare sp public.spins; w public.wheels; out public.spins;
begin
  select * into sp from public.spins where id = p_spin;
  if not found then raise exception 'no such spin'; end if;
  if sp.user_id <> auth.uid() then raise exception 'that is not your spin'; end if;
  if sp.sat_out then raise exception 'you are sitting this one out'; end if;

  select * into w from public.wheels where id = sp.wheel_id;
  if not public.is_member(w.group_id) then raise exception 'not a member of that group'; end if;

  if p_text is not null and not exists (
    select 1 from public.spins s, jsonb_array_elements(s.results) r
    where s.wheel_id = sp.wheel_id and s.cycle = sp.cycle and not s.sat_out
      and r->>'kind' = 'challenge' and r->>'value' = p_text
  ) then
    raise exception 'nobody on this wheel got that challenge';
  end if;

  update public.spins set challenge_override = p_text where id = p_spin;
  select * into out from public.spins where id = p_spin;
  return out;
end $$;

-- ============================================================
-- v12 (the borrow slice): you can only take somebody else's challenge if that is what
-- the wheel gave you. Safe to run on an existing project.
-- ============================================================

-- A wheel can carry one slice that is not a challenge but an instruction: land on it and
-- you do somebody else's instead. v11 let anyone swap at will, which made every wheel
-- optional — you could always take the easiest thing anyone got.
create or replace function public.borrow_slice() returns text
language sql immutable as $$ select 'Someone else''s challenge' $$;

create or replace function public.use_challenge(p_spin bigint, p_text text)
returns public.spins
language plpgsql security definer set search_path = public as $$
declare sp public.spins; w public.wheels; own text; out public.spins;
begin
  select * into sp from public.spins where id = p_spin;
  if not found then raise exception 'no such spin'; end if;
  if sp.user_id <> auth.uid() then raise exception 'that is not your spin'; end if;
  if sp.sat_out then raise exception 'you are sitting this one out'; end if;

  select * into w from public.wheels where id = sp.wheel_id;
  if not public.is_member(w.group_id) then raise exception 'not a member of that group'; end if;

  -- Only the slice that says so lets you take someone else's.
  own := (select r->>'value' from jsonb_array_elements(sp.results) r where r->>'kind' = 'challenge' limit 1);
  if own is distinct from public.borrow_slice() then
    raise exception 'the wheel did not give you somebody else''s to do';
  end if;

  -- ...and only one that somebody on this wheel actually got this cycle, which is never
  -- the borrow slice itself: landing on it is an instruction, not a challenge.
  if p_text is not null and (p_text = public.borrow_slice() or not exists (
    select 1 from public.spins s, jsonb_array_elements(s.results) r
    where s.wheel_id = sp.wheel_id and s.cycle = sp.cycle and not s.sat_out and s.user_id <> auth.uid()
      and r->>'kind' = 'challenge' and r->>'value' = p_text
  )) then
    raise exception 'nobody else on this wheel got that challenge';
  end if;

  update public.spins set challenge_override = p_text where id = p_spin;
  select * into out from public.spins where id = p_spin;
  return out;
end $$;

-- ============================================================
-- v13 (rest days and pictures): safe to run on an existing project.
-- ============================================================

-- The days of the week a group's quota is actually expected on: 0 is Sunday, 6 is
-- Saturday. Every group that already exists gets all seven, which is what it has always
-- meant. A day not in here is a rest day: nothing is owed on it, and skipping it leaves a
-- streak where it was rather than ending it.
alter table public.groups add column if not exists active_days smallint[] not null default '{0,1,2,3,4,5,6}';
alter table public.groups drop constraint if exists groups_active_days_sane;
-- coalesce, because array_length of an empty array is null rather than 0, and a check
-- that evaluates to null passes: a group expecting nothing on any day would slip through.
alter table public.groups add constraint groups_active_days_sane check (
  coalesce(array_length(active_days, 1), 0) between 1 and 7
  and active_days <@ array[0,1,2,3,4,5,6]::smallint[]
);

-- Proof can be a picture as well as a clip. Which one a post is, is read off the file
-- name, so nothing new is stored and every post already in here is still a clip.
update storage.buckets set allowed_mime_types = array['video/*', 'image/*'] where id = 'proof';

-- ============================================================
-- v14 (likes, and telling people things happened): safe to run on an existing project.
-- Deploy the notify function BEFORE running this — the new triggers call it with a kind
-- it has to understand, and the old one would read an invite as if it were a post.
-- ============================================================

-- One row per person per post. The primary key is the whole point: liking twice is the
-- same as liking once, and there is nothing to reconcile.
create table if not exists public.likes (
  post_id bigint not null references public.posts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz default now(),
  primary key (post_id, user_id)
);
create index if not exists likes_post on public.likes (post_id);
alter table public.likes enable row level security;

drop policy if exists "members see likes" on public.likes;
drop policy if exists "members like" on public.likes;
drop policy if exists "take back your own like" on public.likes;
-- The same rule as the post itself: if you cannot see it, you cannot like it or know who did.
create policy "members see likes" on public.likes for select
  using (public.is_member((select group_id from public.posts where id = post_id)));
create policy "members like" on public.likes for insert
  with check (user_id = auth.uid() and public.is_member((select group_id from public.posts where id = post_id)));
create policy "take back your own like" on public.likes for delete using (user_id = auth.uid());

-- One hook for every kind of thing worth telling somebody about. The kind is passed as a
-- trigger argument rather than guessed at the other end, so a row that happens to carry a
-- group_id is never mistaken for a post.
create or replace function public.notify_hook() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://txvjakpeyfnzigtsvmja.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', '<HOOK_SECRET>'),
    body    := jsonb_build_object('kind', TG_ARGV[0], 'record', to_jsonb(new))
  );
  return new;
end $$;

drop trigger if exists posts_notify on public.posts;
create trigger posts_notify after insert on public.posts
  for each row execute function public.notify_hook('post');

drop trigger if exists invites_notify on public.invites;
create trigger invites_notify after insert on public.invites
  for each row execute function public.notify_hook('invite');

drop trigger if exists comments_notify on public.comments;
create trigger comments_notify after insert on public.comments
  for each row execute function public.notify_hook('comment');

drop trigger if exists likes_notify on public.likes;
create trigger likes_notify after insert on public.likes
  for each row execute function public.notify_hook('like');

-- ============================================================
-- v15 (reactions): safe to run on an existing project. Deploy the notify function first,
-- as with v14 — this adds another kind for it to understand.
-- ============================================================

-- One row per person per emoji per post: you can put more than one on a post, but not the
-- same one twice, and taking it back is deleting the row you left.
create table if not exists public.reactions (
  post_id bigint not null references public.posts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz default now(),
  primary key (post_id, user_id, emoji)
);
create index if not exists reactions_post on public.reactions (post_id);
alter table public.reactions enable row level security;

drop policy if exists "members see reactions" on public.reactions;
drop policy if exists "members react" on public.reactions;
drop policy if exists "take back your own reaction" on public.reactions;
-- Governed by the post, exactly as likes and comments are.
create policy "members see reactions" on public.reactions for select
  using (public.is_member((select group_id from public.posts where id = post_id)));
create policy "members react" on public.reactions for insert
  with check (user_id = auth.uid() and public.is_member((select group_id from public.posts where id = post_id)));
create policy "take back your own reaction" on public.reactions for delete using (user_id = auth.uid());

drop trigger if exists reactions_notify on public.reactions;
create trigger reactions_notify after insert on public.reactions
  for each row execute function public.notify_hook('reaction');

-- ============================================================
-- v16 (the hook secret lives outside the function): safe, and worth running.
--
-- Every block above that creates notify_hook() carries '<HOOK_SECRET>' as a literal
-- placeholder. Paste one of them in again without substituting it — which is exactly what
-- happens when a later feature block gets run — and the trigger starts sending the string
-- '<HOOK_SECRET>' as the secret. The edge function answers 403, pg_net drops the answer on
-- the floor, and every notification in the app stops with nothing anywhere saying why.
--
-- So the secret stops living in the function body and moves into a row. Running this block
-- again cannot touch that row: the value is written by one statement, on its own, once.
--
--   insert into private.config (key, value) values ('hook_secret', 'the-real-secret')
--     on conflict (key) do update set value = excluded.value;
--
-- It has to match the HOOK_SECRET set on the edge functions, which is project-wide and so
-- covers both notify and wheelday. To check what is stored:
--
--   select left(value, 6) || '…' as hook_secret from private.config where key = 'hook_secret';
--
-- A database setting would have been tidier, but ALTER DATABASE ... SET on a custom
-- parameter needs superuser, and Supabase does not hand that out. Vault would work too;
-- this is a table because it depends on nothing that can change under it.
-- ============================================================

-- Nothing is granted on a new schema, so only the owner reaches it — and PostgREST only
-- serves the schemas it is told to, which are public and graphql_public. This is neither.
create schema if not exists private;

create table if not exists private.config (
  key text primary key,
  value text not null
);

create or replace function public.notify_hook() returns trigger
language plpgsql security definer set search_path = public as $$
declare secret text := coalesce((select value from private.config where key = 'hook_secret'), '');
begin
  -- A missing secret is worth saying out loud. It goes to the Postgres log rather than
  -- nowhere, which is the whole problem this block exists to fix.
  if secret = '' then
    raise warning 'notify_hook: no hook_secret in private.config, so % notifications are not being sent', TG_ARGV[0];
    return new;
  end if;
  perform net.http_post(
    url     := 'https://txvjakpeyfnzigtsvmja.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', secret),
    body    := jsonb_build_object('kind', TG_ARGV[0], 'record', to_jsonb(new))
  );
  return new;
end $$;

-- pg_cron runs it every hour on the hour; the hourly wheel reminder carried the same
-- placeholder, so it reads the same row now.
select cron.unschedule('wheel-reminders') where exists (select 1 from cron.job where jobname = 'wheel-reminders');
select cron.schedule('wheel-reminders', '0 * * * *', $cron$
  select net.http_post(
    url     := 'https://txvjakpeyfnzigtsvmja.supabase.co/functions/v1/wheelday',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-hook-secret', (select value from private.config where key = 'hook_secret')),
    body    := '{}'::jsonb
  ) where exists (select 1 from private.config where key = 'hook_secret' and value <> '');
$cron$);

-- ============================================================
-- v17 (stories): safe to run on an existing project.
--
-- A story is a photo, a clip of up to ten seconds, or a card of text, and it is gone after
-- a day. Two things make that true: nothing older than 24 hours is readable in the first
-- place, so expiry does not wait on a job, and an hourly job then clears the rows and the
-- files so the bucket does not grow forever.
-- ============================================================

-- Who is allowed to see you at all: anyone you share a group with, anyone you are friends
-- with, and yourself. Stories are the first thing in the app to use both rules at once.
create or replace function public.can_see_user(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select other = auth.uid()
      or exists (select 1 from public.group_members a
                  join public.group_members b on a.group_id = b.group_id
                 where a.user_id = auth.uid() and b.user_id = other)
      or exists (select 1 from public.friendships f
                 where (f.a = auth.uid() and f.b = other)
                    or (f.b = auth.uid() and f.a = other));
$$;

create table if not exists public.stories (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'text')),
  media_path text,
  body text check (body is null or char_length(body) <= 280),
  -- Whatever the editor was set to: colours, the typeface, where the words sit, an emoji.
  -- Kept as one column because it is the story's own look and nothing else reads it.
  style jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- A card of text has no file; a photo or a clip has nothing to show without one.
  constraint story_has_what_it_needs check ((kind = 'text') = (media_path is null))
);
create index if not exists stories_fresh on public.stories (created_at desc);
alter table public.stories enable row level security;

drop policy if exists "see stories from people you know" on public.stories;
drop policy if exists "post your own stories" on public.stories;
drop policy if exists "take down your own story" on public.stories;
-- The day is in the policy, not just in the query: an old story is not readable at all,
-- however it is asked for.
create policy "see stories from people you know" on public.stories for select
  using (public.can_see_user(user_id) and created_at > now() - interval '24 hours');
create policy "post your own stories" on public.stories for insert
  with check (user_id = auth.uid());
create policy "take down your own story" on public.stories for delete
  using (user_id = auth.uid());

-- What you have already seen, which is the whole difference between a ring that is lit and
-- one that is not. Only your own rows are yours to read: who watched is not on offer here.
create table if not exists public.story_views (
  story_id bigint not null references public.stories on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (story_id, user_id)
);
alter table public.story_views enable row level security;

drop policy if exists "your own views" on public.story_views;
drop policy if exists "mark what you have seen" on public.story_views;
create policy "your own views" on public.story_views for select using (user_id = auth.uid());
create policy "mark what you have seen" on public.story_views for insert
  with check (user_id = auth.uid());

-- 25 MB is far more than ten seconds of video needs, and small enough that nothing silly
-- gets through. Private, like proof: everything is served by signed URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('stories', 'stories', false, 26214400,
          array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'])
  on conflict (id) do update
    set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "watch stories you can see" on storage.objects;
drop policy if exists "upload your own story" on storage.objects;
drop policy if exists "delete your own story file" on storage.objects;
-- Read through the story rather than the path: the row already says who it belongs to and
-- whether it has expired, so the file answers exactly when the story does.
create policy "watch stories you can see" on storage.objects for select
  using (bucket_id = 'stories' and exists (
    select 1 from public.stories s where s.media_path = name and public.can_see_user(s.user_id)
      and s.created_at > now() - interval '24 hours'));
create policy "upload your own story" on storage.objects for insert
  with check (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete your own story file" on storage.objects for delete
  using (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);

-- pg_cron runs it every hour, a few minutes past, to clear what has expired. The rows go
-- first so nothing is left pointing at a file that has gone.
select cron.unschedule('stories-expire') where exists (select 1 from cron.job where jobname = 'stories-expire');
select cron.schedule('stories-expire', '7 * * * *', $cron$
  delete from public.stories where created_at < now() - interval '24 hours';
  delete from storage.objects where bucket_id = 'stories' and created_at < now() - interval '25 hours';
$cron$);

-- ============================================================
-- v18 (seen by): safe to run on an existing project.
--
-- Who watched your story is yours to know, and nobody else's. The rows were always
-- written; this is only the other half of the read. Nothing else changes.
-- ============================================================
drop policy if exists "your own views" on public.story_views;
create policy "your own views" on public.story_views for select
  using (user_id = auth.uid()
      or exists (select 1 from public.stories s where s.id = story_id and s.user_id = auth.uid()));

-- ============================================================
-- v19 (story likes and reactions): safe to run on an existing project. Deploy the notify
-- function first, as with v14 and v15 — this adds two more kinds for it to understand.
--
-- A story can be answered the same two ways a post can: one heart, and as many emoji as
-- you like. Both are governed by the story, so both expire with it: a like on a story
-- nobody can read any more is not readable either.
-- ============================================================

create table if not exists public.story_likes (
  story_id bigint not null references public.stories on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);
create index if not exists story_likes_story on public.story_likes (story_id);
alter table public.story_likes enable row level security;

-- One row per person per emoji, exactly as reactions on a post are.
create table if not exists public.story_reactions (
  story_id bigint not null references public.stories on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (story_id, user_id, emoji)
);
create index if not exists story_reactions_story on public.story_reactions (story_id);
alter table public.story_reactions enable row level security;

-- Readable exactly when the story is: the same two rules and the same day, read off the
-- story rather than repeated here, so there is one answer to who can see what.
create or replace function public.can_see_story(sid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stories s
                  where s.id = sid and public.can_see_user(s.user_id)
                    and s.created_at > now() - interval '24 hours');
$$;

drop policy if exists "see story likes" on public.story_likes;
drop policy if exists "like a story you can see" on public.story_likes;
drop policy if exists "take back your own story like" on public.story_likes;
create policy "see story likes" on public.story_likes for select using (public.can_see_story(story_id));
create policy "like a story you can see" on public.story_likes for insert
  with check (user_id = auth.uid() and public.can_see_story(story_id));
create policy "take back your own story like" on public.story_likes for delete using (user_id = auth.uid());

drop policy if exists "see story reactions" on public.story_reactions;
drop policy if exists "react to a story you can see" on public.story_reactions;
drop policy if exists "take back your own story reaction" on public.story_reactions;
create policy "see story reactions" on public.story_reactions for select using (public.can_see_story(story_id));
create policy "react to a story you can see" on public.story_reactions for insert
  with check (user_id = auth.uid() and public.can_see_story(story_id));
create policy "take back your own story reaction" on public.story_reactions for delete using (user_id = auth.uid());

drop trigger if exists story_likes_notify on public.story_likes;
create trigger story_likes_notify after insert on public.story_likes
  for each row execute function public.notify_hook('story_like');

drop trigger if exists story_reactions_notify on public.story_reactions;
create trigger story_reactions_notify after insert on public.story_reactions
  for each row execute function public.notify_hook('story_reaction');

-- ============================================================
-- v20 (editing a story you posted): safe to run on an existing project.
--
-- Wording and colours are the only things an edit can change. Which story it is, whose it
-- is, what file it points at and when it was posted are all fixed — an edit that could
-- move the file would be a way to point a story at somebody else's, and one that could
-- move the clock would be a way to make a story that never expires.
-- ============================================================
create or replace function public.story_edit_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id    := old.user_id;
  new.kind       := old.kind;
  new.media_path := old.media_path;
  new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists stories_edit_guard on public.stories;
create trigger stories_edit_guard before update on public.stories
  for each row execute function public.story_edit_guard();

drop policy if exists "reword your own story" on public.stories;
-- The same day limit as reading one: a story nobody can see any more is not one to edit.
create policy "reword your own story" on public.stories for update
  using (user_id = auth.uid() and created_at > now() - interval '24 hours')
  with check (user_id = auth.uid());

-- ============================================================
-- v21 (badges): safe to run on an existing project.
--
-- A badge is an award, not a reading of the current state: it is kept once it has been
-- earned, whatever happens to the run afterwards, and reaching the same number again does
-- not produce a second one. That is the whole reason it is a row rather than something
-- worked out from the posts each time — a post deleted years later must not take a crown
-- with it, and two people looking at the same profile must see the same badges.
--
-- Only the long runs. The list is the same one the app already celebrates with confetti,
-- so the moment that is worth stopping the app for is the moment that leaves a mark.
-- ============================================================
create table if not exists public.badges (
  user_id uuid not null references public.profiles on delete cascade,
  streak int not null check (streak in (25, 50, 100, 150, 250, 365, 500, 1000)),
  earned_at timestamptz not null default now(),
  primary key (user_id, streak)
);
alter table public.badges enable row level security;

drop policy if exists "see badges of people you know" on public.badges;
drop policy if exists "claim your own badge" on public.badges;
-- The same two rules stories use: anyone you share a group with, anyone you are friends
-- with, and yourself.
create policy "see badges of people you know" on public.badges for select
  using (public.can_see_user(user_id));
create policy "claim your own badge" on public.badges for insert with check (user_id = auth.uid());
-- No update and no delete on purpose. An award is not something to take back, and a badge
-- that could be deleted is a badge that could be re-earned.

-- ============================================================
-- v22 (a profile worth visiting): safe to run on an existing project.
--
-- Three things. A bio. Which of your groups you are willing to have on show. And, per
-- post, whether it belongs on your profile as well as in the group — group only by
-- default, because that is what the app was for first and nobody has ticked anything yet.
--
-- The column is on_profile rather than public: `public` is the schema every one of these
-- tables lives in, and a policy that reads `public = true` is a policy nobody can skim.
-- ============================================================
alter table public.profiles add column if not exists bio text;
alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles add constraint profiles_bio_len
  check (bio is null or char_length(bio) <= 160);
-- Empty means show none. A group you have left stops being shown because the id stops
-- matching anything you are a member of, which is checked when it is drawn rather than
-- tidied up here.
alter table public.profiles add column if not exists shown_groups bigint[] not null default '{}';

alter table public.posts add column if not exists on_profile boolean not null default false;
create index if not exists posts_on_profile on public.posts (user_id, created_at desc) where on_profile;

-- A post is readable by the group it was posted to, exactly as before. A post its author
-- put on their profile is also readable by anyone who can see them — the same two rules
-- stories use, so a profile reaches your groups and your friends and stops there. The app
-- has no way to find strangers and this is not the place to grow one.
drop policy if exists "members see posts" on public.posts;
create policy "members see posts" on public.posts for select
  using (public.is_member(group_id) or (on_profile and public.can_see_user(user_id)));

-- Putting a post on your profile, or taking it off again, is an edit of your own row. No
-- update policy existed because nothing was editable before.
drop policy if exists "edit your own post" on public.posts;
create policy "edit your own post" on public.posts for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.post_edit_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Only the profile flag is yours to change after the fact. The numbers, the day, the
  -- group and the file are what the group saw.
  new.id := old.id; new.user_id := old.user_id; new.group_id := old.group_id;
  new.metric := old.metric; new.amount := old.amount; new.day := old.day;
  new.caption := old.caption; new.video_path := old.video_path; new.created_at := old.created_at;
  new.challenge := old.challenge; new.spin_id := old.spin_id;
  return new;
end $$;

drop trigger if exists posts_edit_guard on public.posts;
create trigger posts_edit_guard before update on public.posts
  for each row execute function public.post_edit_guard();

-- ============================================================
-- v23 (liking a comment): safe to run on an existing project. Deploy the notify function
-- first, as with every kind before it — this adds one more for it to understand.
--
-- Governed by the comment, which is governed by the post, which is governed by the group.
-- Nothing here decides who can see what; it asks the post.
-- ============================================================
create table if not exists public.comment_likes (
  comment_id bigint not null references public.comments on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists comment_likes_comment on public.comment_likes (comment_id);
alter table public.comment_likes enable row level security;

create or replace function public.can_see_comment(cid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.comments c join public.posts p on p.id = c.post_id
                  where c.id = cid and public.is_member(p.group_id));
$$;

drop policy if exists "see comment likes" on public.comment_likes;
drop policy if exists "like a comment you can see" on public.comment_likes;
drop policy if exists "take back your own comment like" on public.comment_likes;
create policy "see comment likes" on public.comment_likes for select using (public.can_see_comment(comment_id));
create policy "like a comment you can see" on public.comment_likes for insert
  with check (user_id = auth.uid() and public.can_see_comment(comment_id));
create policy "take back your own comment like" on public.comment_likes for delete using (user_id = auth.uid());

drop trigger if exists comment_likes_notify on public.comment_likes;
create trigger comment_likes_notify after insert on public.comment_likes
  for each row execute function public.notify_hook('comment_like');

-- ============================================================
-- v24 (real email, and a username chosen after signing up): safe to run on an existing
-- project, but DO NOT run it until the app on main is the one that expects it — an
-- account created between the two is an account with no username and no screen asking
-- for one.
--
-- Signing up becomes email and a password. The username, the name and the rest are the
-- next step rather than part of it, so a profile exists before it is filled in: a null
-- username is what "not set up yet" means, and the app will not let anybody past that
-- screen until it is not null.
-- ============================================================

-- The check only applied to a value, so it already tolerates null; the NOT NULL is what
-- has to go. Unique still holds, and Postgres lets any number of rows be null under it.
alter table public.profiles alter column username drop not null;

alter table public.profiles add column if not exists birthday date;
alter table public.profiles add column if not exists gender text;
alter table public.profiles drop constraint if exists profiles_gender_ok;
alter table public.profiles add constraint profiles_gender_ok
  check (gender is null or gender in ('woman', 'man', 'other', 'unsaid'));
-- A birthday in the future is a typo, and one before 1900 is a different typo. Neither is
-- worth a screen of its own, and both are worth refusing.
alter table public.profiles drop constraint if exists profiles_birthday_sane;
alter table public.profiles add constraint profiles_birthday_sane
  check (birthday is null or (birthday > date '1900-01-01' and birthday < current_date));

-- A signup no longer carries a username, so the row is created without one. Written to
-- cope with either, because accounts made by the old app still arrive with one.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
    values (new.id, nullif(lower(coalesce(new.raw_user_meta_data->>'username', '')), ''));
  return new;
end $$;

-- Whether somebody has finished setting up. Used by the app to decide what to draw, and
-- by the policy below so half-made accounts cannot be found or invited.
create or replace function public.is_set_up(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = uid and username is not null);
$$;

-- Usernames stay readable — that is how anybody is found — but a row with no username on
-- it yet is nobody's business but its owner's.
drop policy if exists "usernames are public" on public.profiles;
create policy "usernames are public" on public.profiles for select
  using (username is not null or id = auth.uid());

-- Claiming a username is an edit of your own row, which was already allowed. What was not
-- checked is that it only happens once: a username people have learned is not a thing to
-- swap out from under them, and the app offers no way to.
create or replace function public.profile_edit_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.username is not null and new.username is distinct from old.username then
    raise exception 'a username cannot be changed once it is taken';
  end if;
  new.id := old.id;
  return new;
end $$;

drop trigger if exists profiles_edit_guard on public.profiles;
create trigger profiles_edit_guard before update on public.profiles
  for each row execute function public.profile_edit_guard();

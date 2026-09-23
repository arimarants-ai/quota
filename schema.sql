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
-- v25 (agreeing to the documents): safe to run on an existing project.
--
-- The privacy policy, the note on cookies and storage, and the community guidelines are
-- shown at signup and have to be ticked. This is where that tick is written down, with the
-- wording it was ticked against, so it is always possible to say what somebody agreed to
-- rather than only that they agreed to something.
--
-- Everyone who signed up before this ran has null here, and the app puts the accept screen
-- in front of them on their next open. Until this block is run the columns do not exist at
-- all, and the app treats that as nobody being held to anything — a document that cannot
-- be accepted must not lock people out of their own accounts.
--
-- No policy is needed: the existing "edit own profile" policy already lets you write your
-- own row and nothing else, and the column is public the same way a username is.
-- ============================================================
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists terms_version text;

-- ============================================================
-- v26 (your own profile holds everything you posted): safe to run on an existing project.
--
-- Your profile is where you go to find your own work, so it shows every post you ever made
-- whether or not you put it on show. Other people still see only what you marked, which is
-- what the on_profile half of this policy has always said.
--
-- Without this line the app can still ask for them and get nothing back: a post in a group
-- you have since left is yours, but is_member() is false and on_profile may be false too,
-- so the row is invisible to the person who made it. Reading your own rows is the least a
-- policy can allow, and nothing else here changes.
-- ============================================================
drop policy if exists "members see posts" on public.posts;
create policy "members see posts" on public.posts for select
  using (user_id = auth.uid() or public.is_member(group_id) or (on_profile and public.can_see_user(user_id)));

-- ============================================================
-- v27 (questioning somebody's proof): safe to run on an existing project.
--
-- A flag is one person saying a post does not meet the challenge, and the group deciding.
-- It is deliberately not a report to a moderator: there is no moderator, and the people who
-- know whether twenty pushups were twenty pushups are the people in the group.
--
-- Three rules are in here rather than in the app, because all three are the kind that stop
-- being true the moment somebody writes their own request:
--
--   * You cannot flag your own post, and you cannot vote on a flag against it.
--   * One flag per post, ever. A post the group already stood behind is not re-litigated.
--   * When it closes is the database's, not the browser's. It is three hours before the
--     flagged person's own midnight, wherever in the world they are, worked out from
--     profiles.tz — the same column the spin-day reminder runs on. A flag raised after that
--     hour has already passed gets half an hour instead, so a late one still decides today
--     rather than expiring on the spot or running past the day it is about.
--
-- Nothing here writes to posts. Whether an upheld flag has taken a post out of its day is
-- read off the flag, by the app, from rows it already loads — a column on posts would have
-- to be written by something, and the only things allowed to write a post are its author
-- and post_edit_guard(), which exists precisely to stop a post changing after the group
-- saw it. So the post is left exactly as it was and the flag carries the verdict.
-- ============================================================
create table if not exists public.flags (
  id bigint generated always as identity primary key,
  -- One per post, ever: unique rather than an index, so a second one is refused by the
  -- database rather than by remembering to check.
  post_id bigint not null unique references public.posts on delete cascade,
  by_user uuid not null references public.profiles on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 1 and 300),
  created_at timestamptz not null default now(),
  closes_at timestamptz not null default now(),
  outcome text check (outcome in ('upheld', 'dismissed')),
  closed_at timestamptz
);
create index if not exists flags_open on public.flags (closes_at) where outcome is null;
alter table public.flags enable row level security;

create table if not exists public.flag_votes (
  flag_id bigint not null references public.flags on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  -- true agrees with the flag: this needs redoing.
  agree boolean not null,
  created_at timestamptz not null default now(),
  primary key (flag_id, user_id)   -- one vote each, by the key rather than by checking
);
alter table public.flag_votes enable row level security;

-- Which group a flag belongs to, and whose post it is. Both are one join away and every
-- policy below wants one of them, so they are functions rather than a subquery written out
-- five times slightly differently.
create or replace function public.flag_group(fid bigint) returns bigint
language sql stable security definer set search_path = public as $$
  select p.group_id from public.flags f join public.posts p on p.id = f.post_id where f.id = fid;
$$;
create or replace function public.flag_owner(fid bigint) returns uuid
language sql stable security definer set search_path = public as $$
  select p.user_id from public.flags f join public.posts p on p.id = f.post_id where f.id = fid;
$$;

drop policy if exists "see flags in your groups" on public.flags;
drop policy if exists "question a post you can see" on public.flags;
create policy "see flags in your groups" on public.flags for select
  using (public.is_member((select group_id from public.posts where id = post_id)));
create policy "question a post you can see" on public.flags for insert
  with check (by_user = auth.uid()
    and public.is_member((select group_id from public.posts where id = post_id))
    and auth.uid() <> (select user_id from public.posts where id = post_id));
-- No update and no delete: a flag is a thing that happened. Only close_due_flags() below
-- writes an outcome, and it runs as the owner rather than as whoever called it.

-- When it closes, and who it says raised it, are settled here rather than sent up by the
-- browser — a closes_at the client picks is a clock the client can move.
create or replace function public.flag_open_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare zone text; nine timestamptz;
begin
  select coalesce(nullif(pr.tz, ''), 'UTC') into zone
    from public.posts p join public.profiles pr on pr.id = p.user_id where p.id = new.post_id;
  -- An unrecognised zone is not worth failing a flag over; UTC is what the reminder falls
  -- back to as well.
  begin
    nine := ((now() at time zone zone)::date + time '21:00') at time zone zone;
  exception when others then
    nine := ((now() at time zone 'UTC')::date + time '21:00') at time zone 'UTC';
  end;
  new.by_user := auth.uid();
  new.created_at := now();
  new.outcome := null; new.closed_at := null;
  -- Three hours before their midnight, or half an hour, whichever is later.
  new.closes_at := greatest(nine, now() + interval '30 minutes');
  return new;
end $$;
drop trigger if exists flags_open_guard on public.flags;
create trigger flags_open_guard before insert on public.flags
  for each row execute function public.flag_open_guard();

-- Raising one is a vote. Without this a flag opens with nobody on it, and "everybody has
-- voted" could never be reached in a group of two.
create or replace function public.flag_seed_vote() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.flag_votes (flag_id, user_id, agree) values (new.id, new.by_user, true)
    on conflict do nothing;
  return new;
end $$;
drop trigger if exists flags_seed_vote on public.flags;
create trigger flags_seed_vote after insert on public.flags
  for each row execute function public.flag_seed_vote();

drop policy if exists "see votes on a flag you can see" on public.flag_votes;
drop policy if exists "vote once on an open flag" on public.flag_votes;
drop policy if exists "change your mind while it is open" on public.flag_votes;
create policy "see votes on a flag you can see" on public.flag_votes for select
  using (public.is_member(public.flag_group(flag_id)));
create policy "vote once on an open flag" on public.flag_votes for insert
  with check (user_id = auth.uid()
    and public.is_member(public.flag_group(flag_id))
    and auth.uid() <> public.flag_owner(flag_id)
    and exists (select 1 from public.flags f where f.id = flag_id and f.outcome is null and f.closes_at > now()));
-- One vote each is the primary key's job. Changing your mind before it closes is not a
-- second vote, and a mis-tap that can never be undone is not a decision anybody wants to
-- live with for the rest of the day.
create policy "change your mind while it is open" on public.flag_votes for update
  using (user_id = auth.uid()
    and exists (select 1 from public.flags f where f.id = flag_id and f.outcome is null and f.closes_at > now()))
  with check (user_id = auth.uid());

-- Every flag whose time is up, or that everybody eligible has already voted on. Runs as the
-- owner, so it can write an outcome no policy above allows anybody else to write, and it
-- decides by the same rule however it was reached: from the app on a load, or from cron.
--
-- More agreeing than not is upheld; anything else, a tie included, is dismissed. A tie is
-- deliberately not a coin toss — the post stands, and the day it counted towards stays
-- counted, exactly as if the flag had never been raised.
create or replace function public.close_due_flags() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  with t as (
    select f.id, f.closes_at,
           coalesce(sum(case when v.agree then 1 else 0 end), 0) as yes,
           coalesce(sum(case when v.agree then 0 else 1 end), 0) as no,
           count(v.*) as cast_,
           -- Everyone in the group except whoever is being flagged.
           greatest(0, (select count(*) from public.group_members gm where gm.group_id = p.group_id) - 1) as eligible
      from public.flags f
      join public.posts p on p.id = f.post_id
      left join public.flag_votes v on v.flag_id = f.id
     where f.outcome is null
     group by f.id, f.closes_at, p.group_id
  ), due as (
    select * from t where closes_at <= now() or (eligible > 0 and cast_ >= eligible)
  )
  update public.flags f
     set outcome = case when d.yes > d.no then 'upheld' else 'dismissed' end,
         closed_at = now()
    from due d where d.id = f.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.close_due_flags() from public;
grant execute on function public.close_due_flags() to authenticated;

-- The group hears when one is raised, and again when it is decided. The second one fires
-- off the update close_due_flags() makes, so a result reaches people whether the app was
-- open when the clock ran out or not.
drop trigger if exists flags_notify on public.flags;
create trigger flags_notify after insert on public.flags
  for each row execute function public.notify_hook('flag');
drop trigger if exists flags_closed_notify on public.flags;
create trigger flags_closed_notify after update of outcome on public.flags
  for each row when (old.outcome is null and new.outcome is not null)
  execute function public.notify_hook('flag_closed');

-- Ten minutes rather than the hour the wheel reminder runs on: a flag closes at whatever
-- minute its half hour lands on, and a result that arrives fifty minutes late is a result
-- that arrives after the person could have done anything about it.
select cron.unschedule('close-flags') where exists (select 1 from cron.job where jobname = 'close-flags');
select cron.schedule('close-flags', '*/10 * * * *', $cron$ select public.close_due_flags(); $cron$);

-- ============================================================
-- v28 (talking to each other): safe to run on an existing project.
--
-- Two kinds of chat and one table, because a message is a message. A group's chat is the
-- group — every group has one the moment it exists, with nothing to create and nothing to
-- join, and anyone who joins later can read all of it, the way a channel works. A private
-- one is a pair of friends.
--
-- The pair is stored sorted, which is exactly what friendships already does, so "is there
-- a chat between these two" and "are these two friends" are the same shape of question and
-- the same index answers both. A row is one or the other, never both and never neither,
-- and that is a constraint rather than a convention.
--
-- Text only. Proof is what the video budget is for, and a chat that can carry clips is a
-- 1 GB bucket with a hole in it.
-- ============================================================
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  group_id bigint references public.groups on delete cascade,
  -- The pair, sorted, the way friendships is stored.
  a uuid references public.profiles on delete cascade,
  b uuid references public.profiles on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  -- A group message or a private one. Never both, never neither.
  constraint message_is_one_kind check ((group_id is not null) <> (a is not null)),
  constraint message_pair_whole check ((a is null) = (b is null)),
  constraint message_pair_sorted check (a is null or a < b)
);
create index if not exists messages_group on public.messages (group_id, created_at desc) where group_id is not null;
create index if not exists messages_pair on public.messages (a, b, created_at desc) where a is not null;
alter table public.messages enable row level security;

-- Are these two friends? friendships already stores the pair sorted, so this is the same
-- question the rest of the app asks, asked once.
create or replace function public.are_friends(x uuid, y uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships f
                  where f.a = least(x, y) and f.b = greatest(x, y));
$$;

drop policy if exists "read the chats you are in" on public.messages;
drop policy if exists "say something where you can read" on public.messages;
create policy "read the chats you are in" on public.messages for select
  using ((group_id is not null and public.is_member(group_id))
      or (a is not null and auth.uid() in (a, b)));
-- Writing needs one thing more than reading: a private chat is between friends. Somebody
-- who can see you is not somebody who can message you.
create policy "say something where you can read" on public.messages for insert
  with check (user_id = auth.uid()
    and ((group_id is not null and public.is_member(group_id))
      or (a is not null and auth.uid() in (a, b) and public.are_friends(a, b))));
-- Taking back your own. No update: an edited message in a group nobody was told about is
-- a different conversation from the one people read.
drop policy if exists "take back your own message" on public.messages;
create policy "take back your own message" on public.messages for delete using (user_id = auth.uid());

-- Reacting to one, the same shape as reacting to a post.
create table if not exists public.message_reactions (
  message_id bigint not null references public.messages on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists message_reactions_message on public.message_reactions (message_id);
alter table public.message_reactions enable row level security;

create or replace function public.can_see_message(mid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.messages m where m.id = mid
    and ((m.group_id is not null and public.is_member(m.group_id))
      or (m.a is not null and auth.uid() in (m.a, m.b))));
$$;

drop policy if exists "see reactions where you can read" on public.message_reactions;
drop policy if exists "react where you can read" on public.message_reactions;
drop policy if exists "take back your own reaction" on public.message_reactions;
create policy "see reactions where you can read" on public.message_reactions for select
  using (public.can_see_message(message_id));
create policy "react where you can read" on public.message_reactions for insert
  with check (user_id = auth.uid() and public.can_see_message(message_id));
create policy "take back your own reaction" on public.message_reactions for delete
  using (user_id = auth.uid());

-- How far down each chat you have read. One row per person per chat, keyed by a short
-- string — 'g:12' for a group, 'u:<the other person>' for a private one — rather than by a
-- pair of nullable columns that no primary key can cover properly. Nobody reads anybody
-- else's: what you have read is not news to the person who sent it.
create table if not exists public.chat_reads (
  user_id uuid not null references public.profiles on delete cascade,
  chat text not null check (chat ~ '^(g:[0-9]+|u:[0-9a-f-]{36})$'),
  seen_at timestamptz not null default now(),
  primary key (user_id, chat)
);
alter table public.chat_reads enable row level security;
drop policy if exists "your own read marks" on public.chat_reads;
create policy "your own read marks" on public.chat_reads for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Everyone in the conversation hears about it, except whoever said it.
drop trigger if exists messages_notify on public.messages;
create trigger messages_notify after insert on public.messages
  for each row execute function public.notify_hook('message');
drop trigger if exists message_reactions_notify on public.message_reactions;
create trigger message_reactions_notify after insert on public.message_reactions
  for each row execute function public.notify_hook('message_reaction');

-- ============================================================
-- v29 (what is happening while you are looking, and what to say at the end of the day):
-- safe to run on an existing project.
--
-- Three things, none of which the app needs in order to work.
--
--   * The tables realtime is allowed to broadcast. Adding a table to the publication is
--     what lets the app hear about a row the moment it lands, instead of on the next
--     refetch. Row level security still decides who hears what — a publication grants
--     nothing that a policy does not already allow.
--   * Somebody saying yes. A friend request accepted and a group invite accepted both end
--     as a row, and until now the person who sent the invitation heard nothing at all.
--   * The end of the day, for somebody who has not finished. The only other thing in the
--     app that happens at a time rather than because somebody did something is the spin-day
--     reminder, and this rides the same hourly cron and the same profiles.tz for the same
--     reason: the server has no other way to know when evening is for anyone.
-- ============================================================

-- Realtime. A table not in the publication is simply never broadcast, and a project that
-- has not run this behaves exactly as it did before.
do $r$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'no supabase_realtime publication on this database; skipping';
    return;
  end if;
  foreach t in array array['posts', 'comments', 'likes', 'reactions', 'stories', 'story_likes',
                           'story_reactions', 'comment_likes', 'invites', 'group_members',
                           'friendships', 'messages', 'message_reactions', 'flags', 'flag_votes']
  loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_publication_tables
                        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $r$;

-- An update carries only the columns that changed unless the whole row is replicated, and
-- the app reads post_id and outcome off a flag being decided.
alter table public.flags replica identity full;

-- ---- somebody said yes
-- accept_invite() deletes the invite and writes the row, so the row is the only thing left
-- to hang this on. Which of the pair to tell is worked out by the function: it is whoever
-- did not just accept.
drop trigger if exists friendships_notify on public.friendships;
create trigger friendships_notify after insert on public.friendships
  for each row execute function public.notify_hook('accepted_friend');
drop trigger if exists group_members_notify on public.group_members;
create trigger group_members_notify after insert on public.group_members
  for each row execute function public.notify_hook('accepted_group');

-- ---- the end of somebody's day
-- One row per person per local day, so a retry or two crons overlapping cannot chase the
-- same person twice. Service role only, like wheel_reminders: no policies at all.
create table if not exists public.day_reminders (
  user_id uuid not null references public.profiles on delete cascade,
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.day_reminders enable row level security;

-- Whose evening it is right now, who is short, and by how much. The hour is 20:00 local:
-- late enough to be the end of the day, early enough to do something about it.
--
-- A post the group decided did not count is left out, exactly as the app leaves it out, or
-- the reminder would say a day was finished that the app shows as open.
create or replace function public.day_due_now()
returns table (user_id uuid, line text)
language sql security definer set search_path = public as $$
  with folk as (
    select p.id, coalesce(nullif(p.tz, ''), 'UTC') as zone
      from public.profiles p
     where coalesce(nullif(p.tz, ''), 'UTC') in (select name from pg_timezone_names)
  ), due as (
    select id, zone, (now() at time zone zone)::date as day
      from folk
     where extract(hour from (now() at time zone zone))::int = 20
  ), short as (
    select d.id as uid, d.day,
           q->>'metric' as metric,
           (q->>'target')::numeric as target,
           coalesce((
             select sum(po.amount) from public.posts po
              where po.group_id = g.id and po.user_id = d.id and po.day = d.day
                and po.metric = q->>'metric'
                and not exists (select 1 from public.flags f
                                 where f.post_id = po.id and f.outcome = 'upheld')
           ), 0) as did
      from due d
      join public.group_members gm on gm.user_id = d.id
      join public.groups g on g.id = gm.group_id
      cross join lateral jsonb_array_elements(coalesce(g.quotas, '[]'::jsonb)) q
      -- A rest day is not a day anybody is behind on.
     where (g.active_days is null or array_length(g.active_days, 1) is null
            or extract(dow from d.day)::int = any (g.active_days))
  ), behind as (
    select uid, day, metric, (target - did)::bigint as left_to_do
      from short where did < target
  ), claimed as (
    insert into public.day_reminders (user_id, day)
    select distinct uid, day from behind
    on conflict do nothing
    returning day_reminders.user_id as uid
  )
  -- The same metric in two groups is one number to the person reading it, so the largest
  -- of them is what is quoted rather than both.
  select c.uid, string_agg(x.what, ', ' order by x.what)
    from claimed c
    join lateral (
      select max(b.left_to_do)::text || ' ' || b.metric as what
        from behind b where b.uid = c.uid group by b.metric
    ) x on true
   group by c.uid;
$$;

-- The hourly cron already calls wheelday; it answers both questions now, so nothing new is
-- scheduled here. The function has to be redeployed for the second one to be asked.

-- Who did it. Every trigger above sends the row that changed, and for two of them the row
-- does not say who caused it: a friendship names a pair, and a membership names the person
-- who joined but not whether they joined or were put there. auth.uid() is the one thing
-- that knows, and it is only knowable here — by the time pg_net's call lands there is no
-- session left to ask. Every kind gains the field; nothing that ignores it changes.
create or replace function public.notify_hook() returns trigger
language plpgsql security definer set search_path = public as $$
declare secret text := coalesce((select value from private.config where key = 'hook_secret'), '');
begin
  if secret = '' then
    raise warning 'notify_hook: no hook_secret in private.config, so % notifications are not being sent', TG_ARGV[0];
    return new;
  end if;
  perform net.http_post(
    url     := 'https://txvjakpeyfnzigtsvmja.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', secret),
    body    := jsonb_build_object('kind', TG_ARGV[0],
                                  'record', to_jsonb(new) || jsonb_build_object('actor', auth.uid()))
  );
  return new;
end $$;

-- ============================================================
-- v30 (a picture for a group): safe to run on an existing project.
--
-- The same bucket, the same crop, the same 512px square a person's picture is. What is
-- different is who may write one: the avatars policies key on the first folder being your
-- own user id, and a group is not a user.
--
-- So a group's picture lives at g/<group id>/<timestamp>.jpg, and the policy asks the same
-- question the groups table asks about editing one — are you in it. Any member can change
-- it, which is exactly what "members edit the group" already allows for its name and its
-- quotas, and a picture is not a stronger thing to change than the name.
-- ============================================================
alter table public.groups add column if not exists avatar_path text;

drop policy if exists "upload a group picture" on storage.objects;
drop policy if exists "replace a group picture" on storage.objects;
drop policy if exists "delete a group picture" on storage.objects;
-- The id is matched as digits before it is cast: a folder that is not a number would throw
-- rather than fail the check, and a policy that throws is a policy nobody can write past.
create policy "upload a group picture" on storage.objects for insert
  with check (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'g'
    and (storage.foldername(name))[2] ~ '^[0-9]+$'
    and public.is_member(((storage.foldername(name))[2])::bigint));
create policy "replace a group picture" on storage.objects for update
  using (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'g'
    and (storage.foldername(name))[2] ~ '^[0-9]+$'
    and public.is_member(((storage.foldername(name))[2])::bigint));
create policy "delete a group picture" on storage.objects for delete
  using (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'g'
    and (storage.foldername(name))[2] ~ '^[0-9]+$'
    and public.is_member(((storage.foldername(name))[2])::bigint));
-- Reading needs nothing new: "avatars are public" already covers the whole bucket, the
-- same as it does for a person's picture.

-- ============================================================
-- v31 (the reminder functions are the cron's, not the world's): worth running.
--
-- wheel_due_now() and day_due_now() both *claim* what they return — a row per person per
-- cycle, per person per day — so that a retry or two overlapping cron runs cannot wake the
-- same person twice. That is the right design and it has a sharp edge: calling one is not a
-- read, it spends the reminder.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and PostgREST serves everything in
-- `public` to anybody holding the anon key, which ships inside index.html and is meant to.
-- So both were one POST away from anyone who viewed source, and repeated calls would have
-- claimed every pending reminder and sent none: no spin-day notification, no end-of-day
-- one, and nothing anywhere saying why.
--
-- Only the edge function needs them, and it connects as the service role. Nothing in the
-- app calls either one.
-- ============================================================
revoke all on function public.wheel_due_now() from public, anon, authenticated;
revoke all on function public.day_due_now() from public, anon, authenticated;
grant execute on function public.wheel_due_now() to service_role;
grant execute on function public.day_due_now() to service_role;

-- ============================================================
-- v32 (revoking from public is not enough on Supabase): worth running.
--
-- v27 tried to keep close_due_flags to signed-in accounts with `revoke all ... from public`
-- and it did not work. Supabase grants EXECUTE on functions in `public` to anon and to
-- authenticated *directly*, and revoking from PUBLIC does not remove a direct grant — so
-- the anon key, which ships inside index.html on purpose, could still call it. v31 worked
-- on the two reminder functions precisely because it named the roles.
--
-- Calling this one is harmless: it closes flags already past their deadline or already
-- fully voted, so it applies a rule that is true whether anyone calls it or not, and claims
-- nothing. It is revoked anyway, because a test in test/policies.test.sql says anon cannot
-- reach it, and a test that passes on a plain Postgres while the real database says
-- otherwise is worse than no test — it is a suite that has stopped describing the thing it
-- is pointed at.
--
-- Every other function anon can reach was checked at the same time and defends itself:
-- create_group answers "not signed in", accept_invite finds no invite, spin, sit_out and
-- use_challenge find no wheel and no spin. They read auth.uid() before they do anything, so
-- reaching them achieves nothing. Nothing else needs revoking.
-- ============================================================
revoke all on function public.close_due_flags() from public, anon;
grant execute on function public.close_due_flags() to authenticated;

-- v33 (an invite that travels as a link): worth running.
--
-- A group invite was only ever one account picking another out of their friends, which
-- cannot reach somebody who is not here yet. A code on the group turns the same invite
-- into a link that goes in a text message.
--
-- Multi-use and with no expiry, because that is what a link in a group chat has to be: one
-- person forwards it to four others and all four should land in the group. A link that
-- went somewhere it should not is taken out of service by rotating it, which is the second
-- argument to group_code() — a new code, and the old link stops working.
alter table public.groups add column if not exists join_code text unique;

-- URL-safe and alphanumeric: base64's three odd characters are folded away rather than
-- escaped, so the code survives being pasted into anything.
--
-- Built out of gen_random_uuid() rather than pgcrypto's gen_random_bytes(). On Supabase
-- pgcrypto is installed into the extensions schema, so `set search_path = public` on this
-- function puts it out of reach and the create fails with 42883. gen_random_uuid() has
-- been in pg_catalog since Postgres 13, which no search_path can hide, so there is no
-- extension to install and nothing to qualify. Twelve characters of a 16-byte value is 72
-- bits, which is not worth guessing at.
create or replace function public.new_join_code() returns text
language sql volatile set search_path = public as $$
  select substr(translate(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', 'xyz'), 1, 12);
$$;

-- The code for a group you are in, made the first time anybody asks for it.
create or replace function public.group_code(gid bigint, rotate boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_member(gid) then raise exception 'not a member of that group'; end if;
  select join_code into c from public.groups where id = gid;
  if c is null or rotate then
    loop
      c := public.new_join_code();
      begin
        update public.groups set join_code = c where id = gid;
        exit;
      exception when unique_violation then                  -- astronomically unlikely; still cheap to handle
      end;
    end loop;
  end if;
  return c;
end $$;

-- What a link may say before you are in: the name of the group it points at, and nothing
-- else. Reachable without an account, because whoever opened the link has not got one yet.
create or replace function public.code_group(code text) returns table (id bigint, name text)
language sql security definer stable set search_path = public as $$
  select g.id, g.name from public.groups g where g.join_code = code;
$$;

-- Joining. security definer because somebody who is not in the group yet has no business
-- writing to its member list on their own account. Already in gives the same answer, so a
-- link opened twice is not an error.
create or replace function public.join_by_code(code text) returns bigint
language plpgsql security definer set search_path = public as $$
declare gid bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into gid from public.groups where join_code = code;
  if gid is null then raise exception 'that invite link is not valid'; end if;
  insert into public.group_members (group_id, user_id) values (gid, auth.uid()) on conflict do nothing;
  return gid;
end $$;

-- Naming the roles, not PUBLIC: Supabase grants execute on functions in public to anon and
-- authenticated directly, and revoking from PUBLIC leaves those grants standing. v32 is
-- the same lesson.
revoke all on function public.new_join_code() from public, anon, authenticated;
revoke all on function public.group_code(bigint, boolean) from public, anon;
revoke all on function public.join_by_code(text) from public, anon;
revoke all on function public.code_group(text) from public;
grant execute on function public.group_code(bigint, boolean) to authenticated;
grant execute on function public.join_by_code(text) to authenticated;
grant execute on function public.code_group(text) to anon, authenticated;

-- v34 (one decision a day, per person): worth running. Needs wheelday redeployed after.
--
-- There were two reminders and they did not know about each other: spin day, and a nudge
-- at 20:00 for anybody short. Three would have been three ways to be woken by the same
-- app on the same evening, so this replaces the second with a single decision taken once
-- per person per day, which is the only way to promise what lands.
--
-- What it promises: somebody using the app gets the window opening, and possibly a last
-- call. Somebody who has not opened it in three days gets one message instead of the
-- window one, not as well as it. Nobody ever gets both.

-- When the app was last opened. Not when they signed in — an account can stay signed in
-- for months without anyone looking at it, and "lapsed" is about looking.
alter table public.profiles add column if not exists seen_at timestamptz not null default now();

-- day_reminders held one row per person per day, which was enough while there was one
-- kind of reminder. The kind is part of what is claimed now.
alter table public.day_reminders add column if not exists kind text not null default 'lastcall';
alter table public.day_reminders drop constraint if exists day_reminders_pkey;
alter table public.day_reminders add primary key (user_id, day, kind);

-- A prompt that lands at the same minute every day is an alarm clock, and an alarm clock
-- gets turned off. The hour is a hash of the person and the date, so it moves around the
-- day for them but never moves within a day: the hourly cron can ask "is it now" without
-- anything being written down in advance, and a retry an hour later cannot shift it.
--
-- hashtext can return the one negative number whose abs() overflows, so it is widened
-- before it is made positive.
create or replace function public.slot_hour(uid uuid, d date) returns int
language sql immutable set search_path = public as $$
  select 10 + (abs(hashtext(uid::text || d::text)::bigint) % 10)::int;   -- 10:00 to 19:00
$$;

-- The window runs from the prompt to midnight, so the last quarter of it depends on when
-- the prompt went. Never later than 22:00: a message at ten to midnight is not a last
-- call, it is a notification about something you can no longer do.
create or replace function public.lastcall_hour(h int) returns int
language sql immutable set search_path = public as $$
  select least(22, h + ceil(0.75 * (24 - h))::int);
$$;

-- The one decision. Everything about who gets what today is settled here, and the claim is
-- what makes it a decision rather than a suggestion: two callers racing, or a cron firing
-- twice, cannot both take the same person and kind.
create or replace function public.notices_due_now()
returns table (user_id uuid, kind text, hours int, group_name text, others int, mates int)
language sql security definer set search_path = public as $$
  with folk as (
    select p.id, coalesce(nullif(p.tz, ''), 'UTC') as zone, p.seen_at
      from public.profiles p
     where coalesce(nullif(p.tz, ''), 'UTC') in (select name from pg_timezone_names)
       -- nobody is reminded about a group they are not in
       and exists (select 1 from public.group_members gm where gm.user_id = p.id)
  ), whenIs as (
    select id, zone, seen_at,
           (now() at time zone zone)::date as day,
           extract(hour from (now() at time zone zone))::int as hr
      from folk
  ), plan as (
    select w.*,
           public.slot_hour(w.id, w.day) as slot,
           public.lastcall_hour(public.slot_hour(w.id, w.day)) as lc,
           (w.seen_at < now() - interval '3 days') as lapsed,
           exists (select 1 from public.posts po where po.user_id = w.id and po.day = w.day) as posted
      from whenIs w
  ), want as (
    -- Exactly one of the first two can match, because they are the same hour and lapsed is
    -- a yes or a no. The third is a different hour, and never fires for somebody lapsed.
    select id, day, 'lapsed'::text as kind, 0 as hours from plan where hr = slot and lapsed
    union all
    select id, day, 'open'::text, 24 - slot from plan where hr = slot and not lapsed
    union all
    select id, day, 'lastcall'::text, 24 - hr from plan where hr = lc and not lapsed and not posted
  ), pick as (
    -- Which group the message is about: the one where the most other people have already
    -- posted today, because that is the one worth mentioning.
    select w.id, w.day, w.kind, w.hours, x.gname, x.others, x.mates
      from want w
      left join lateral (
        select g.name as gname,
               count(*) filter (where exists (
                 select 1 from public.posts po
                  where po.group_id = g.id and po.user_id = gm2.user_id and po.day = w.day)) as others,
               count(*) as mates
          from public.group_members gm
          join public.groups g on g.id = gm.group_id
          join public.group_members gm2 on gm2.group_id = g.id and gm2.user_id <> w.id
         where gm.user_id = w.id
         group by g.id, g.name
         order by 2 desc, g.id
         limit 1
      ) x on true
  ), claimed as (
    insert into public.day_reminders (user_id, day, kind)
    select id, day, kind from pick
    on conflict do nothing
    returning day_reminders.user_id as uid, day_reminders.kind as k
  )
  select p.id, p.kind, p.hours, coalesce(p.gname, ''), coalesce(p.others, 0)::int, coalesce(p.mates, 0)::int
    from pick p join claimed c on c.uid = p.id and c.k = p.kind;
$$;

-- day_due_now() is what this replaces. Left in place would be a second claim on the same
-- table under a default kind, which is the double-send this block exists to stop.
drop function if exists public.day_due_now();

-- The same shape as v31, and the grant matters as much as the revoke: on a plain Postgres
-- every role reaches a new function through PUBLIC, so revoking from PUBLIC takes it away
-- from the cron too. Only the edge function needs this one, and it connects as the service
-- role. The two helpers are called from inside a security definer function, which runs as
-- its owner, so nothing needs to reach them directly at all.
revoke all on function public.slot_hour(uuid, date) from public, anon, authenticated;
revoke all on function public.lastcall_hour(int) from public, anon, authenticated;
revoke all on function public.notices_due_now() from public, anon, authenticated;
grant execute on function public.notices_due_now() to service_role;

-- v35 (something back for sharing): worth running.
--
-- The first time anybody in a group shares a recap or a streak card out of the app, the
-- group gets to choose the mark that sits beside its streak. Once per group, not once per
-- person: it is the group's streak on the card, so it is the group's to unlock.
--
-- No new table and no function. Members can already update their own group, which is
-- exactly who is allowed to set these.
alter table public.groups add column if not exists shared_at timestamptz;
alter table public.groups add column if not exists mark text;

-- v36 (the story sweep moves off pg_cron): worth running. Needs wheelday redeployed.
--
-- stories-expire deleted the rows and then the files. Supabase now refuses direct deletion
-- from storage.objects, and pg_cron runs a job body as one transaction — so the second
-- statement's error rolled back the first and nothing expired at all. Found on 2026-09-22
-- failing 24 times out of 24 runs, with ten expired stories still sitting there. Nothing
-- anywhere said so, because a cron failure is only visible in cron.job_run_details.
--
-- Deleting a file is the storage API's job, so it moves to the function that already runs
-- on this beat and already holds the service key. Unscheduled rather than rewritten:
-- two things deleting the same rows is the shape of bug v34 exists to prevent.
select cron.unschedule('stories-expire') where exists (select 1 from cron.job where jobname = 'stories-expire');

-- v37 (a failing cron job says so): worth running. Needs wheelday redeployed after.
--
-- stories-expire failed 24 times out of 24 runs and nothing anywhere said so. A cron
-- failure is invisible: no error in the app, nothing in the logs anybody reads, no user
-- complaint. The only record is cron.job_run_details, and nothing looks at it unless a
-- person thinks to.
--
-- PostgREST only serves the public schema, so the edge function cannot read that table
-- directly. This is the window onto it, and nothing but the cron's own function may look
-- through it.
--
-- cron.job_run_details is written schema-qualified rather than left to the search_path.
-- That is the v33 lesson: `set search_path = public` hid pgcrypto and the create failed
-- with 42883, so anything outside public is named in full here.
create or replace function public.cron_health(hours int default 24)
returns table (jobname text, failures bigint, last_message text)
language sql security definer set search_path = public as $$
  select coalesce(j.jobname, 'unnamed job ' || r.jobid::text),
         count(*),
         (array_agg(r.return_message order by r.start_time desc))[1]
    from cron.job_run_details r
    left join cron.job j on j.jobid = r.jobid
   where r.status = 'failed'
     and r.start_time > now() - make_interval(hours => hours)
   group by 1
   order by 2 desc;
$$;

revoke all on function public.cron_health(int) from public, anon, authenticated;
grant execute on function public.cron_health(int) to service_role;

-- v38 (three things the evening message was getting wrong): worth running. Needs wheelday
-- redeployed after.
--
-- 1. Last call only fired for somebody who had posted NOTHING. v34 wrote it that way and
--    narrowed what v29 used to do: the old 20:00 nudge went to anyone SHORT of the quota,
--    so twenty of fifty pushups still got told. Under v34 it got silence — short, late,
--    and nothing said. Worse, the check was not scoped to a group, so posting in one
--    silenced the evening for every other one too.
-- 2. Lapsed keyed on not having OPENED the app. Somebody who opens it every day and never
--    posts is not drifting away, they are here and not doing the thing, and they were
--    getting the cheerful window prompt as if all were well.
-- 3. A wheel challenge could run out with nothing said. The only wheel notification was
--    spin day, at the START of a cycle. Nothing ever looked at whether the challenge was
--    actually finished before the cycle closed.
--
-- The evening still carries at most one message. A challenge about to run out is the more
-- urgent of the two, so it takes the hour and last call stands down.

-- How many days of a challenge are really done: days in the cycle where the posts marked
-- with that spin meet the whole of that day's quota on their own. The same rule the app
-- draws, in the one other place that has to know it. A post the group voided is left out,
-- exactly as everywhere else.
create or replace function public.challenge_day_count(p_spin bigint, p_today date)
returns int language sql stable set search_path = public as $$
  with s as (
    select sp.id, sp.user_id, sp.cycle, w.every_days, w.starts_on, g.quotas
      from public.spins sp
      join public.wheels w on w.id = sp.wheel_id
      join public.groups g on g.id = w.group_id
     where sp.id = p_spin
  ), span as (
    select s.*, (s.starts_on + (s.cycle * s.every_days))::date as c0,
                least((s.starts_on + ((s.cycle + 1) * s.every_days - 1))::date, p_today) as c1
      from s
  ), d as (
    select span.*, gs::date as day
      from span, lateral generate_series(span.c0, span.c1, interval '1 day') gs
     where span.c1 >= span.c0
  )
  select count(*)::int from d
   where jsonb_array_length(coalesce(d.quotas, '[]'::jsonb)) > 0
     and not exists (
       select 1 from jsonb_array_elements(d.quotas) q
        where coalesce((
                select sum(po.amount) from public.posts po
                 where po.spin_id = d.id and po.user_id = d.user_id and po.day = d.day
                   and po.metric = q->>'metric'
                   and not exists (select 1 from public.flags f where f.post_id = po.id and f.outcome = 'upheld')
              ), 0) < (q->>'target')::numeric);
$$;

-- How many it needs. A wheel with a day wheel on it says so on the spin; one without means
-- every day it is running. Read off the wheel rather than the spin so it is right for
-- spins taken before that rule existed, which is what the app does too.
create or replace function public.challenge_required(p_spin bigint)
returns int language sql stable set search_path = public as $$
  select case when exists (select 1 from public.wheel_stages st
                            where st.wheel_id = sp.wheel_id and st.kind = 'days')
              then sp.days_required else w.every_days end
    from public.spins sp join public.wheels w on w.id = sp.wheel_id
   where sp.id = p_spin;
$$;

-- Dropped rather than replaced: this one gains three columns, and Postgres will not let
-- create-or-replace change a function's return type. Nothing depends on it by name except
-- the edge function that calls it over REST.
drop function if exists public.notices_due_now();

create function public.notices_due_now()
returns table (user_id uuid, kind text, hours int, group_name text, others int, mates int,
               line text, done int, needs int)
language sql security definer set search_path = public as $$
  with folk as (
    select p.id, coalesce(nullif(p.tz, ''), 'UTC') as zone, p.created_at
      from public.profiles p
     where coalesce(nullif(p.tz, ''), 'UTC') in (select name from pg_timezone_names)
       and exists (select 1 from public.group_members gm where gm.user_id = p.id)
  ), whenIs as (
    select id, zone, created_at,
           (now() at time zone zone)::date as day,
           extract(hour from (now() at time zone zone))::int as hr
      from folk
  ), plan as (
    select w.*,
           public.slot_hour(w.id, w.day) as slot,
           public.lastcall_hour(public.slot_hour(w.id, w.day)) as lc,
           -- Lapsed is about not posting, not about not looking. An account younger than
           -- the window is new rather than lapsed, and is left alone.
           (w.created_at < now() - interval '3 days'
            and not exists (select 1 from public.posts po
                             where po.user_id = w.id and po.day > w.day - 3)) as lapsed
      from whenIs w
  ), short as (
    -- Per group and per quota, what is still owed today. A rest day is not a day anybody
    -- is behind on, and a voided post never counted.
    select pl.id as uid, pl.day, g.id as gid, g.name as gname,
           q->>'metric' as metric,
           ((q->>'target')::numeric - coalesce((
              select sum(po.amount) from public.posts po
               where po.group_id = g.id and po.user_id = pl.id and po.day = pl.day
                 and po.metric = q->>'metric'
                 and not exists (select 1 from public.flags f where f.post_id = po.id and f.outcome = 'upheld')
            ), 0))::bigint as owed
      from plan pl
      join public.group_members gm on gm.user_id = pl.id
      join public.groups g on g.id = gm.group_id
      cross join lateral jsonb_array_elements(coalesce(g.quotas, '[]'::jsonb)) q
     where (g.active_days is null or array_length(g.active_days, 1) is null
            or extract(dow from pl.day)::int = any (g.active_days))
  ), behind as (
    select uid, day, string_agg(distinct owed::text || ' ' || metric, ', ') as line
      from short where owed > 0 group by uid, day
  ), closing as (
    -- A challenge whose cycle shuts today and is not finished. Sitting a cycle out is a
    -- decision about it, so it is not unfinished.
    select pl.id as uid, pl.day, w.name as wname,
           public.challenge_day_count(sp.id, pl.day) as done,
           public.challenge_required(sp.id) as needs
      from plan pl
      join public.group_members gm on gm.user_id = pl.id
      join public.wheels w on w.group_id = gm.group_id and w.active
      join public.spins sp on sp.wheel_id = w.id and sp.user_id = pl.id
                          and sp.cycle = public.wheel_cycle(w, pl.day)
     where not sp.sat_out
       and (w.starts_on + ((sp.cycle + 1) * w.every_days - 1))::date = pl.day
  ), closingNow as (
    select distinct on (uid) uid, day, wname, done, needs
      from closing where done < needs order by uid, needs - done desc, wname
  ), want as (
    select id, day, 'lapsed'::text as kind, 0 as hours from plan where hr = slot and lapsed
    union all
    select id, day, 'open'::text, 24 - slot from plan where hr = slot and not lapsed
    union all
    -- The evening holds one message. A challenge running out tonight is the more urgent,
    -- so last call stands down for anybody who is getting that instead.
    select pl.id, pl.day, 'challenge'::text, 24 - pl.hr from plan pl
      join closingNow c on c.uid = pl.id where pl.hr = pl.lc and not pl.lapsed
    union all
    select pl.id, pl.day, 'lastcall'::text, 24 - pl.hr from plan pl
      join behind b on b.uid = pl.id
     where pl.hr = pl.lc and not pl.lapsed
       and not exists (select 1 from closingNow c where c.uid = pl.id)
  ), pick as (
    select w.id, w.day, w.kind, w.hours, x.gname, x.others, x.mates,
           b.line, c.done, c.needs, c.wname
      from want w
      left join behind b on b.uid = w.id and b.day = w.day
      left join closingNow c on c.uid = w.id and c.day = w.day
      left join lateral (
        select g.name as gname,
               count(*) filter (where exists (
                 select 1 from public.posts po
                  where po.group_id = g.id and po.user_id = gm2.user_id and po.day = w.day)) as others,
               count(*) as mates
          from public.group_members gm
          join public.groups g on g.id = gm.group_id
          join public.group_members gm2 on gm2.group_id = g.id and gm2.user_id <> w.id
         where gm.user_id = w.id
         group by g.id, g.name
         order by 2 desc, g.id
         limit 1
      ) x on true
  ), claimed as (
    insert into public.day_reminders (user_id, day, kind)
    select id, day, kind from pick
    on conflict do nothing
    returning day_reminders.user_id as uid, day_reminders.kind as k
  )
  select p.id, p.kind, p.hours,
         coalesce(nullif(p.wname, ''), p.gname, ''), coalesce(p.others, 0)::int, coalesce(p.mates, 0)::int,
         coalesce(p.line, ''), coalesce(p.done, 0)::int, coalesce(p.needs, 0)::int
    from pick p join claimed c on c.uid = p.id and c.k = p.kind;
$$;

revoke all on function public.challenge_day_count(bigint, date) from public, anon, authenticated;
revoke all on function public.challenge_required(bigint) from public, anon, authenticated;
revoke all on function public.notices_due_now() from public, anon, authenticated;
grant execute on function public.notices_due_now() to service_role;

-- v39 (muting a group): worth running.
--
-- Notifications were one switch for the whole app. Somebody who found one group's chat
-- noisy had to turn off the reminders the app exists for in order to quiet it, which is
-- how an app gets its notifications switched off for good.
--
-- The flag sits on the membership rather than the group: it is one person's decision about
-- one group, not a property of the group, and everybody else in it carries on as before.
alter table public.group_members add column if not exists muted boolean not null default false;

-- Set through a function rather than an update policy. A policy allowing `user_id =
-- auth.uid()` on both sides would also allow rewriting group_id on your own row, which is
-- joining any group you can name — the check sees the new row, and the new row is still
-- yours. A function changes the one column and nothing else.
create or replace function public.mute_group(gid bigint, on_off boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(gid) then raise exception 'not a member of that group'; end if;
  update public.group_members set muted = on_off
   where group_id = gid and user_id = auth.uid();
end $$;

revoke all on function public.mute_group(bigint, boolean) from public, anon;
grant execute on function public.mute_group(bigint, boolean) to authenticated;

-- v40 (a job that is gone is not failing): worth running. No redeploy needed.
--
-- v37 alerted on "unnamed job 3 has failed 17 times" at midnight UTC on 2026-09-23. Job 3
-- was stories-expire, which v36 had already unscheduled that morning. Its failures were
-- still in cron.job_run_details and still inside the 24-hour window, and the left join
-- kept them while losing the name — so the alert described a problem already fixed, about
-- a job it could no longer name.
--
-- Only jobs that are still scheduled and switched on are asked about. A failure on a job
-- that no longer runs is history, not something anybody can act on.
create or replace function public.cron_health(hours int default 24)
returns table (jobname text, failures bigint, last_message text)
language sql security definer set search_path = public as $$
  select coalesce(j.jobname, 'job ' || r.jobid::text),
         count(*),
         (array_agg(r.return_message order by r.start_time desc))[1]
    from cron.job_run_details r
    join cron.job j on j.jobid = r.jobid and j.active
   where r.status = 'failed'
     and r.start_time > now() - make_interval(hours => hours)
   group by 1
   order by 2 desc;
$$;

revoke all on function public.cron_health(int) from public, anon, authenticated;
grant execute on function public.cron_health(int) to service_role;

-- v40 (an invite from somebody, not just to something): worth running.
--
-- v33 put one invite link on each group. That link knew where it led but not who sent it,
-- so joining put you in the group and left you a stranger to whoever brought you. A link
-- per person per group knows both, and joining through one now makes you friends with the
-- person who sent it as well as a member.
--
-- The inviter cannot travel in the URL beside the code: anybody could edit it and be made
-- friends with whoever they liked. It lives here, against a code only the server hands out.
--
-- Links sent before this keep working. They were group links and still are; they just
-- cannot make a friendship, because nothing ever recorded who sent them.
create table if not exists public.invite_links (
  code text primary key,
  group_id bigint not null references public.groups on delete cascade,
  inviter_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, inviter_id)
);
-- Row level security on and no policies: the three functions below are the only way in,
-- which keeps the codes themselves out of reach of anybody browsing the table.
alter table public.invite_links enable row level security;

-- Your own link for a group you are in, made the first time you ask. rotate => a new one,
-- which is how a link that went somewhere it should not is taken out of service.
create or replace function public.my_invite_code(gid bigint, rotate boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_member(gid) then raise exception 'not a member of that group'; end if;
  select code into c from public.invite_links where group_id = gid and inviter_id = auth.uid();
  if c is not null and not rotate then return c; end if;
  loop
    c := public.new_join_code();
    -- Unique across both kinds of link, so a code can only ever mean one thing.
    exit when not exists (select 1 from public.invite_links where code = c)
          and not exists (select 1 from public.groups where join_code = c);
  end loop;
  insert into public.invite_links (code, group_id, inviter_id) values (c, gid, auth.uid())
  on conflict (group_id, inviter_id) do update set code = excluded.code, created_at = now();
  return c;
end $$;

-- What the landing page may say before anybody has an account: who sent it, which group,
-- what the group does and how many are in it. Nothing else — no member names, no posts.
-- Dropped rather than replaced because the columns it returns have changed.
drop function if exists public.code_group(text);
create function public.code_group(code text)
returns table (id bigint, name text, inviter text, quotas jsonb, members int)
language sql security definer stable set search_path = public as $$
  select g.id, g.name,
         coalesce(p.display_name, p.username),
         coalesce(g.quotas, '[]'::jsonb),
         (select count(*)::int from public.group_members gm where gm.group_id = g.id)
    from public.groups g
    left join public.invite_links l on l.code = code_group.code and l.group_id = g.id
    left join public.profiles p on p.id = l.inviter_id
   where g.id = coalesce(
           (select l2.group_id from public.invite_links l2 where l2.code = code_group.code),
           (select g2.id from public.groups g2 where g2.join_code = code_group.code));
$$;

-- Joining. A person's link also makes you friends with them; an old group link does not,
-- because it never knew who sent it. Following your own link joins nothing new and makes
-- nobody your friend.
create or replace function public.join_by_code(code text) returns bigint
language plpgsql security definer set search_path = public as $$
declare gid bigint; who uuid; me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  select l.group_id, l.inviter_id into gid, who from public.invite_links l where l.code = join_by_code.code;
  if gid is null then
    select g.id into gid from public.groups g where g.join_code = join_by_code.code;
  end if;
  if gid is null then raise exception 'that invite link is not valid'; end if;
  insert into public.group_members (group_id, user_id) values (gid, me) on conflict do nothing;
  if who is not null and who <> me then
    insert into public.friendships (a, b) values (least(me, who), greatest(me, who)) on conflict do nothing;
    -- A friend request already sitting between the two is answered by this, not left open.
    delete from public.invites
     where type = 'friend' and ((from_user = me and to_user = who) or (from_user = who and to_user = me));
  end if;
  return gid;
end $$;

revoke all on function public.my_invite_code(bigint, boolean) from public, anon;
revoke all on function public.join_by_code(text) from public, anon;
revoke all on function public.code_group(text) from public;
grant execute on function public.my_invite_code(bigint, boolean) to authenticated;
grant execute on function public.join_by_code(text) to authenticated;
grant execute on function public.code_group(text) to anon, authenticated;

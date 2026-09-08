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

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

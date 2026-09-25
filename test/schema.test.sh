#!/usr/bin/env bash
# Checks the wheels block of schema.sql against a real Postgres: the cycle maths, the
# spin being unrepeatable, the posting barrier, and who can see or forge what.
#
#   test/schema.test.sh                 builds a throwaway database (needs initdb)
#   DATABASE_URL=... test/schema.test.sh   runs against one you already have
#
# The spin rules are the kind of thing that breaks quietly: a policy dropped during an
# edit would not fail anywhere else, it would just let someone roll again until they
# liked the answer.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ]; then
  PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
  command -v initdb >/dev/null 2>&1 && PGBIN=$(dirname "$(command -v initdb)")
  if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/initdb" ]; then
    echo "SKIP: schema tests need postgres (apt-get install postgresql, or set DATABASE_URL)"; exit 0
  fi
  DIR=$(mktemp -d); trap 'set +e; "$PGBIN/pg_ctl" -D "$DIR/data" stop -m immediate >/dev/null 2>&1; rm -rf "$DIR"' EXIT
  mkdir -p "$DIR/data" "$DIR/sock"
  # postgres refuses to run as root, so hand the whole thing to an unprivileged user
  RUN=""
  if [ "$(id -u)" = 0 ]; then
    id pgtest >/dev/null 2>&1 || useradd -m pgtest
    chown -R pgtest "$DIR"; RUN="setpriv --reuid=pgtest --regid=$(id -g pgtest) --clear-groups"
  fi
  $RUN "$PGBIN/initdb" -D "$DIR/data" -U pgtest --auth=trust >"$DIR/initdb.log" 2>&1
  $RUN "$PGBIN/pg_ctl" -D "$DIR/data" -o "-k $DIR/sock -h ''" -l "$DIR/pg.log" -w start >/dev/null
  $RUN "$PGBIN/createdb" -h "$DIR/sock" -U pgtest quota
  DATABASE_URL="postgresql://pgtest@/quota?host=$DIR/sock"
fi

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' RETURN 2>/dev/null || true

# Stand-ins for the pieces Supabase provides, matching how the real ones behave.
cat > "$WORK/shim.sql" <<'EOF'
-- The roles Supabase connects as: two for PostgREST and one the edge functions use. A
-- plain Postgres has none of them, so a grant naming one is an error rather than a no-op,
-- and a shim that is half the truth is worse than one that is all of it.
do $r$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $r$;
create schema if not exists auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;
-- pg_net only exists on Supabase. Stubbed rather than cut out, so the triggers that call
-- it are really created and really fire — what they would have sent is not the point here,
-- but a trigger that cannot be created at all very much is.
create schema if not exists net;
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
  returns bigint language sql as $fn$ select 1::bigint $fn$;
-- pg_cron only exists on Supabase. Its scheduling calls are cut out of schema.sql before
-- it is applied here, because a schedule is a call into a function rather than logic of
-- its own — but a function that READS the run history is logic, and belongs under test
-- like anything else. So the two tables it reads are stubbed instead of the function being
-- cut, which is the same choice net.http_post gets and for the same reason: a function
-- that cannot be created at all is very much the point.
create schema if not exists cron;
create table cron.job (jobid bigint primary key, jobname text, active boolean not null default true);
create table cron.job_run_details (jobid bigint, runid bigint, status text,
  return_message text, start_time timestamptz);
-- Enough of Supabase's storage schema for the bucket statements to run rather than be
-- cut out of the file. Only the columns schema.sql actually touches.
create schema if not exists storage;
create table storage.buckets (id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
insert into storage.buckets (id, name) values ('proof', 'proof'), ('avatars', 'avatars');
-- The objects themselves, and the helper the policies read paths with, so a block that
-- puts policies on storage can be applied here rather than cut out and left unchecked.
-- foldername returns the folders and not the file, which is what the real one does.
create table storage.objects (id bigserial primary key, bucket_id text, name text,
  owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $fn$ select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $fn$;
EOF

# The tables and helper the wheels block builds on, plus the block itself, taken straight
# out of schema.sql so this cannot drift from what actually gets run in Supabase.
python3 - "$WORK" <<'EOF'
import sys
s = open('supabase/schema.sql').read()
w = sys.argv[1]
# The tables, the helper every policy leans on, and every block of row level security up
# to the wheels. Without the RLS statements the base tables come up with it switched off,
# and a policy would sit there doing nothing while its test passed. Anything touching
# storage.objects or storage.buckets is cut: that schema only exists inside Supabase.
open(f'{w}/base.sql', 'w').write(
    s[s.index('create table public.profiles'):s.index('-- create a profile row')] +
    s[s.index('create function public.is_member'):s.index('create function public.create_group')] +
    s[s.index('-- row level security'):s.index('-- video storage')] +
    s[s.index('-- v2 (redesign)'):s.index('-- v3 (profile)')] +
    s[s.index('-- v3 (profile)'):s.index("insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)\n  values ('avatars'")])
# Everything from the wheels block on, with every pg_cron scheduling block cut out of the
# middle: that extension only exists on Supabase, and each one is a call into a function
# above rather than logic of its own. What they schedule — wheel_due_now() — is covered
# below. Anything after them still has to be applied, or a later block would be silently
# skipped. All of them, not just the first: a second one was added in v16, and cutting only
# the first left it in to fail on a plain Postgres.
#
# Cut on the statements rather than on the comment above them. Every scheduling block
# happened to open with the same sentence, so that is what this matched on, and the first
# one worded differently would have been left in to fail here for a reason nothing said out
# loud. Two things go: the extension itself, which is not installable on a plain Postgres,
# and each scheduling call, which needs it. The comment used to carry the extension line out
# with it by accident, which is exactly the kind of thing a marker made of prose does.
body = s[s.index('-- v6 (wheels)'):]
body = body.replace('create extension if not exists pg_cron;\n', '')
#
# An unschedule is not always followed by a schedule. v36 retires stories-expire without
# putting anything back, and this loop used to cut from the unschedule to the next
# '$cron$);' whatever that was — with none left in the file it ran off the end and died
# with "substring not found", which says nothing about what is wrong. So the pair is only
# taken as a pair when a schedule really does follow it with nothing in between; otherwise
# just the one statement goes.
CRON = 'select cron.unschedule('
while CRON in body:
    cut = body.index(CRON)
    end = body.index(';', cut) + 1
    nxt = body.find('select cron.schedule(', end)
    close = body.find('$cron$);', end)
    if nxt != -1 and close != -1 and not body[end:nxt].strip():
        end = close + len('$cron$);')
    body = body[:cut] + body[end:]
open(f'{w}/v6.sql', 'w').write(body)
EOF

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "set client_min_messages = warning" -f "$WORK/shim.sql" -f "$WORK/base.sql" -f "$WORK/v6.sql" >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f test/policies.test.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f test/schema.test.sql

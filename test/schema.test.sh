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
create schema if not exists auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;
EOF

# The tables and helper the wheels block builds on, plus the block itself, taken straight
# out of schema.sql so this cannot drift from what actually gets run in Supabase.
python3 - "$WORK" <<'EOF'
import sys
s = open('schema.sql').read()
w = sys.argv[1]
open(f'{w}/base.sql', 'w').write(
    s[s.index('create table public.profiles'):s.index('-- create a profile row')] +
    s[s.index('create function public.is_member'):s.index('create function public.create_group')])
# Everything from the wheels block on, with the pg_cron scheduling cut out of the middle:
# that extension only exists on Supabase, and it is a call into the function above rather
# than logic of its own. What it schedules — wheel_due_now() — is covered below. Anything
# after it still has to be applied, or a later block would be silently skipped.
CRON = '-- pg_cron runs it every hour'
body = s[s.index('-- v6 (wheels)'):]
cut = body.index(CRON)
body = body[:cut] + body[body.index('$cron$);', cut) + len('$cron$);'):]
open(f'{w}/v6.sql', 'w').write(body)
EOF

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "set client_min_messages = warning" -f "$WORK/shim.sql" -f "$WORK/base.sql" -f "$WORK/v6.sql" >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f test/schema.test.sql

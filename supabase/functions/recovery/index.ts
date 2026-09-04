// Password recovery without email.
//
// Accounts use synthetic addresses (username@users.quota.local), so Supabase's own
// email reset can never arrive. Instead each account is issued one-time recovery
// codes at signup; presenting one proves ownership well enough to set a new password.
//
// The codes are bound to the account when they are issued. That is the whole security
// property: knowing a username gets you nothing, so nobody can take a name that is
// already in use by "resetting" it.
//
// This runs with the service role key, which is why it lives here and not in index.html.
import { generateCodes, hash } from './codes.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_ATTEMPTS = 5;          // per username and per IP
const WINDOW_MINUTES = 15;
const MIN_PASSWORD = 6;          // matches the minlength on the form in index.html

// Same answer whether the username is unknown or the code is wrong, so this endpoint
// can't be used to test which usernames exist.
const WRONG = 'That username and code do not match. Check the code and try again.';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

const rest = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  // PostgREST answers a write with 201/204 and an empty body unless asked for the row
  // back, and res.json() on an empty body throws. Read text and only parse if there is any.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const since = () => encodeURIComponent(new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString());

// Without this a stolen username could be tried against the whole code space.
async function rateLimited(keys: string[]): Promise<boolean> {
  for (const key of keys) {
    const rows = await rest(`recovery_attempts?key=eq.${encodeURIComponent(key)}&at=gte.${since()}&select=id`);
    if (rows.length >= MAX_ATTEMPTS) return true;
  }
  return false;
}

const recordAttempt = (keys: string[]) =>
  rest('recovery_attempts', { method: 'POST', body: JSON.stringify(keys.map((key) => ({ key }))) }).catch(() => {});

// Issue a fresh set of codes to whoever is signed in, replacing any unused ones.
// Requires a real user token: the anon key is not accepted by /auth/v1/user.
async function issue(req: Request) {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in first.' }, 401);

  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!who.ok) return json({ error: 'Sign in first.' }, 401);
  const { id } = await who.json();
  if (!id) return json({ error: 'Sign in first.' }, 401);

  // Old unused codes stop working the moment a new set is issued, so a set printed
  // and lost on an old phone can't be used later.
  await rest(`recovery_codes?user_id=eq.${id}&used_at=is.null`, { method: 'DELETE' });

  const codes = generateCodes();
  const rows = await Promise.all(codes.map(async (c) => ({ user_id: id, code_hash: await hash(c) })));
  await rest('recovery_codes', { method: 'POST', body: JSON.stringify(rows) });

  // The only time the plaintext exists. Nothing stores it, here or in the database.
  return json({ codes });
}

async function redeem(req: Request, body: Record<string, unknown>) {
  const username = String(body.username ?? '').trim().toLowerCase().replace(/^@/, '');
  const code = String(body.code ?? '');
  const password = String(body.password ?? '');

  if (!username || !code) return json({ error: WRONG }, 400);
  if (password.length < MIN_PASSWORD) return json({ error: `Your new password needs at least ${MIN_PASSWORD} characters.` }, 400);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const keys = [`u:${username}`, `ip:${ip}`];
  if (await rateLimited(keys)) return json({ error: `Too many tries. Wait ${WINDOW_MINUTES} minutes and try again.` }, 429);

  const [profile] = await rest(`profiles?username=eq.${encodeURIComponent(username)}&select=id`);
  // Hash regardless of whether the profile exists, so both paths cost the same.
  const codeHash = await hash(code);
  const matches = profile
    ? await rest(`recovery_codes?user_id=eq.${profile.id}&code_hash=eq.${codeHash}&used_at=is.null&select=id`)
    : [];

  if (!matches.length) {
    await recordAttempt(keys);
    return json({ error: WRONG }, 400);
  }

  // Spend the code before changing the password. If the update below fails the user
  // has to use another code, which is the safe direction to fail in — the alternative
  // leaves a valid code replayable after a partial success.
  await rest(`recovery_codes?id=eq.${matches[0].id}`, {
    method: 'PATCH',
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });

  const updated = await fetch(`${SUPABASE_URL}/auth/v1/admin/user/${profile.id}`, {
    method: 'PUT',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!updated.ok) return json({ error: 'Could not set that password. Try again with another code.' }, 500);

  // ponytail: sessions already signed in elsewhere are not forcibly ended — GoTrue
  // exposes no admin endpoint to revoke them, and "single session per user" is a Pro
  // plan setting. Upgrade path: turn that setting on, or move to short-lived sessions.
  const left = await rest(`recovery_codes?user_id=eq.${profile.id}&used_at=is.null&select=id`);
  return json({ ok: true, remaining: left.length });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === 'issue') return await issue(req);
    if (body.action === 'redeem') return await redeem(req, body);
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
});

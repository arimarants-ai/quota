import { counts, failureKeys, limitsFor, overLimit, type Outcome } from './limits.ts';
// Logging in with a username instead of an email address.
//
// Supabase signs people in by email, so a username has to be turned into one first. The
// obvious way — a database function that hands back the email for a username — would let
// anybody who can guess a name read the address behind it, which is exactly the kind of
// leak a username is supposed to protect against.
//
// So the swap happens here, with the service key, and the address never leaves. What goes
// back is a session or the same refusal in either case: a wrong password and a username
// nobody has look identical from outside, so this cannot be used to find out who exists.
//
// An email address typed into the box is passed straight through. There is nothing to
// look up, and Supabase's own rate limiting applies to the sign-in attempt either way.
//
// The person's own address goes along with the attempt, so Supabase's limits count them
// and not this function. Supabase only acts on it when the project has it switched on and
// the call carries a secret key (SB_SECRET_KEY, an sb_secret_... key); without those it is
// ignored and the limit below still holds.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SECRET_KEY = Deno.env.get('SB_SECRET_KEY') ?? '';

const SLOW = "That's a lot of tries in a row. Wait a few minutes and try again.";
// A refusal never comes back sooner than this, whatever it was refused for.
const FLOOR_MS = 900;
// Asked for when there is nobody to ask about, so a name that does not exist still costs
// a round trip to Supabase. .invalid can never be anybody's address.
const NOBODY = 'nobody@quota.invalid';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

const WRONG = 'Wrong email, username or password';

const admin = async (path: string) => {
  const res = await fetch(`${SUPABASE_URL}/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};

// The service role's view of the failure counters (rate_count, rate_add in the database).
const rpc = async (fn: string, args: Record<string, unknown>) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', body: JSON.stringify(args),
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`${fn} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
};

// The caller's own address, as the platform saw it.
const clientIp = (req: Request) =>
  (req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0]).trim();

async function passwordGrant(email: string, password: string, ip: string) {
  const headers: Record<string, string> = { apikey: SECRET_KEY || ANON_KEY, 'Content-Type': 'application/json' };
  if (ip) { headers['X-Forwarded-For'] = ip; headers['Sb-Forwarded-For'] = ip; }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers, body: JSON.stringify({ email, password }),
  });
  return { res, data: await res.json().catch(() => ({})) };
}

/** The address behind a username, or null. Never returned to the caller. */
async function emailForUsername(username: string): Promise<string | null> {
  const rows = await admin(`rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=id`);
  if (!Array.isArray(rows) || !rows.length) return null;
  const user = await admin(`auth/v1/admin/users/${rows[0].id}`);
  return user?.email ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const started = Date.now();
  // Every refusal takes at least FLOOR_MS, so how long one took says nothing about why.
  const refuse = async (body: unknown, status: number) => {
    const wait = FLOOR_MS - (Date.now() - started);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    return json(body, status);
  };

  let body: { id?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const id = (body.id ?? '').trim();
  const password = body.password ?? '';
  if (!id || !password) return refuse({ error: WRONG }, 400);

  const ip = clientIp(req);
  const limits = limitsFor(id, ip);
  try {
    const seen = await Promise.all(limits.map(l => rpc('rate_count', { p_key: l.key, p_window: l.window })));
    if (overLimit(limits, seen.map(Number))) return refuse({ error: SLOW }, 429);
  } catch { return refuse({ error: 'Could not log in just now. Try again.' }, 503); }

  // How it went decides what is counted: a wrong answer, and nothing else.
  const done = async (o: Outcome, body: unknown, status: number) => {
    if (counts(o)) await rpc('rate_add', { p_keys: failureKeys(limits) }).catch(() => {});
    return refuse(body, status);
  };

  let email: string | null = id.includes('@') ? id : null;
  if (!email) {
    try { email = await emailForUsername(id.toLowerCase()); }
    catch { return done('unavailable', { error: 'Could not log in just now. Try again.' }, 503); }
    // No such username: a password check all the same, against an address nobody has, and
    // answered the same as a wrong password.
    if (!email) {
      await passwordGrant(NOBODY, password, ip).catch(() => {});
      return done('wrong', { error: WRONG }, 400);
    }
  }

  // A real sign-in attempt, subject to the same checks as one typed into the app.
  const { res, data } = await passwordGrant(email, password, ip);
  if (!res.ok) {
    // An unconfirmed address is worth saying out loud, because the fix is in their inbox
    // rather than in the password box.
    const code = String(data?.error_code ?? data?.error ?? '');
    if (/not_confirmed/i.test(code)) return done('unconfirmed', { error: 'Confirm your email first. Check your inbox for the link.', unconfirmed: true }, 400);
    if (res.status === 429) return done('slow', { error: SLOW }, 429);
    return res.status === 400 ? done('wrong', { error: WRONG }, 400) : done('unavailable', { error: 'Could not log in just now. Try again.' }, 503);
  }
  // Only the two tokens go back. The app hands them to supabase-js, which takes it from there.
  return json({ access_token: data.access_token, refresh_token: data.refresh_token });
});

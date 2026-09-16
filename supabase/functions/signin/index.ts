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
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

  let body: { id?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const id = (body.id ?? '').trim();
  const password = body.password ?? '';
  if (!id || !password) return json({ error: WRONG }, 400);

  let email: string | null = id.includes('@') ? id : null;
  if (!email) {
    try { email = await emailForUsername(id.toLowerCase()); }
    catch { return json({ error: 'Could not log in just now. Try again.' }, 503); }
    // No such username. Answered the same as a wrong password, and only after the lookup,
    // so the two do not take visibly different amounts of time either.
    if (!email) return json({ error: WRONG }, 400);
  }

  // The anon key, not the service key: this is a real sign-in attempt and has to be
  // subject to the same rate limiting and the same checks as one typed into the app.
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // An unconfirmed address is worth saying out loud, because the fix is in their inbox
    // rather than in the password box.
    const code = String(data?.error_code ?? data?.error ?? '');
    if (/not_confirmed/i.test(code)) return json({ error: 'Confirm your email first. Check your inbox for the link.', unconfirmed: true }, 400);
    return json({ error: res.status === 400 ? WRONG : 'Could not log in just now. Try again.' }, res.status === 400 ? 400 : 503);
  }
  // Only the two tokens go back. The app hands them to supabase-js, which takes it from there.
  return json({ access_token: data.access_token, refresh_token: data.refresh_token });
});

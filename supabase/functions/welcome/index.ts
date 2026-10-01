// The welcome email, once per account, sent when somebody finishes setting up.
//
// Supabase's own emails are only the codes. This one is Quota's, so it goes through Resend's
// API directly, from hello@ so a reply reaches a person. Whoever calls this is the person
// it is sent to: the address comes from their own session, never from the request.
//
// Once is enforced by profiles.welcomed_at (schema v47). The row is claimed before sending
// with a conditional update, so two calls in the same second send one email, and a send
// that fails hands the claim back so a later call can try again.
//
// Needs one secret on top of the ones every function has: RESEND_API_KEY.
const SUPABASE_URL = typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_URL')! : '';
const SERVICE_KEY = typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! : '';
const RESEND_KEY = typeof Deno !== 'undefined' ? Deno.env.get('RESEND_API_KEY')! : '';
const APP = 'https://app.hitquota.app';
const FROM = 'Quota <hello@hitquota.app>';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// The first name if there is one, since that is how a friend would start it.
export function firstName(name: string | null | undefined): string {
  return String(name || '').trim().split(/\s+/)[0].slice(0, 40);
}

const STEPS: [string, string][] = [
  ['Start a crew.', 'Pick the goal and text the invite to two to five friends.'],
  ['Post proof before midnight.', 'A photo or a few seconds of video. Your streak starts today.'],
  ['Set a forfeit.', 'Miss a day and you owe the crew. Coffee works.'],
];

export function welcomeEmail(name: string | null | undefined) {
  const first = firstName(name);
  const subject = first ? `You're in, ${first}. Here's how day one works` : `You're in. Here's how day one works`;
  const hello = first ? `Welcome to Quota, ${esc(first)}.` : 'Welcome to Quota.';
  const text = [
    first ? `Welcome to Quota, ${first}.` : 'Welcome to Quota.',
    '',
    "One goal a day, with a few friends who'll notice if you skip it.",
    '',
    ...STEPS.map(([a, b], i) => `${i + 1}. ${a} ${b}`),
    '',
    `Open Quota: ${APP}`,
    '',
    'Questions or ideas? Reply to this email and a real person reads it.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e8e9ea;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#0b0c0e">
<tr><td style="padding:28px 28px 0;font-weight:700;font-size:14px;letter-spacing:.12em">QUOTA</td></tr>
<tr><td style="padding:18px 28px 0;font-size:24px;font-weight:700;line-height:1.2">${hello}</td></tr>
<tr><td style="padding:8px 28px 0;font-size:15px;line-height:1.55;color:#3a3a3c">One goal a day, with a few friends who'll notice if you skip it.</td></tr>
<tr><td style="padding:18px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${STEPS.map(([a, b], i) => `<tr><td width="28" valign="top" style="padding:12px 0;border-top:1px solid #eeeeee;font-size:16px;font-weight:700;color:#0b5a34">${i + 1}</td><td style="padding:12px 0;border-top:1px solid #eeeeee;font-size:14px;line-height:1.45"><b>${esc(a)}</b> <span style="color:#6e6e73">${esc(b)}</span></td></tr>`).join('\n')}
</table></td></tr>
<tr><td style="padding:22px 28px 0"><a href="${APP}" style="display:block;background:#0b5a34;color:#ffffff;text-align:center;font-weight:700;font-size:15px;padding:14px;text-decoration:none">Open Quota</a></td></tr>
<tr><td style="padding:22px 28px 28px;font-size:12px;line-height:1.5;color:#8b8f94">Questions or ideas? Reply to this email and a real person reads it.<br>Quota &middot; hitquota.app</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}

// Addresses that cannot receive anything: accounts from before real emails were asked for.
export const undeliverable = (email: string | null | undefined) => !email || /@users\.quota\.local$/i.test(email);

const rest = (path: string, init: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...init,
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
});

if (typeof Deno !== 'undefined') Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: req.headers.get('Authorization') || '' } });
  if (!who.ok) return json({ error: 'not signed in' }, 401);
  const user = await who.json();
  if (undeliverable(user.email)) return json({ sent: false });
  // Only a finished account, and only once.
  const claim = await rest(`profiles?id=eq.${user.id}&welcomed_at=is.null&username=not.is.null&select=username,display_name`,
    { method: 'PATCH', body: JSON.stringify({ welcomed_at: new Date().toISOString() }) });
  const rows = claim.ok ? await claim.json() : [];
  if (!rows.length) return json({ sent: false });
  const { subject, html, text } = welcomeEmail(rows[0].display_name || rows[0].username);
  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [user.email], reply_to: 'hello@hitquota.app', subject, html, text }),
  });
  if (!sent.ok) {
    console.error('Resend refused the welcome email', sent.status, await sent.text());
    await rest(`profiles?id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ welcomed_at: null }) });
    return json({ sent: false }, 502);
  }
  return json({ sent: true });
});

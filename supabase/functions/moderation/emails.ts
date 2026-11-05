// The emails a take-down sends. Pure, so every variant is checked without Deno or Resend.
//
// Four of them: strike 1 (a warning), strike 2 (a final warning), suspended (strike 3, or
// serious), and self-harm, which is not a penalty at all and says so. Every one is from
// "the Quota team": a moderator is never named, and neither is whoever reported it.

export const FROM = 'Quota <safety@hitquota.app>';
export const REPLY_TO = 'safety@hitquota.app';
const GREEN = '#0A7F46';
const LOGO = 'https://app.hitquota.app/icon-192.png';

export const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The first name if there is one, the way a person would start a note to somebody. */
export function firstName(name: string | null | undefined): string {
  return String(name || '').trim().split(/\s+/)[0].slice(0, 40);
}

// Where most of Quota is, for an account that has never told the app its time zone. UTC
// would put a post made on a Tuesday evening in Chicago on Wednesday, which is not the day
// anybody remembers posting it.
export const DEFAULT_TZ = 'America/Chicago';

/** "November 5", on the poster's own calendar: profiles.tz, or Central when it is unknown or unusable. */
export function postedOn(at: string | null | undefined, tz?: string | null): string {
  const d = at ? new Date(at) : null;
  if (!d || isNaN(+d)) return '';
  const fmt = (zone: string) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: zone });
  try { return fmt(String(tz || '').trim() || DEFAULT_TZ); }
  catch { return fmt(DEFAULT_TZ); }
}

export type Takedown = {
  name: string | null | undefined;   // the poster's display name or username
  thing: string;                     // video, photo, story, comment, message, profile
  group?: string | null;
  date?: string;                     // already formatted, e.g. "November 5"
  reason?: string | null;            // the polished reason
  strikeNo?: number | null;
  suspended?: boolean;
  selfHarm?: boolean;
};

export type Email = { subject: string; html: string; text: string };

/** Which email this is. Self-harm first: it is never a strike, whatever else is set. */
export function variant(t: Pick<Takedown, 'selfHarm' | 'suspended' | 'strikeNo'>): 'self_harm' | 'suspended' | 'strike2' | 'strike1' {
  if (t.selfHarm) return 'self_harm';
  if (t.suspended) return 'suspended';
  return (t.strikeNo ?? 1) >= 2 ? 'strike2' : 'strike1';
}

// A block of the email: a paragraph, the grey reason, or the amber strike box.
type Block = { p: string } | { why: string } | { warn: [string, string] };

function render(subject: string, blocks: Block[], signoff: string[]): Email {
  const text = [
    ...blocks.map(b => 'p' in b ? b.p : 'why' in b ? `Why: ${b.why}` : `${b.warn[0]}\n${b.warn[1]}`),
    signoff.join('\n'),
  ].join('\n\n');
  const row = (inner: string, pad = '14px 28px 0') => `<tr><td style="padding:${pad}">${inner}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e8e9ea;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#0b0c0e;font-size:15px;line-height:1.55">
<tr><td style="padding:24px 28px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:10px"><img src="${LOGO}" width="32" height="32" alt="" style="display:block;border-radius:8px;background:${GREEN}"></td>
<td style="font-weight:700;font-size:17px;color:${GREEN}">Quota</td></tr></table></td></tr>
${blocks.map(b => 'p' in b
    ? row(`<p style="margin:0">${esc(b.p)}</p>`)
    : 'why' in b
      ? row(`<div style="background:#f2f3f4;border-radius:10px;padding:14px 16px"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6e6e73;margin-bottom:4px">Why</div>${esc(b.why)}</div>`)
      : row(`<div style="background:#fff7e6;border:1px solid #f5d48a;border-radius:10px;padding:14px 16px"><b style="color:#8a5a00">${esc(b.warn[0])}</b><br><span style="color:#5c4a1f">${esc(b.warn[1])}</span></div>`)).join('\n')}
${row(`<p style="margin:0">${signoff.map(esc).join('<br>')}</p>`, '18px 28px 0')}
<tr><td style="padding:22px 28px 26px;font-size:12px;color:#8b8f94">Quota &middot; hitquota.app</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}

/** The email for a take-down, in whichever of the four shapes it needs. */
export function takedownEmail(t: Takedown): Email {
  const first = firstName(t.name);
  const hi = first ? `Hi ${first},` : 'Hi,';
  const where = t.group ? ` in ${t.group}` : '';
  const when = t.date ? ` on ${t.date}` : '';
  const reason = String(t.reason || '').trim();
  const appeal = "Think we got this wrong? Just reply to this email and we'll take another look.";
  const grind = ['Keep grinding,', 'The Quota team'];
  const v = variant(t);

  if (v === 'self_harm') {
    return render('Checking in from Quota', [
      { p: hi },
      { p: `A ${t.thing} you posted${where} was taken down to keep everyone on Quota safe. This isn't a penalty, and nothing is held against you.` },
      { p: "If you're going through something hard right now, you don't have to handle it alone. In the US or Canada, you can call or text 988 at any time. Elsewhere, findahelpline.com lists free, confidential support near you. If you're in immediate danger, please call your local emergency services." },
    ], ['The Quota team']);
  }

  const blocks: Block[] = [
    { p: hi },
    { p: `A ${t.thing} you posted${where}${when} was reported, and the Quota team took it down.${v === 'suspended' ? ' Your account has been suspended.' : ''}` },
  ];
  if (reason) blocks.push({ why: reason });
  if (v === 'suspended') {
    blocks.push({ p: "While your account is suspended you can still sign in, but you can't post, comment or message." });
    blocks.push({ p: appeal });
    return render('Your Quota account has been suspended', blocks, grind);
  }
  blocks.push({ warn: v === 'strike2'
    ? ['Final warning: strike 2 of 3', 'One more strike within 6 months will suspend your account.']
    : ['This is a warning: strike 1 of 3', 'A second strike is a final warning. A third suspends your account. Strikes clear after 6 months without a new one.'] });
  if (t.thing === 'video' || t.thing === 'photo') {
    blocks.push({ p: `That ${t.thing} no longer counts as proof. If it was today's, you still have until midnight to post again.` });
  }
  blocks.push({ p: appeal });
  return render(`Your Quota ${t.thing} was taken down`, blocks, grind);
}

// Addresses that cannot receive anything: accounts from before real emails were asked for.
export const undeliverable = (email: string | null | undefined) => !email || /@users\.quota\.local$/i.test(email);

// node --experimental-strip-types supabase/functions/moderation/emails.test.ts
import assert from 'node:assert/strict';
import { FROM, REPLY_TO, firstName, postedOn, takedownEmail, variant } from './emails.ts';
import { MODEL, polish, tidy, usable } from './polish.ts';

let n = 0;
const ok = (cond: boolean, msg: string, saw = '') => { if (!cond) throw new Error(`FAIL ${msg}${saw ? `\n  saw: ${saw}` : ''}`); console.log('  ok  ' + msg); n++; };

// Whatever the email, it never names a moderator or the person who reported it. The data
// it is built from has neither, and these words must never be written into it either.
const unesc = (h: string) => h.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const NEVER = /\b(ari|justin|marants|smith|reported by|reporter)\b/i;
const base = { name: 'Sam Lee', thing: 'video', group: 'Mornings', date: 'November 5', reason: 'Your caption included a slur, which is not allowed on Quota.' };

ok(FROM === 'Quota <safety@hitquota.app>' && REPLY_TO === 'safety@hitquota.app', 'from and reply-to are safety@');
ok(firstName('Sam Lee') === 'Sam' && firstName('') === '', 'the first name');
ok(postedOn('2026-11-05T03:00:00Z', 'America/Los_Angeles') === 'November 4', 'the date is the poster\'s own', postedOn('2026-11-05T03:00:00Z', 'America/Los_Angeles'));
// 9:40 PM Central on November 5 is 03:40 on November 6 in UTC. The email says the 5th.
{
  const at = '2026-11-06T03:40:00Z';
  ok(postedOn(at, 'America/Chicago') === 'November 5', 'a post at 9:40 PM Central is dated that day, not the next', postedOn(at, 'America/Chicago'));
  ok(postedOn(at, null) === 'November 5' && postedOn(at, '') === 'November 5', 'no time zone on the account means Central, not UTC', postedOn(at, null));
  ok(postedOn(at, 'Not/AZone') === 'November 5', 'a time zone that is not one falls back to Central', postedOn(at, 'Not/AZone'));
  ok(postedOn(at, 'Europe/London') === 'November 6', 'and somebody in London posting at the same moment is on the 6th');
  const e = takedownEmail({ ...base, date: postedOn(at, null), strikeNo: 1 });
  ok(e.text.includes('in Mornings on November 5 was reported'), 'and that is the date the email says', e.text.split('\n')[2]);
}

// Strike 1
{
  const e = takedownEmail({ ...base, strikeNo: 1 });
  ok(variant({ strikeNo: 1 }) === 'strike1', 'strike 1 is the warning');
  ok(e.subject === 'Your Quota video was taken down', 'strike 1 subject', e.subject);
  for (const m of [e.text, unesc(e.html)]) {
    ok(/Hi Sam,/.test(m), 'says hi by first name');
    ok(m.includes('A video you posted in Mornings on November 5 was reported, and the Quota team took it down.'), 'says what came down, where and when');
    ok(m.includes('Your caption included a slur'), 'carries the polished reason');
    ok(m.includes('This is a warning: strike 1 of 3'), 'the amber box says strike 1 of 3');
    ok(m.includes('A second strike is a final warning. A third suspends your account. Strikes clear after 6 months without a new one.'), 'and what comes next');
    ok(m.includes("That video no longer counts as proof. If it was today's, you still have until midnight to post again."), 'a video no longer counts as proof');
    ok(m.includes("Think we got this wrong? Just reply to this email and we'll take another look."), 'offers a reply to appeal');
    ok(/Keep grinding,/.test(m) && /The Quota team/.test(m), 'signed Keep grinding, The Quota team');
    ok(!NEVER.test(m), 'names no moderator and no reporter', (m.match(NEVER) || [])[0]);
  }
  ok(e.html.includes('#0A7F46') && e.html.includes('icon-192.png'), 'the logo mark in Quota green');
}
// Strike 1 on a comment: no proof line.
{
  const e = takedownEmail({ ...base, thing: 'comment', strikeNo: 1 });
  ok(e.subject === 'Your Quota comment was taken down', 'a comment says comment');
  ok(!/no longer counts as proof/.test(e.text), 'only proof is told it no longer counts');
}
// Strike 2
{
  const e = takedownEmail({ ...base, strikeNo: 2 });
  ok(variant({ strikeNo: 2 }) === 'strike2', 'strike 2 is the final warning');
  ok(e.subject === 'Your Quota video was taken down', 'strike 2 subject');
  ok(e.text.includes('Final warning: strike 2 of 3') && e.text.includes('One more strike within 6 months will suspend your account.'), 'strike 2 box');
  ok(!e.text.includes('strike 1 of 3'), 'and not the first warning');
  ok(!NEVER.test(e.text + e.html), 'names nobody');
}
// Suspended, by strike 3 or by serious
for (const t of [{ strikeNo: 3, suspended: true }, { strikeNo: 1, suspended: true }]) {
  const e = takedownEmail({ ...base, ...t });
  ok(e.subject === 'Your Quota account has been suspended', 'suspended subject');
  ok(e.text.includes('Your caption included a slur'), 'suspended carries the reason');
  ok(/can't post, comment or message/.test(e.text), 'says what suspended means');
  ok(e.text.includes("Just reply to this email and we'll take another look."), 'and how to appeal');
  ok(!/strike \d of 3/.test(e.text), 'no strike box once suspended');
  ok(/Keep grinding,\nThe Quota team/.test(e.text), 'signed off');
  ok(!NEVER.test(e.text + e.html), 'names nobody');
}
// Self-harm: no penalty, crisis resources, no reason box, no strike language.
{
  const e = takedownEmail({ ...base, strikeNo: null, selfHarm: true, suspended: true });
  ok(variant({ selfHarm: true, suspended: true, strikeNo: 3 }) === 'self_harm', 'self-harm wins over everything else');
  ok(e.subject === 'Checking in from Quota', 'self-harm subject');
  ok(/isn't a penalty/.test(e.text) && /nothing is held against you/.test(e.text), 'says it is not a penalty');
  ok(/988/.test(e.text) && /findahelpline\.com/.test(e.text) && /emergency services/.test(e.text), 'gives 988, findahelpline.com and emergency services');
  ok(/don't have to handle it alone/.test(e.text), "says they don't have to handle it alone");
  ok(!/strike|suspend|warning|Why:/i.test(e.text) && !e.html.includes('>Why<'), 'no strike language and no reason box', e.text);
  ok(!/slur/.test(e.text), 'and none of the reason');
  ok(/The Quota team$/.test(e.text) && !/Keep grinding/.test(e.text), 'signed The Quota team');
}
// Somebody's own words land in HTML.
ok(!takedownEmail({ ...base, name: '<b>x</b>', reason: '<script>', strikeNo: 1 }).html.includes('<script>'), 'names and reasons are escaped');

// ---- the polish, and its fallback
ok(tidy('  your caption had   a slur ') === 'Your caption had a slur.', 'tidy trims, capitalises and ends with a full stop');
ok(tidy('Spam!') === 'Spam!', 'tidy leaves an ending alone');
ok(tidy('') === '', 'tidy of nothing is nothing');
ok(!usable('') && usable('Fine.') && !usable('x'.repeat(800)), 'what counts as a usable answer');
ok(MODEL === 'claude-haiku-5-5', 'the model');
{
  const calls: any[] = [];
  const good = (async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Your caption was abusive, which is not allowed on Quota.' }] }), { status: 200 }); }) as typeof fetch;
  const r = await polish('caption was abusive lol', { key: 'k', fetch: good, thing: 'video' });
  ok(r.polished === 'Your caption was abusive, which is not allowed on Quota.' && !r.fallback, 'uses what the model wrote');
  ok(calls[0].model === 'claude-haiku-5-5' && /business-appropriate/.test(calls[0].system) && /Never name or hint at who reported it/.test(calls[0].system), 'with the right model and instructions');
  // No credit, a refusal, a network failure, no key: the note, tidied, every time, quietly.
  const broke = (async () => new Response('{"error":{"type":"billing_error"}}', { status: 400 })) as typeof fetch;
  const down = (async () => { throw new Error('network'); }) as typeof fetch;
  const empty = (async () => new Response(JSON.stringify({ content: [] }), { status: 200 })) as typeof fetch;
  const warn = console.warn; console.warn = () => {};
  for (const [f, what] of [[broke, 'out of credit'], [down, 'offline'], [empty, 'an empty answer']] as const) {
    const x = await polish('caption was abusive', { key: 'k', fetch: f });
    ok(x.polished === 'Caption was abusive.' && x.fallback, `falls back quietly when ${what}`);
  }
  const nokey = await polish('caption was abusive', { fetch: good });
  ok(nokey.polished === 'Caption was abusive.', 'and with no key at all, without calling anything');
  console.warn = warn;
}
console.log(`\nall ${n} moderation email checks passed`);

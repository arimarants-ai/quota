// The moderator's note, rewritten for the person it is about. The moderator types fast and
// the poster reads it once, so this is the step between the two.
//
// It must never get in the way of a decision. Anything wrong — no key, no credit, a
// timeout, an empty answer, something far too long — falls back to the note itself,
// tidied up, and nobody is told: the moderator sees text in the box either way and can
// edit it before it goes.

export const MODEL = 'claude-haiku-5-5';

export const SYSTEM = [
  'You rewrite a content moderator\'s short note into the reason shown to a person whose post on Quota (a group fitness accountability app) was taken down.',
  'Write 1 to 3 sentences addressed to the poster, in the second person ("your caption...").',
  'Use a professional, business-appropriate tone that is kind but firm. Correct spelling and grammar. No slang, no emoji, no sarcasm.',
  'Never name or hint at who reported it. Never invent facts the note does not contain.',
  'Explain briefly why it is not allowed on Quota.',
  'Return only the text of the reason, with no preamble, quotes or sign-off.',
].join('\n');

/** The note with basic cleanup: trimmed, first letter capitalised, ending with a full stop. */
export function tidy(raw: string | null | undefined): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?]["')\]]?$/.test(s)) s += '.';
  return s;
}

/** Whether what came back is usable as a reason. */
export function usable(out: string | null | undefined): boolean {
  const s = String(out ?? '').trim();
  return s.length > 0 && s.length <= 700;
}

export async function polish(raw: string, opts: { key?: string; thing?: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<{ polished: string; fallback: boolean }> {
  const note = String(raw ?? '').trim().slice(0, 1500);
  const fallback = { polished: tidy(note), fallback: true };
  if (!note || !opts.key) return fallback;
  const f = opts.fetch ?? fetch;
  try {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': opts.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 300, system: SYSTEM,
        messages: [{ role: 'user', content: `What was taken down: ${opts.thing || 'a post'}\nModerator's note: ${note}` }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) { console.warn('polish: falling back,', res.status); return fallback; }
    const data = await res.json();
    const out = (data?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('').trim();
    return usable(out) ? { polished: out.replace(/^["“]|["”]$/g, '').trim(), fallback: false } : fallback;
  } catch (e) {
    console.warn('polish: falling back,', String(e));
    return fallback;
  }
}

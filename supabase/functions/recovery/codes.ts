// Recovery code generation and hashing. Pure and network-free so it can be tested
// on its own; index.ts holds everything that talks to Supabase.

// Crockford-style alphabet: no I, L, O, U, 0 or 1, so a code read off a screen and
// typed on a phone can't be ambiguous. 10 chars from 30 symbols is ~49 bits, far
// past brute force once the redeem endpoint is rate limited.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const LENGTH = 10;
export const CODE_COUNT = 8;

export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  // Rejection-free is not worth it here: 256 % 30 skews the last 16 values by ~3%,
  // which costs a fraction of a bit out of 49.
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function generateCodes(n = CODE_COUNT): string[] {
  return Array.from({ length: n }, generateCode);
}

// Accept whatever the user pastes: lower case, missing dash, stray spaces.
export function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Codes are high-entropy random, so a fast hash is the right tool — the slow-hash
// argument applies to low-entropy human passwords, not to 49 bits of randomness.
export async function hash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalize(code)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

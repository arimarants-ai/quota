// node --experimental-strip-types codes.test.ts
import assert from 'node:assert/strict';
import { generateCode, generateCodes, normalize, hash, CODE_COUNT } from './codes.ts';

// Shape: XXXXX-XXXXX, and only from the unambiguous alphabet.
const code = generateCode();
assert.match(code, /^[A-HJ-NP-TV-Z2-9]{5}-[A-HJ-NP-TV-Z2-9]{5}$/, `bad code shape: ${code}`);
assert.equal(generateCodes().length, CODE_COUNT);

// Codes must not repeat. 1000 draws of ~49 bits should never collide.
const many = generateCodes(1000);
assert.equal(new Set(many).size, 1000, 'generated a duplicate code');

// Whatever the user types, it has to reach the same hash as what we issued.
assert.equal(normalize('abcde-fghjk'), 'ABCDEFGHJK');
assert.equal(normalize('  ABCDE FGHJK '), 'ABCDEFGHJK');
assert.equal(await hash('abcde-fghjk'), await hash('ABCDEFGHJK'));

// Different codes must not collide, and the hash must not be the code itself.
assert.notEqual(await hash('ABCDE-FGHJK'), await hash('ABCDE-FGHJM'));
assert.equal((await hash(code)).length, 64);
assert.ok(!(await hash(code)).includes(normalize(code)));

console.log('PASS: recovery codes');

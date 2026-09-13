// node test/bundle.mjs           print the one-file version of the notify function
// node test/bundle.mjs --write   write it to supabase/functions/notify/bundled.ts
//
// The function is three files, which the Supabase CLI handles and the dashboard's editor
// does not always. Pasting one file into the dashboard needs no CLI, no clone and no
// terminal, which is the difference between a deploy happening and not.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'functions', 'notify');
const read = f => readFileSync(join(DIR, f), 'utf8');

// Only the imports between these files go; anything from elsewhere has to stay.
const strip = s => s.split('\n').filter(l => !/^import .*from '\.\/(push|message)\.ts';$/.test(l)).join('\n');

export const bundle = () => [
  `// GENERATED — do not edit. Built from push.ts, message.ts and index.ts by test/bundle.mjs.`,
  `// This is the same function in one file, for pasting into the Supabase dashboard when`,
  `// the CLI is not to hand. Deploying either one gives the same behaviour.`,
  '',
  strip(read('push.ts')).trim(),
  '',
  strip(read('message.ts')).trim(),
  '',
  strip(read('index.ts')).trim(),
  '',
].join('\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = bundle();
  if (process.argv.includes('--write')) {
    writeFileSync(join(DIR, 'bundled.ts'), out);
    console.log(`wrote supabase/functions/notify/bundled.ts (${out.split('\n').length} lines)`);
  } else process.stdout.write(out);
}

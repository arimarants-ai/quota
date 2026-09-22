// node test/bundle.mjs [name]          print the one-file version (default: every function)
// node test/bundle.mjs --write         write each one to its own bundled.ts
//
// A function here is two or three files, which the Supabase CLI handles and the dashboard's
// editor does not. Pasting one file into the dashboard needs no CLI, no clone and no
// terminal, which is the difference between a deploy happening and not.
//
// wheelday is the one that really cannot go in by hand: it imports push.ts out of the
// notify function's directory, and there is no way to express that in the dashboard at all.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FUNCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'functions');

// Only the imports between these files go; anything from elsewhere — Deno, std — has to stay.
export const BUNDLES = {
  notify: {
    files: ['push.ts', 'message.ts', 'index.ts'],
    drop: /^import .*from '\.\/(push|message)\.ts';$/,
  },
  wheelday: {
    files: ['../notify/push.ts', 'message.ts', 'sweep.ts', 'index.ts'],
    drop: /^import .*from '(\.\.\/notify\/push|\.\/message|\.\/sweep)\.ts';$/,
  },
};

export const bundle = name => {
  const {files, drop} = BUNDLES[name];
  const read = f => readFileSync(join(FUNCS, name, f), 'utf8');
  const strip = s => s.split('\n').filter(l => !drop.test(l)).join('\n');
  return [
    `// GENERATED — do not edit. Built from ${files.join(', ')} by test/bundle.mjs.`,
    `// This is the same function in one file, for pasting into the Supabase dashboard when`,
    `// the CLI is not to hand. Deploying either one gives the same behaviour.`,
    '',
    ...files.flatMap(f => [strip(read(f)).trim(), '']),
  ].join('\n');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const only = process.argv.slice(2).find(a => BUNDLES[a]);
  for (const name of only ? [only] : Object.keys(BUNDLES)) {
    const out = bundle(name);
    if (write) {
      writeFileSync(join(FUNCS, name, 'bundled.ts'), out);
      console.log(`wrote supabase/functions/${name}/bundled.ts (${out.split('\n').length} lines)`);
    } else process.stdout.write(out);
  }
}

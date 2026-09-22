// node --experimental-strip-types supabase/functions/wheelday/sweep.test.ts
import assert from 'node:assert/strict';
import { sweepStories, STORY_HOURS, type StoryRow } from './sweep.ts';

let failed = 0;
const ok = (cond: boolean, what: string, detail?: unknown) => {
  console.log(`  ${cond ? 'ok ' : 'NOT OK'} ${what}${cond || detail === undefined ? '' : `  <- ${JSON.stringify(detail)}`}`);
  if (!cond) failed++;
};

// A sweep with everything recorded, so the order and the arguments can both be checked.
function harness(rows: StoryRow[], filesOk = true) {
  const seen: { cutoff?: string; paths?: string[]; ids?: number[]; order: string[] } = { order: [] };
  return {
    seen,
    deps: {
      list: async (cutoff: string, limit: number) => { seen.cutoff = cutoff; seen.order.push('list'); return rows.slice(0, limit); },
      removeFiles: async (paths: string[]) => { seen.paths = paths; seen.order.push('files'); return filesOk; },
      removeRows: async (ids: number[]) => { seen.ids = ids; seen.order.push('rows'); },
      now: () => Date.parse('2026-09-22T12:00:00Z'),
    },
  };
}

{
  const h = harness([{ id: 1, media_path: 'u1/a.mp4' }, { id: 2, media_path: 'u2/b.jpg' }]);
  const out = await sweepStories(h.deps);
  ok(out.rows === 2 && out.files === 2, 'a normal sweep takes both the files and the rows', out);
  ok(h.seen.order.join(' ') === 'list files rows',
    'files go before rows, because the row is the only thing that knows the path', h.seen.order);
  ok(h.seen.cutoff === new Date(Date.parse('2026-09-22T12:00:00Z') - STORY_HOURS * 3600e3).toISOString(),
    'and it asks for everything older than a day', h.seen.cutoff);
}

{
  // The one outcome worse than leaving both alone is deleting the row and stranding the
  // file, which nothing can then find.
  const h = harness([{ id: 1, media_path: 'u1/a.mp4' }], false);
  const out = await sweepStories(h.deps);
  ok(out.held === true && out.rows === 0, 'a bucket that refuses holds the rows back', out);
  ok(!h.seen.order.includes('rows'), '  so no file is ever left with nothing pointing at it', h.seen.order);
}

{
  const h = harness([{ id: 7, media_path: null }, { id: 8, media_path: null }]);
  const out = await sweepStories(h.deps);
  ok(out.rows === 2 && out.files === 0, 'text stories are rows and nothing else', out);
  ok(!h.seen.order.includes('files'), '  and the storage API is not called for them', h.seen.order);
  ok(JSON.stringify(h.seen.ids) === '[7,8]', '  the rows still go', h.seen.ids);
}

{
  const h = harness([{ id: 1, media_path: null }, { id: 2, media_path: 'u2/b.jpg' }]);
  await sweepStories(h.deps);
  ok(JSON.stringify(h.seen.paths) === '["u2/b.jpg"]', 'a mixed batch sends only the paths that exist', h.seen.paths);
  ok(JSON.stringify(h.seen.ids) === '[1,2]', '  and clears every row in it', h.seen.ids);
}

{
  const h = harness([]);
  const out = await sweepStories(h.deps);
  ok(out.rows === 0 && h.seen.order.join(' ') === 'list',
    'nothing expired means nothing is called at all', h.seen.order);
}

if (failed) { console.log(`\nFAIL: ${failed} sweep check(s)`); process.exit(1); }
console.log('all story sweep checks passed');

// Clearing out yesterday's stories.
//
// This was two deletes in a pg_cron job. Supabase now refuses direct deletion from
// storage.objects, and because pg_cron runs a job body as a single transaction the second
// statement's error rolled back the first — so nothing expired at all. It was failing 24
// times out of 24 runs, with ten stories still sitting there when it was found, and
// nothing anywhere said so.
//
// Deleting a file is the storage API's job, so it belongs in the function that already
// runs on this beat and already holds the service key.
//
// Kept apart from index.ts, like message.ts and push.ts, so it can be run and checked
// without a Deno runtime or any of the secrets.

export type StoryRow = { id: number; media_path: string | null };

export type SweepDeps = {
  // Expired rows, oldest first, at most `limit` of them.
  list: (cutoff: string, limit: number) => Promise<StoryRow[]>;
  // Remove these files from the stories bucket. Resolves false if the bucket said no.
  removeFiles: (paths: string[]) => Promise<boolean>;
  // Drop these rows.
  removeRows: (ids: number[]) => Promise<void>;
  now?: () => number;
};

export const STORY_HOURS = 24;
export const SWEEP_MAX = 100;            // an hourly job has no business clearing a year at once

/**
 * Files first, then rows.
 *
 * The row is the only thing that knows where the file is, so deleting it first would
 * strand the file with nothing left pointing at it — which is the one outcome worse than
 * leaving both alone. If the bucket refuses, nothing is deleted and the whole lot comes
 * round again next hour.
 *
 * A text story has no file, so it is only ever a row. A sweep of nothing but text stories
 * must still delete them, and must not call the storage API to do it.
 */
export async function sweepStories(d: SweepDeps) {
  const now = d.now ? d.now() : Date.now();
  const cutoff = new Date(now - STORY_HOURS * 3600e3).toISOString();
  const old = await d.list(cutoff, SWEEP_MAX);
  if (!old.length) return { rows: 0, files: 0, held: false };

  const paths = old.map(s => s.media_path).filter((p): p is string => !!p);
  if (paths.length && !(await d.removeFiles(paths))) {
    // Held rather than half-done: the rows stay, so next hour finds the same files again.
    return { rows: 0, files: 0, held: true };
  }
  await d.removeRows(old.map(s => s.id));
  return { rows: old.length, files: paths.length, held: false };
}

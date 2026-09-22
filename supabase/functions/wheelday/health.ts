// Telling somebody when the machinery itself has stopped.
//
// stories-expire failed 24 times out of 24 runs and nothing said so. That is the whole
// problem with work that happens on a timer: when it stops, nothing happens — which looks
// exactly like nothing needing to happen. No error in the app, nothing in the logs anybody
// reads, no user complaint, because the thing that broke is the thing nobody watches.
//
// So the hourly function that is already running checks whether any of its siblings have
// been failing, and if so pushes once to whoever owns the project. Once a day, not once an
// hour: an alarm that goes off every hour is an alarm that gets silenced.
//
// Kept apart from index.ts, like message.ts and sweep.ts, so it can be run and checked
// without a Deno runtime or any of the secrets.

export type CronFail = { jobname: string; failures: number; last_message: string | null };

// A cron job that runs every ten minutes will rack up a lot of failures, and one that runs
// daily may only have the one. Both matter, so the count is reported rather than used as a
// threshold — anything that failed at all in the last day is worth knowing about.
export function cronAlertBody(rows: CronFail[]): string {
  const real = rows.filter(r => r.failures > 0);
  if (!real.length) return '';
  const worst = real[0];
  const why = (worst.last_message ?? '').split('\n')[0].trim().slice(0, 90);
  const head = real.length === 1
    ? `${worst.jobname} has failed ${worst.failures} ${worst.failures === 1 ? 'time' : 'times'} in the last day.`
    : `${real.length} scheduled jobs are failing — worst is ${worst.jobname}, ${worst.failures} times.`;
  return why ? `${head} ${why}` : head;
}

// Nothing is sent when nothing is wrong, which is the only way the one that does arrive
// means anything.
export const cronAlertDue = (rows: CronFail[]) => rows.some(r => r.failures > 0);

// node --experimental-strip-types supabase/functions/wheelday/health.test.ts
import { cronAlertBody, cronAlertDue, type CronFail } from './health.ts';

let failed = 0;
const ok = (cond: boolean, what: string, detail?: unknown) => {
  console.log(`  ${cond ? 'ok ' : 'NOT OK'} ${what}${cond || detail === undefined ? '' : `  <- ${JSON.stringify(detail)}`}`);
  if (!cond) failed++;
};

const fail = (over: Partial<CronFail> = {}): CronFail =>
  ({ jobname: 'stories-expire', failures: 24, last_message: 'ERROR:  Direct deletion from storage tables is not allowed.', ...over });

{
  const b = cronAlertBody([fail()]);
  ok(/stories-expire/.test(b) && /24 times/.test(b), 'it names the job and how often', b);
  ok(/Direct deletion/.test(b), '  and carries the reason, which is the part you act on', b);
}

{
  // The real case: nothing wrong, so nothing sent. An alarm that goes off when things are
  // fine is an alarm nobody reads when they are not.
  ok(cronAlertDue([]) === false, 'no failures means no alert');
  ok(cronAlertDue([fail({ failures: 0 })]) === false, '  and a job with zero failures is not a failure');
  ok(cronAlertBody([]) === '', '  with nothing to say');
}

{
  ok(/1 time\b/.test(cronAlertBody([fail({ failures: 1 })])), 'one failure is a time, not times');
}

{
  const b = cronAlertBody([fail({ jobname: 'a', failures: 9 }), fail({ jobname: 'b', failures: 2 })]);
  ok(/2 scheduled jobs/.test(b) && /worst is a/.test(b), 'several failing jobs are counted, worst first', b);
}

{
  // A Postgres error can be a paragraph. A lock screen is not.
  const long = cronAlertBody([fail({ last_message: 'ERROR: ' + 'x'.repeat(400) + '\nCONTEXT: more' })]);
  ok(long.length < 200 && !long.includes('CONTEXT'), 'a long error is cut to its first line and trimmed', long.length);
}

{
  const b = cronAlertBody([fail({ last_message: null })]);
  ok(b.length > 0 && !/null|undefined/.test(b), 'a failure with no message still reads as a sentence', b);
}

if (failed) { console.log(`\nFAIL: ${failed} health check(s)`); process.exit(1); }
console.log('all cron health checks passed');

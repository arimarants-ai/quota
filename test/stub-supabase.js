// A stand-in for supabase-js, served in its place by boot.test.mjs so the load path can
// be put into states that are hard to reach on purpose: an expired token, a refresh that
// fails, a session read that never returns. Driven by self.__MODE, set before the page runs.
(function () {
  const M = () => (self.__MODE || {});
  self.__calls = { loads: 0 };
  const err = m => { const e = new Error(m); e.status = /jwt|expired/i.test(m) ? 401 : 500; return e; };
  // Enough of a feed to render a post: one group the user is in, and one post in it.
  const POST = { id: 1, group_id: 1, user_id: 'u1', metric: 'pushups', amount: 50, caption: 'fifty in the bag', video_path: 'p.mp4', day: new Date().toLocaleDateString('en-CA'), created_at: new Date().toISOString() };
  // Sam hit the quota on 3 of the last 4 days; Ari only today. Enough to order a board.
  const ago = n => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA');
  const HISTORY = [1, 2, 3].map((n, i) => ({
    id: 100 + i, group_id: 1, user_id: 'u2', metric: 'pushups', amount: 50, caption: '',
    video_path: `s${i}.mp4`, day: ago(n), created_at: new Date(Date.now() - n * 864e5).toISOString(),
  }));
  // A chain of two wheels, anchored 10 days back on a 5-day cycle, so the group is on
  // cycle 2 and nobody has spun it yet.
  const WHEEL = { id: 7, group_id: 1, name: 'Challenge', every_days: 5, remind_hour: 8,
    breaks_streak: false, active: true, starts_on: ago(10),
    created_by: M().theirWheel ? 'u2' : 'u1' };
  const BORROW_TEXT = "Someone else's challenge";
  const STAGES = [
    { id: 1, wheel_id: 7, seq: 0, kind: 'challenge', label: 'Your challenge',
      segments: M().borrowWheel ? [BORROW_TEXT, BORROW_TEXT] : ['100 burpees', '5k run', 'plank 3 min', 'cold shower'] },
    { id: 2, wheel_id: 7, seq: 1, kind: 'days', label: 'On how many days', segments: ['1', '2', '3'] },
  ];
  // Sam's own spin for the current cycle, when a test needs somebody else's challenge to
  // exist. Off by default: most cases want "Sam: not spun yet".
  const cycleNow = Math.floor((Math.round(Date.now() / 864e5) - Math.round(Date.parse(WHEEL.starts_on) / 864e5)) / WHEEL.every_days);
  self.__spins = M().samSpun ? [{
    id: 90, wheel_id: 7, user_id: 'u2', cycle: cycleNow, sat_out: false, days_required: 2,
    results: [{ seq: 0, kind: 'challenge', label: 'Your challenge', value: '5k run', i: 1, segs: STAGES[0].segments }],
  }] : [];
  self.__ticks = []; self.__posts = [];

  // Two members so the leaderboard has something to rank, and a group old enough for the
  // completion rate to have days to look at.
  const rows = t => ({
    profiles: [{ id: 'u1', username: 'ari', display_name: 'Ari' }, { id: 'u2', username: 'sam', display_name: 'Sam' }],
    groups: [{ id: 1, name: 'Mornings', quotas: [{ metric: 'pushups', target: 50 }], created_at: new Date(Date.now() - 40 * 864e5).toISOString() }],
    group_members: [{ group_id: 1, user_id: 'u1' }, { group_id: 1, user_id: 'u2' }],
    posts: [M().noCaption ? { ...POST, caption: '' } : POST, ...HISTORY, ...self.__posts],
    wheels: M().wheel === false ? [] : [WHEEL],
    wheel_stages: M().wheel === false ? [] : STAGES,
    spins: self.__spins,
    wheel_days: self.__ticks,
  }[t] || []);
  const result = t => {
    const m = M();
    if (t === 'friendships') self.__calls.loads++;         // one per load(): the first query it runs
    return m.queryError ? { data: null, error: err(m.queryError) } : { data: rows(t), error: null };
  };
  // Writes are only tracked where a test needs to see the effect; everything else just
  // resolves the way PostgREST would.
  const chain = (t, st = { filters: {} }) => {
    const run = () => {
      if (st.op === 'delete' && t === 'wheel_days') {
        self.__ticks = self.__ticks.filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      return st.op ? { data: null, error: null } : result(t);
    };
    const p = { then: (res, rej) => Promise.resolve(run()).then(res, rej) };
    for (const k of ['select', 'order', 'limit', 'in', 'upsert', 'update']) p[k] = () => chain(t, st);
    p.eq = (col, val) => chain(t, { ...st, filters: { ...st.filters, [col]: val } });
    p.insert = row => {
      if (t === 'wheel_days') self.__ticks.push({ ...row });
      if (t === 'posts') self.__posts.push({ id: 500 + self.__posts.length, created_at: new Date().toISOString(), caption: '', ...row });
      return chain(t, { ...st, op: 'insert' });
    };
    p.delete = () => chain(t, { ...st, op: 'delete' });
    return p;
  };
  self.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => M().hang ? new Promise(() => {}) : { data: { session: M().session || null }, error: null },
        refreshSession: async () => {
          const m = M();
          if (!m.refreshOk) return { data: { session: null }, error: err('refresh failed') };
          m.queryError = null; m.session = { user: { id: 'u1' } };
          return { data: { session: m.session }, error: null };
        },
        onAuthStateChange: cb => { self.__authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        signOut: async () => ({ error: null }),
      },
      from: t => chain(t),
      // The database picks the slice and writes the row before anything is shown; calling
      // it again returns what is already there rather than rolling again.
      rpc: async (fn, args) => {
        if (fn === 'spin') {
          const cycle = Math.floor((Math.round(Date.parse(args.p_day) / 864e5) - Math.round(Date.parse(WHEEL.starts_on) / 864e5)) / WHEEL.every_days);
          const had = self.__spins.find(sp => sp.wheel_id === args.p_wheel && sp.user_id === 'u1' && sp.cycle === cycle);
          if (had && !had.sat_out) return { data: had, error: null };
          if (had) self.__spins = self.__spins.filter(sp => sp !== had);
          const results = STAGES.map(st => {
            const i = M().pick != null ? M().pick % st.segments.length : Math.floor(Math.random() * st.segments.length);
            return { seq: st.seq, kind: st.kind, label: st.label, value: st.segments[i], i, segs: st.segments };
          });
          const days = results.find(r => r.kind === 'days');
          const sp = { id: self.__spins.length + 1, wheel_id: args.p_wheel, user_id: 'u1', cycle,
            results, days_required: days ? Math.min(+days.value, WHEEL.every_days) : 1, sat_out: false,
            created_at: new Date().toISOString() };
          self.__spins.push(sp);
          return { data: sp, error: null };
        }
        if (fn === 'sit_out') {
          const cycle = Math.floor((Math.round(Date.parse(args.p_day) / 864e5) - Math.round(Date.parse(WHEEL.starts_on) / 864e5)) / WHEEL.every_days);
          const had = self.__spins.find(sp => sp.wheel_id === args.p_wheel && sp.user_id === 'u1' && sp.cycle === cycle);
          if (had) return { data: had, error: null };      // never overwrites a result
          const sp = { id: self.__spins.length + 1, wheel_id: args.p_wheel, user_id: 'u1', cycle,
            results: [], days_required: 0, sat_out: true, created_at: new Date().toISOString() };
          self.__spins.push(sp);
          return { data: sp, error: null };
        }
        if (fn === 'use_challenge') {
          const sp = self.__spins.find(x => x.id === args.p_spin);
          if (sp) sp.challenge_override = args.p_text;
          return { data: sp, error: null };
        }
        if (fn === 'save_wheel') { self.__saved = args; return { data: 1, error: null }; }
        return { data: null, error: null };
      },
      storage: { from: () => ({
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
        // One signed URL per post, in order, the way the page consumes them.
        createSignedUrls: async paths => ({ data: paths.map(() => ({ signedUrl: 'data:video/mp4;base64,' })), error: null }),
      }) },
      functions: { invoke: async () => ({ data: null, error: null }) },
    }),
  };
})();

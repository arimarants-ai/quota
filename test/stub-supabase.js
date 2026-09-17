// A stand-in for supabase-js, served in its place by boot.test.mjs so the load path can
// be put into states that are hard to reach on purpose: an expired token, a refresh that
// fails, a session read that never returns. Driven by self.__MODE, set before the page runs.
(function () {
  const M = () => (self.__MODE || {});
  self.__calls = { loads: 0 };
  const err = m => { const e = new Error(m); e.status = /jwt|expired/i.test(m) ? 401 : 500; return e; };
  // Enough of a feed to render a post: one group the user is in, and one post in it.
  const POST = { id: 1, group_id: 1, user_id: 'u1', metric: 'pushups', amount: 50, caption: 'fifty in the bag', video_path: 'p.mp4', day: new Date().toLocaleDateString('en-CA'), created_at: new Date().toISOString() };
  // Proof is a clip or a picture, and the feed has to tell them apart off the file alone.
  const SHOT = { ...POST, id: 2, caption: 'and a picture', video_path: 'p.jpg' };
  // Sam hit the quota on 3 of the last 4 days; Ari only today. Enough to order a board.
  const ago = n => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA');
  // Long enough to have clips well off the screen, for the cases about what a feed does
  // with the ones nobody is looking at.
  const EXTRA = Array.from({length: M().manyPosts || 0}, (_, i) => ({
    id: 200 + i, group_id: 1, user_id: 'u2', metric: 'pushups', amount: 50, caption: '',
    video_path: `e${i}.mp4`, day: new Date(Date.now() - (i + 5) * 864e5).toLocaleDateString('en-CA'),
    created_at: new Date(Date.now() - (i + 5) * 864e5).toISOString(),
  }));
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
  ].filter(st => !(M().noDayWheel && st.kind === 'days'));
  // Sam's own spin for the current cycle, when a test needs somebody else's challenge to
  // exist. Off by default: most cases want "Sam: not spun yet".
  const cycleNow = Math.floor((Math.round(Date.now() / 864e5) - Math.round(Date.parse(WHEEL.starts_on) / 864e5)) / WHEEL.every_days);
  self.__spins = M().samSpun ? [{
    id: 90, wheel_id: 7, user_id: 'u2', cycle: cycleNow, sat_out: false, days_required: 2,
    results: [{ seq: 0, kind: 'challenge', label: 'Your challenge', value: '5k run', i: 1, segs: STAGES[0].segments }],
  }] : [];
  self.__ticks = []; self.__posts = []; self.__likes = []; self.__cmts = []; self.__reacts = [];
  self.__slikes = []; self.__sreacts = []; self.__edits = []; self.__badges = []; self.__clikes = []; self.__onprofile = {};
  // Stories were only ever pushed into S by hand from a test, which was enough while
  // nothing about one had to survive a round trip. Sharing proof onto a story does: what
  // the card points at is written into the row and read back out of it.
  self.__stories = [];
  // Questioning a post. The database seeds the flagger's own vote and works out when it
  // closes; both are done here too, or the page would be driven against a shape the real
  // thing never produces.
  self.__flags = []; self.__fvotes = [];
  // Talking to each other. Every group has a chat whether anything is in it or not, so
  // these start empty and a test puts what it needs in.
  self.__msgs = []; self.__mreacts = []; self.__reads = [];

  // Two members so the leaderboard has something to rank, and a group old enough for the
  // completion rate to have days to look at.
  const rows = t => ({
    profiles: [{ id: 'u1', username: 'ari', display_name: 'Ari' }, { id: 'u2', username: 'sam', display_name: 'Sam' },
      { id: 'u3', username: 'samwise', display_name: 'Sam Gamgee' }, { id: 'u4', username: 'rosie', display_name: 'Rosie Cotton' }],
    groups: [{ id: 1, name: 'Mornings', quotas: [{ metric: 'pushups', target: 50 }], created_at: new Date(Date.now() - 40 * 864e5).toISOString() }],
    group_members: [{ group_id: 1, user_id: 'u1' }, { group_id: 1, user_id: 'u2' }],
    // on_profile is the one thing about a post that can change after it is posted, so it
    // is read back through whatever the page last set rather than off the fixture.
    posts: [M().noCaption ? { ...POST, caption: '' } : POST, ...(M().photos ? [SHOT] : []), ...HISTORY, ...EXTRA, ...self.__posts]
      .map(p => ({ on_profile: false, ...p, ...(p.id in self.__onprofile ? { on_profile: self.__onprofile[p.id] } : {}) })),
    wheels: M().wheel === false ? [] : [WHEEL],
    wheel_stages: M().wheel === false ? [] : STAGES,
    spins: self.__spins,
    wheel_days: self.__ticks,
    likes: self.__likes,
    reactions: self.__reacts,
    story_likes: self.__slikes,
    story_reactions: self.__sreacts,
    badges: self.__badges,
    comment_likes: self.__clikes,
    comments: self.__cmts,
    stories: self.__stories,
    flags: self.__flags,
    flag_votes: self.__fvotes,
    // A private chat is between friends, and until now nothing needed anybody to have one.
    friendships: M().friends ? [{ a: 'u1', b: 'u2' }] : [],
    messages: self.__msgs,
    message_reactions: self.__mreacts,
    chat_reads: self.__reads,
  }[t] || []);
  // What a real database hands back is not always the shape the page hopes for: a jsonb
  // column can be null, and a row can be missing what a newer column would have had.
  const mangle = r => M().badRows ? {...r, ...('quotas' in r ? {quotas: null} : {}), ...('results' in r ? {results: null} : {})} : r;
  const result = t => {
    const m = M();
    if (t === 'friendships') self.__calls.loads++;         // one per load(): the first query it runs
    // A project where the v27 block has not been run: the tables are simply not there. The
    // app has to draw itself without the feature rather than refuse to draw at all.
    if (m.noFlagTables && (t === 'flags' || t === 'flag_votes')) {
      return { data: null, error: err('relation "public.flags" does not exist') };
    }
    // The same, for a project where the v28 block has not been run.
    if (m.noChatTables && (t === 'messages' || t === 'message_reactions' || t === 'chat_reads')) {
      return { data: null, error: err('relation "public.messages" does not exist') };
    }
    return m.queryError ? { data: null, error: err(m.queryError) } : { data: rows(t).map(mangle), error: null };
  };
  // Writes are only tracked where a test needs to see the effect; everything else just
  // resolves the way PostgREST would.
  // Searching for somebody is a filter the page builds as an or() string; the stub reads
  // it back rather than pretending, so a broken one shows up as no matches.
  const matches = (rows, or) => {
    const m = /username\.ilike\.([^,]*)%,display_name\.ilike\.%([^,]*)%/.exec(or || '');
    if (!m) return [];
    const a = m[1], b = m[2];
    return rows.filter(r => (r.username || '').toLowerCase().startsWith(a)
      || (r.display_name || '').toLowerCase().includes(b));
  };
  const chain = (t, st = { filters: {} }) => {
    const run = () => {
      if (st.op === 'delete' && t === 'wheel_days') {
        self.__ticks = self.__ticks.filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      if (st.op === 'delete' && t === 'reactions') {
        self.__reacts = self.__reacts.filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      if (st.op === 'delete' && (t === 'story_likes' || t === 'story_reactions')) {
        const key = t === 'story_likes' ? '__slikes' : '__sreacts';
        self[key] = self[key].filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      if (st.op === 'delete' && (t === 'messages' || t === 'message_reactions')) {
        const key = t === 'messages' ? '__msgs' : '__mreacts';
        self[key] = self[key].filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      if (st.op === 'delete' && t === 'comment_likes') {
        self.__clikes = self.__clikes.filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      if (st.op === 'delete' && t === 'likes') {
        self.__likes = self.__likes.filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      if (st.op === 'delete' && t === 'comments') {
        self.__cmts = self.__cmts.filter(x => !Object.entries(st.filters).every(([k, v]) => x[k] === v));
      }
      // update().eq() puts the row before the filter, so which post to touch is not known
      // until the query is actually run.
      if (st.op === 'update' && t === 'flag_votes' && st.row) {
        self.__fvotes = self.__fvotes.map(v =>
          Object.entries(st.filters).every(([k, x]) => v[k] === x) ? { ...v, ...st.row } : v);
      }
      if (st.op === 'update' && t === 'posts' && st.row && 'on_profile' in st.row && st.filters.id != null) {
        self.__onprofile[st.filters.id] = st.row.on_profile;
      }
      if (st.or != null) return { data: matches(rows(t), st.or), error: null };
      if (st.op) return { data: null, error: null };
      const out = result(t);
      // A read with eq() on it means it: the profile grid asks for one person's posts that
      // they put on their profile, and a stub that handed back everything would be
      // answering a different question than the app asked.
      if (out.data && Object.keys(st.filters).length) {
        out.data = out.data.filter(r => Object.entries(st.filters).every(([k, v]) => r[k] === v));
      }
      return out;
    };
    // A test can hold a write open (self.__stall) to see what the page shows while it is
    // still in flight, rather than only after the round trip has landed.
    const p = { then: (res, rej) => Promise.resolve(
      self.__stall && st.op === 'insert' ? self.__stall.then(run) : run()).then(res, rej) };
    for (const k of ['select', 'order', 'limit', 'in']) p[k] = () => chain(t, st);
    // upsert is a write, and a read mark is the one thing the page upserts: treated as a
    // passthrough it silently kept every chat unread however many times one was opened.
    p.upsert = row => {
      if (t === 'chat_reads') self.__reads = [...self.__reads.filter(r => r.chat !== row.chat), { ...row }];
      return chain(t, { ...st, op: 'upsert' });
    };

    p.or = expr => chain(t, { ...st, or: expr });
    p.eq = (col, val) => chain(t, { ...st, filters: { ...st.filters, [col]: val } });
    p.update = row => {
      self.__edits.push({ table: t, ...row });
      return chain(t, { ...st, op: 'update', row });
    };
    p.insert = row => {
      if (t === 'invites') self.__invited = { ...row };
      if (t === 'likes') self.__likes.push({ ...row });
      if (t === 'reactions') self.__reacts.push({ ...row });
      if (t === 'comment_likes') self.__clikes.push({ ...row });
      if (t === 'story_likes') self.__slikes.push({ ...row });
      if (t === 'story_reactions') self.__sreacts.push({ ...row });
      // Badges go up as a set, so this is the one write that can arrive as an array.
      if (t === 'badges') for (const r of [].concat(row)) self.__badges.push({ earned_at: new Date().toISOString(), ...r });
      if (t === 'comments') self.__cmts.push({ id: 700 + self.__cmts.length, created_at: new Date().toISOString(), ...row });
      if (t === 'wheel_days') self.__ticks.push({ ...row });
      if (t === 'posts') self.__posts.push({ id: 500 + self.__posts.length, created_at: new Date().toISOString(), caption: '', ...row });
      if (t === 'stories') self.__stories.push({ id: 600 + self.__stories.length, created_at: new Date().toISOString(), body: null, media_path: null, style: {}, ...row });
      if (t === 'flags') {
        const id = 800 + self.__flags.length;
        // Four hours off, standing in for three before the flagged person's midnight, and
        // ignoring whatever the page sent, the same as the trigger does.
        self.__flags.push({ ...row, id, created_at: new Date().toISOString(),
          closes_at: new Date(Date.now() + 4 * 3600e3).toISOString(), outcome: null, closed_at: null });
        self.__fvotes.push({ flag_id: id, user_id: row.by_user, agree: true });   // raising one is a vote
      }
      if (t === 'flag_votes') self.__fvotes.push({ ...row });
      if (t === 'messages') self.__msgs.push({ id: 900 + self.__msgs.length, created_at: new Date().toISOString(),
        group_id: null, a: null, b: null, ...row });
      if (t === 'message_reactions') self.__mreacts.push({ ...row });
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
        // One signed URL per post, in order, the way the page consumes them. A real
        // bucket refuses a path whose file is gone, and hands back a row with no URL on it.
        createSignedUrls: async paths => ({ data: paths.map(() => M().noSign ? { signedUrl: null, error: 'not found' } : { signedUrl: 'data:video/mp4;base64,' }), error: null }),
        // The one-at-a-time version, used to replace a URL that has expired or failed.
        createSignedUrl: async () => { self.__resigned = (self.__resigned || 0) + 1;
          return M().resignFails ? { data: null, error: new Error('nope') }
                                 : { data: { signedUrl: 'data:video/mp4;base64,' }, error: null }; },
      }) },
      functions: { invoke: async () => ({ data: null, error: null }) },
      // Enough of a realtime channel to drive the app with: a test pushes a row through
      // self.__live(table, payload) and everything downstream of it runs for real. With
      // noRealtime the whole thing is missing, which is what a project that has not turned
      // it on in the dashboard looks like.
      channel: M().noRealtime ? undefined : () => {
        const on = [];
        const ch = {
          on: (_kind, opts, cb) => { on.push({ table: opts && opts.table, cb }); return ch; },
          subscribe: cb => { if (cb) cb(M().liveFails ? 'CHANNEL_ERROR' : 'SUBSCRIBED'); return ch; },
        };
        self.__live = (table, payload) => on.filter(h => h.table === table).forEach(h => h.cb(payload));
        self.__liveTables = () => on.map(h => h.table);
        return ch;
      },
      removeChannel: () => { self.__live = null; },
    }),
  };
})();

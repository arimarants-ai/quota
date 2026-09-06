// A stand-in for supabase-js, served in its place by boot.test.mjs so the load path can
// be put into states that are hard to reach on purpose: an expired token, a refresh that
// fails, a session read that never returns. Driven by self.__MODE, set before the page runs.
(function () {
  const M = () => (self.__MODE || {});
  self.__calls = { loads: 0 };
  const err = m => { const e = new Error(m); e.status = /jwt|expired/i.test(m) ? 401 : 500; return e; };
  const rows = t => t === 'profiles' ? [{ id: 'u1', username: 'ari', display_name: 'Ari' }] : [];
  const result = t => {
    const m = M();
    if (t === 'friendships') self.__calls.loads++;         // one per load(): the first query it runs
    return m.queryError ? { data: null, error: err(m.queryError) } : { data: rows(t), error: null };
  };
  const chain = t => {
    const p = { then: (res, rej) => Promise.resolve(result(t)).then(res, rej) };
    for (const k of ['select', 'order', 'limit', 'in', 'eq', 'insert', 'delete', 'upsert', 'update']) p[k] = () => chain(t);
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
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }), createSignedUrls: async () => ({ data: [], error: null }) }) },
      functions: { invoke: async () => ({ data: null, error: null }) },
    }),
  };
})();

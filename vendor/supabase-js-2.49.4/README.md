# Vendored supabase-js

`supabase.js` (and the `591.supabase.js` chunk it can ask for) are the untouched UMD
build from npm `@supabase/supabase-js@2.49.4`, tarball sha1 `5be79f0bf5e6ba9aa5be0775fb0073871834e4d3`.

They used to be loaded from jsdelivr. An installed app that opens on a phone whose
radio has not come up yet gets nothing back from a CDN, and since every line of the
app depends on this file, the page stayed blank with no message. Serving it from our
own origin means the service worker can precache it alongside the page.

To move to a newer version:

    npm pack @supabase/supabase-js@<version>
    tar xzf supabase-js-<version>.tgz package/dist/umd

then copy `package/dist/umd/*` into `vendor/supabase-js-<version>/`, point the
`<script>` in `index.html` at it, update `PRECACHE` and bump `VERSION` in `sw.js`.
Keep the version in the directory name: it is what stops a stale copy being served
from the old cache.

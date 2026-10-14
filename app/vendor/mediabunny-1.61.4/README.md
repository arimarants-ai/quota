# Vendored Mediabunny

What turns a clip into a small H.264 MP4 on the phone before it is posted (see
`convertClip()` in `index.html`). Loaded with `import()` only when something is being
posted, never at start-up, so it costs nothing to anybody who is only watching.

- `mediabunny.min.js` is the untouched ESM bundle from npm `mediabunny@1.61.4`
  (`dist/bundles/mediabunny.min.mjs`, renamed so every host serves it as JavaScript —
  Vercel, the Capacitor shells and the test server all know `.js`), tarball sha1 `faee4a0d25ab3ac63817a14b51c9d0bea2e276d8`.
- `mediabunny-aac-encoder.min.js` is `dist/bundles/mediabunny-aac-encoder.min.mjs` from
  npm `@mediabunny/aac-encoder@1.61.4`, tarball sha1 `b74dd7666e57495f5ce87b89aa90f5db356b66b7`,
  with one change: its two `from"mediabunny"` imports point at `./mediabunny.min.js`,
  because a page with no build step and no import map has nothing to resolve a bare
  `mediabunny` against. It is ffmpeg's AAC encoder in WASM, and only fetched by a browser
  whose WebCodecs cannot encode AAC itself (older Safari).

Both are MPL-2.0; `LICENSE` is theirs.

To move to a newer version:

    npm pack mediabunny@<version> @mediabunny/aac-encoder@<version>

copy the two `.min.mjs` bundles into `vendor/mediabunny-<version>/` as `.min.js`, make the same one-line change
to the encoder (`sed 's#from"mediabunny"#from"./mediabunny.min.js"#g'`), point
`MEDIABUNNY` and `MEDIABUNNY_AAC` in `index.html` at them, and bump `VERSION` in `sw.js`.
Keep the version in the directory name and the two packages on the same version: the
encoder registers itself with whichever Mediabunny it imports, and a second copy of
Mediabunny would be a second registry that the conversion never looks in.

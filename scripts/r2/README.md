# Copying proof to R2

Every clip and picture behind a post used to live in the Supabase bucket `proof`, which is
what kept the project on the Pro plan. New ones go to the Cloudflare R2 bucket `quota-proof`
(see `supabase/functions/media` and schema v50). These two scripts move the old ones across
and say whether it worked. Neither deletes anything in Supabase.

## Once

    cd scripts/r2
    npm ci
    cp .env.example .env      # then fill it in; git ignores .env

You need `ffmpeg` and `ffprobe` on the PATH (`brew install ffmpeg`). The service role key is
under Supabase → Project Settings → API; the R2 key needs Object Read & Write on `quota-proof`.

## Then

    node migrate.mjs --dry-run     # what it would do and roughly what it saves; changes nothing
    node migrate.mjs --limit 5     # five, for real, oldest first
    node verify.mjs                # check those
    node migrate.mjs               # the rest
    node verify.mjs                # the report

Each clip is re-encoded to what the app now sends (H.264 + AAC in an MP4, 720 on its short
side at most, about 1.8 Mbps, AAC 96k, at most 30 fps, index at the front, no metadata), and
goes up under its own name with `.mp4` on the end. A clip ffmpeg cannot handle, or one that
would come out bigger, goes up as the original bytes instead. A clip with no still gets one.
A row is re-pointed (`video_path` to the copy, `video_store = 'r2'`, the old path in
`legacy_video_path`) only once the copy reads back from R2 at the right size.

It can be stopped and run again at any time: rows already on R2 are skipped, and a copy that
is already up is only re-pointed. `state.json` and `logs/` hold what it did. `node
migrate.test.mjs` runs both scripts against a stand-in for Supabase and R2.

## After

Read the report. When every row is on R2 and clips play from it on an iPhone and an Android
phone, the originals in the `proof` bucket can go — by hand, not by these scripts.

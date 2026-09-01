# Quota

Daily goals with friends. Proof or it didn't happen.

One static page (`index.html`) talking straight to Supabase (accounts, database, video storage). Hosted on Vercel.

## One-time setup

1. **Supabase project** — at supabase.com create a project (free tier). Pick a strong database password and save it somewhere.
2. **Run the schema** — in the Supabase dashboard open *SQL Editor*, paste the whole of `schema.sql`, click *Run*. It should finish with no errors.
3. **Turn off email confirmation** — *Authentication → Providers → Email* → switch **Confirm email** off, save. (Accounts use usernames, not real emails.)
4. **Copy the keys** — *Project Settings → API*: copy the **Project URL** and the **anon public** key.
5. **Paste them** into the top of `index.html` (`SUPABASE_URL`, `SUPABASE_KEY`).
6. **Deploy** — push to GitHub (Vercel redeploys automatically) or run `npx vercel --prod`.

Then open the Vercel URL on your phone, *Share → Add to Home Screen*, and it behaves like an app.

## Limits worth knowing (free tiers)

- Videos: 50 MB per file (set in `schema.sql`), 1 GB storage total on Supabase free. Keep clips short.
- No password reset yet. Accounts are username + password only.
- "Today" is whatever the poster's phone says.

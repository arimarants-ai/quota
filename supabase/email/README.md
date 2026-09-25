# The emails Supabase sends

Pasted into *Authentication → Emails → Templates*. Each shows `{{ .Token }}`, the code the
app asks for. The app has nowhere for a link to land, so none of them carry one.

| Template in Supabase | File | Subject |
| --- | --- | --- |
| Confirm signup | `confirm-signup.html` | Your Quota code |
| Reset password | `reset-password.html` | Reset your Quota password |
| Change email address | `change-email.html` | Confirm your email for Quota |

# The emails Supabase sends

Pasted into *Authentication → Emails → Templates*. Each shows `{{ .Token }}`, the code the
app asks for. The app has nowhere for a link to land, so none of them carry one.

| Template in Supabase | File | Subject |
| --- | --- | --- |
| Confirm signup | `confirm-signup.html` | Your Quota code |
| Reset password | `reset-password.html` | Reset your Quota password |
| Change email address | `change-email.html` | Confirm your new email address |

Sender: `Quota <accounts@hitquota.app>` through Resend (SMTP Settings). Codes are 6 digits and
last an hour (*Sign In / Providers → Email*: Email OTP length 6, expiration 3600).

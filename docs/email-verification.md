# Email verification and admin configuration

New Relay registrations require a six-digit email verification code before a session is created. Codes expire after 15 minutes, allow five attempts, and can be resent once per minute. Existing accounts are marked verified by migration 010 and remain able to sign in.

## Gmail SMTP

Create a Gmail App Password (Google Account 2-Step Verification must be enabled) and configure these server environment variables in Vercel:

- `GMAIL_USER`: the Gmail address that sends Relay verification email
- `GMAIL_APP_PASSWORD`: the 16-character Google App Password (not the normal Gmail password)
- `RELAY_EMAIL_FROM` (optional): sender label/address; defaults to `Relay <GMAIL_USER>`

Do not commit these values or put them in client-side variables. Relay sends email through Gmail SMTP using Nodemailer. The health endpoint reports only whether the two required values are present.

## Administrator access

Set `ADMIN_EMAILS` on the server to a comma-separated list of verified Relay account email addresses, for example `owner@example.com`. Those accounts receive the admin-panel route and server-side access to the overview and account-list endpoints.

The initial panel is read-only. User-contact actions are deliberately not exposed until the desired admin-to-user workflow is specified.

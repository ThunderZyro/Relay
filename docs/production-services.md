# Relay production service setup

Relay's application code is ready to use external storage and email delivery, but the production deployment must receive real provider credentials before those capabilities can be enabled. Never put credentials in source control.

## Persistent attachment storage

Configure these variables in the Vercel project's **Production** environment:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_ENDPOINT_URL_S3`
- `AWS_REGION`
- `RELAY_UPLOAD_BUCKET` (optional; defaults to `relay-uploads`)

Use an S3-compatible object-storage bucket with private access. The access key needs permission to upload, read, and delete objects in that bucket. After saving the variables, redeploy and check `/api/health`. The response should report `persistentStorage: true` and `storageMode: "s3"`.

Do not point Preview at the production bucket. Give Preview its own bucket and credentials if upload testing is required.

## Password recovery email

Configure:

- `RESEND_API_KEY`
- `RELAY_EMAIL_FROM`

The sender address must be verified with the email provider. After redeploying, check `/api/health` for `passwordRecoveryConfigured: true`, then test both requesting and completing a password reset.

## Voice connectivity

Relay uses WebRTC. STUN-only connectivity does not work on every network. A TURN service can be configured with `RELAY_ICE_SERVERS` as a JSON array, for example:

```json
[
  {
    "urls": ["turn:turn.example.com:3478"],
    "username": "PROVIDER_USERNAME",
    "credential": "PROVIDER_CREDENTIAL"
  }
]
```

Replace the example host and placeholder credentials with values from a TURN provider. Keep secrets in Vercel environment variables, not in Git.

## Safe deployment sequence

1. Configure Production variables only after creating the matching provider resources.
2. Configure separate Preview values and a separate Preview database.
3. Redeploy the cleanup branch as Preview and test uploads, reset emails, and voice connectivity.
4. Do not merge to the production branch until the Preview checks pass.

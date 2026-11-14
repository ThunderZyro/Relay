# Relay production integrations

## Persistent uploads

Production uploads use the private Neon Object Storage bucket `relay-uploads`. The Vercel production environment must contain:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_ENDPOINT_URL_S3`
- `AWS_REGION`
- `RELAY_UPLOAD_BUCKET`

The server falls back to local disk storage for development when the S3 variables are absent. Do not expose the S3 credentials to the browser.

## Password recovery

Configure Resend and a verified sender domain:

- `RESEND_API_KEY`
- `RELAY_EMAIL_FROM` (for example, `Relay <no-reply@example.com>`)

Reset links expire after 30 minutes, are single-use, and revoke existing sessions after a successful password change. The application origin must be configured in `CLIENT_ORIGIN`.

## Voice relay (TURN)

Set `RELAY_ICE_SERVERS` to a JSON array of WebRTC ICE server objects. Keep TURN credentials server-side and use short-lived credentials from your TURN provider where possible.

Example shape (replace all placeholder values with credentials from your provider):

```json
[
  { "urls": ["stun:stun.example.net:3478"] },
  {
    "urls": ["turn:turn.example.net:3478", "turns:turn.example.net:5349"],
    "username": "temporary-username",
    "credential": "temporary-password"
  }
]
```

The API returns ICE settings only to authenticated users. Without this setting, Relay continues to use the public Google STUN server; that does not provide TURN relay fallback.

## Deployment

After changing environment variables, redeploy the production deployment so the running server receives them. Never commit real credentials to this repository.

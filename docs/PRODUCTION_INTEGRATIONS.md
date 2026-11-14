# Relay production integrations

## Required database

Relay's web and desktop clients share one backend and one PostgreSQL database. Configure:

- `DATABASE_URL` — PostgreSQL connection string (Neon is supported)
- `SESSION_SECRET` — private random value of at least 32 characters
- `CLIENT_ORIGIN` — canonical browser origin
- `ALLOWED_ORIGINS` — optional comma-separated additional browser origins
- `RELAY_REALTIME_DATABASE_URL` — optional direct PostgreSQL connection for Socket.IO cross-instance messaging. When this is absent, Relay converts a Neon pooled hostname (the one containing `-pooler`) to its direct endpoint. For non-Neon providers, supply a direct connection that supports `LISTEN/NOTIFY`.

Migrations run at server startup. Use a separate database for preview and test deployments. Never point a test workflow at production data.

## Persistent uploads

Set the S3-compatible storage variables on the backend:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_ENDPOINT_URL_S3`
- `AWS_REGION`
- `RELAY_UPLOAD_BUCKET`

The object store should be private. Credentials must never be exposed to the browser or committed to Git. Without these settings, development uses local disk; that is not suitable for ephemeral production instances.

## Password recovery

Configure a Resend account and verified sender domain:

- `RESEND_API_KEY`
- `RELAY_EMAIL_FROM` (for example, `Relay <no-reply@example.com>`)

Reset links expire after 30 minutes, are single-use, and revoke existing sessions on successful password change. Password recovery reports that it is not configured until both values are present.

## WebRTC voice relay

Set `RELAY_ICE_SERVERS` to a JSON array of WebRTC ICE server objects. Prefer short-lived TURN credentials from your provider.

Example shape (replace every placeholder with credentials from your provider):

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

The API returns ICE settings only to authenticated users. Without TURN, Relay uses the public Google STUN server; STUN does not provide relay fallback through every restrictive network.

## Hosted server lifecycle

Vercel serverless WebSocket connections are not permanent. Relay uses the PostgreSQL Socket.IO adapter so room broadcasts, socket management, and WebRTC signaling work across separate Vercel function instances. This adapter uses PostgreSQL `LISTEN/NOTIFY`, so it connects directly to Neon rather than through PgBouncer transaction pooling. The `socket_io_attachments` table is created by migration 006.

Vercel clients use WebSocket-only transport (no long-polling handshake), and Relay rotates hosted sockets before the function duration limit. Clients reconnect, rejoin their rooms, and refresh recent history to cover brief disconnects. The active chat keeps a lower-frequency history sync as a recovery fallback.

The adapter does not provide Socket.IO connection-state recovery; message history and room rejoin are Relay's recovery path.

## Deployment

For a container host, use the repository Dockerfile and set the required PostgreSQL/session/origin variables in the host's secret manager. For Vercel, keep server runtime variables in the project environment, with a separate PostgreSQL database for Preview. After changing environment variables, redeploy so the running service receives them.

Never commit real credentials to this repository.

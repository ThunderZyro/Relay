# Relay

Relay brings direct messages, group chats, and community servers together in one shared online space.

## How Relay is built

- **Web client:** React, TypeScript, and Vite.
- **API:** Express and Socket.IO.
- **Database:** PostgreSQL (Neon is supported and used by the hosted deployment).
- **File storage:** local disk for development, or private S3-compatible storage for hosted deployments.
- **Desktop:** Electron wrapper that opens the same hosted Relay service as the website. Desktop and web users share accounts, messages, servers, and uploads.

Relay requires a PostgreSQL database. The old local SQLite desktop setup has been retired.

## Run Relay locally

You need Node.js 22 or newer, npm 10 or newer, and access to a PostgreSQL database.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set:
   - `DATABASE_URL`: your PostgreSQL connection string.
   - `SESSION_SECRET`: a private random string of at least 32 characters.
   - `CLIENT_ORIGIN=http://localhost:5173`.

   Never commit your real `.env` file or share its secrets.

3. Start the API and web client:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:5173](http://localhost:5173).

The database migrations run automatically when the API starts. The first run also seeds the public Welcome to Relay sample server.

## Build and test

```bash
npm run build
npm test
```

The PostgreSQL integration test uses a disposable test database. Enable it with `RELAY_RUN_DB_TESTS=true` and a test-only `DATABASE_URL`. The GitHub Actions PostgreSQL workflow starts its own temporary PostgreSQL service, runs the API integration test, and builds both projects.

## Hosted deployment

Configure these server-side environment variables:

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Session signing key (at least 32 characters) |
| `CLIENT_ORIGIN` | Yes | Main trusted web origin |
| `ALLOWED_ORIGINS` | Optional | Comma-separated additional trusted web origins |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Optional | Private object storage credentials |
| `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `RELAY_UPLOAD_BUCKET` | Optional | S3-compatible upload bucket |
| `RESEND_API_KEY`, `RELAY_EMAIL_FROM` | Optional | Password reset email delivery |
| `RELAY_ICE_SERVERS` | Optional | JSON array of WebRTC ICE/TURN servers |

For local or self-hosted deployments, use the included Dockerfile. Set `DATABASE_URL` and the required secrets in the hosting provider's environment-variable settings. Do not put production credentials into the Docker image or source control.

Password recovery returns a clear configuration status until both Resend variables are configured. The public `/api/health` endpoint reports `status: degraded` in production when persistent S3-compatible storage is unavailable, lists missing storage variable names (never their values), and reports whether password recovery is configured. Production uploads are rejected with HTTP 503 rather than written to temporary serverless disk. Voice uses public STUN when no TURN configuration is supplied; STUN alone cannot relay media through every restrictive network.

## Realtime behavior

Relay uses Socket.IO for typing, messages, notifications, and voice signaling. Hosted serverless instances may recycle connections, so clients reconnect, rejoin their rooms, and refresh recent messages. The active conversation also periodically syncs the latest messages, protecting against events delivered to a different serverless instance.

For a large multi-instance deployment, use a shared Socket.IO adapter/message broker and centralized presence/notification fan-out rather than relying on process-local rooms alone.

## Desktop app

Relay Desktop is a lightweight Electron window around the same hosted Relay website. It does not create a separate local database or local social network. See [README-DESKTOP.md](README-DESKTOP.md).

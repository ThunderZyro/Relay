# Relay

[![PostgreSQL integration](https://github.com/ThunderZyro/Relay/actions/workflows/postgres-integration.yml/badge.svg?branch=main)](https://github.com/ThunderZyro/Relay/actions/workflows/postgres-integration.yml)
[![CodeQL](https://github.com/ThunderZyro/Relay/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/ThunderZyro/Relay/actions/workflows/codeql.yml)

**Relay brings direct messages, group conversations, and communities together in one shared space.**

[Open Relay](https://relay-platform-livid.vercel.app) · [Desktop app guide](README-DESKTOP.md) · [Latest desktop release](https://github.com/ThunderZyro/Relay/releases/latest)

Relay is an independent messaging and community platform with a React web client, a PostgreSQL-backed API, realtime messaging, and a Windows desktop wrapper. The project is under active development.

## What it includes

- **Accounts and profiles:** registration, sign-in, profile settings, presence, privacy controls, and session management.
- **Messaging:** direct messages, group conversations, message history, replies, reactions, pins, and search.
- **Communities:** discoverable servers, channels, roles and permissions, invitations, member moderation, and events.
- **Realtime features:** Socket.IO updates, typing indicators, notifications, and voice-channel signaling with configurable WebRTC ICE/TURN servers.
- **Files:** staged attachments, per-file and per-user upload limits, and private S3-compatible storage for hosted deployments.
- **Desktop:** a lightweight Electron app that opens the same hosted Relay service as the web client.

> **Privacy note:** Relay stores message data on its backend. This repository does not implement end-to-end encryption, so do not treat Relay messages as end-to-end encrypted.

## Technology

| Area | Technology |
|---|---|
| Web client | React 18, TypeScript, Vite |
| API | Node.js 22+, Express |
| Realtime | Socket.IO and the PostgreSQL Socket.IO adapter |
| Database | PostgreSQL |
| Hosted database option | Neon |
| File storage | Local disk for development; private S3-compatible object storage for production |
| Desktop | Electron and electron-builder |
| Validation and security | Zod, Helmet, CORS allowlist, HTTP-only sessions, bcrypt |

The web client and API are npm workspaces: `client/` and `server/`.

## Run Relay locally

### Requirements

- Node.js **22 or newer**
- npm **10 or newer**
- A PostgreSQL database you can use for development

### Setup

1. Clone the repository and enter it:

   ```bash
   git clone https://github.com/ThunderZyro/Relay.git
   cd Relay
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

   The workspace manifests currently contain dependencies that are not yet recorded in the checked-in lockfile, so use `npm install` until the lockfile is regenerated and committed.

3. Copy the example environment file.

   macOS/Linux:

   ```bash
   cp .env.example .env
   ```

   Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Edit `.env` and set at least:

   - `DATABASE_URL` — your development PostgreSQL connection string.
   - `SESSION_SECRET` — a private random value with at least 32 characters.
   - `CLIENT_ORIGIN=http://localhost:5173`.

   Replace the example session secret. Never commit `.env`, paste credentials into issues, or put production credentials in a local test environment.

5. Start the API and web client:

   ```bash
   npm run dev
   ```

6. Open [http://localhost:5173](http://localhost:5173).

Relay applies its database migrations when the API starts and creates a labelled sample **Welcome to Relay** community when it is missing.

## Build and test

Run both TypeScript/Vite builds:

```bash
npm run build
```

Run the server tests:

```bash
npm test
```

The PostgreSQL integration test is opt-in locally. Use a **disposable test database**, then set `RELAY_RUN_DB_TESTS=true` before running the server test suite. The GitHub Actions integration workflow provisions its own temporary PostgreSQL service; it must never use production data.

## Desktop app

Relay Desktop is a Windows x64 Electron shell for the same hosted Relay account and conversations. It does not bundle a second database or local Relay server.

Build the installer on Windows x64:

```bash
npm run desktop:build:win
```

The GitHub Actions desktop workflow also builds and publishes releases for matching `v*` tags. See [README-DESKTOP.md](README-DESKTOP.md) for the complete guide.

## Environment variables

Set server-side values in your hosting provider's secret/environment settings. Do not add real values to source control or Docker images.

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes in production | Session-signing secret, at least 32 characters |
| `CLIENT_ORIGIN` | Yes | Canonical trusted browser origin |
| `ALLOWED_ORIGINS` | No | Comma-separated additional trusted origins |
| `DATABASE_URL_PREVIEW` | No | Separate database URL used for Vercel Preview |
| `RELAY_REALTIME_DATABASE_URL` | No | Direct PostgreSQL URL for cross-instance Socket.IO messaging |
| `UPLOAD_DIR` | No | Local development upload directory |
| `MAX_UPLOAD_MB` | No | Maximum size of one uploaded file |
| `MAX_USER_STORAGE_MB` | No | Per-user staged and stored upload quota |
| `STAGED_UPLOAD_TTL_HOURS` | No | Lifetime for unattached staged uploads |
| `AWS_ACCESS_KEY_ID` | Production uploads | S3-compatible storage access key |
| `AWS_SECRET_ACCESS_KEY` | Production uploads | S3-compatible storage secret |
| `AWS_ENDPOINT_URL_S3` | Production uploads | S3-compatible endpoint |
| `AWS_REGION` | Production uploads | Object-storage region |
| `RELAY_UPLOAD_BUCKET` | No | Upload bucket name |
| `RESEND_API_KEY` | Password recovery | Resend API key |
| `RELAY_EMAIL_FROM` | Password recovery | Verified sender address |
| `RELAY_ICE_SERVERS` | Voice relay | JSON array of WebRTC STUN/TURN server objects |

For local development, Relay can store uploads on disk. Hosted production instances need persistent S3-compatible storage; when it is not configured, the health endpoint reports degraded storage and uploads are rejected rather than written to temporary serverless disk. Password recovery is available only when both Resend settings are configured.

More deployment details are in [docs/PRODUCTION_INTEGRATIONS.md](docs/PRODUCTION_INTEGRATIONS.md).

## Repository map

```text
client/                   React + TypeScript web application
server/                   Express API, PostgreSQL access, migrations, tests
shared/                   Types shared by the client and server
desktop/                  Electron desktop shell and installer config
docs/                     Architecture and deployment documentation
scripts/                  Desktop build helper scripts
.github/workflows/        CI, CodeQL, and desktop release workflows
README-DESKTOP.md         Windows desktop build and release guide
```

See [docs/REPOSITORY_GUIDE.md](docs/REPOSITORY_GUIDE.md) for where to make changes and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## Security and responsible use

- Keep all database, session, object-storage, email, and TURN credentials in environment variables or a secret manager.
- Use a separate PostgreSQL database for local development, tests, and previews.
- Keep object storage private and use short-lived TURN credentials where supported.
- Do not publish security vulnerabilities in public issue reports. See [SECURITY.md](SECURITY.md).
- The repository includes CodeQL analysis and Dependabot update configuration.

## License

There is currently no `LICENSE` file in this repository. Until the project owner adds one, do not assume the code is licensed for reuse, redistribution, or commercial use.

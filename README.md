# Relay

Relay is an original community and messaging application with servers, channels, direct messages, friends, profiles, events, notifications, moderation settings, and a dark-first interface. It is not affiliated with Discord.

This is the merged Relay workspace built from all three supplied archives. `relay-platform.zip` provides the established React client, Express API, Socket.IO messaging/realtime layer, SQLite schema, and migrations. `relay-platform-rebuilt.zip` contributes the npm workspace/build setup, Node 22 TypeScript configuration, Docker/Railway deployment scaffolding, cross-site production-cookie handling, and expanded two-account API integration coverage. `relay-platform-fix.zip` contributes cross-tab authentication refresh, friend-request UI clarity, and the restrained Relay theme defaults. The merged app keeps one client, one API, one SQLite migration chain, and one session model.

## Windows quick start (after the one-time install)

After running `npm install` once in this project folder, double-click **Start Relay.bat** to launch the API and frontend together. Keep its terminal window open while using Relay. Open http://localhost:5173. You do not need to run `npm install` for every launch or source-only update; run it again only when dependencies change (for example, when `package.json` or the lockfile changes).

## Windows desktop installer

A standalone Windows desktop installer (bundled local website, API, SQLite dependencies, and private Node runtime) can be built using the steps in [README-DESKTOP.md](README-DESKTOP.md). End users do not need Node.js or npm. Automatic desktop updates require publishing versioned NSIS releases to the configured GitHub Releases repository.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Run locally on Windows

Open PowerShell in the extracted `relay-platform` folder:

```powershell
npm install
Copy-Item .env.example .env
```

Generate a random session secret and put it in `.env`:

```powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 48
$rng.GetBytes($bytes)
$secret = ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()
(Get-Content .env) -replace '^SESSION_SECRET=.*$', "SESSION_SECRET=$secret" | Set-Content .env
Remove-Variable rng, bytes, secret
```

Then start both development servers:

```powershell
npm run dev
```

Open http://localhost:5173. The API listens on http://localhost:3001. SQLite is created at `server/data/relay.sqlite` and local uploads are written to `uploads/`. The server workspace loads the repository-root `.env` file automatically.

For a production build:

```powershell
npm run build
npm start
```

## Deployment

The app uses a React/Vite frontend and an Express/Socket.IO backend with SQLite and local file uploads. Do not deploy the whole app as a Vercel-only project: Vercel's serverless filesystem is not a persistent home for this SQLite database or uploads, and a long-running Socket.IO server belongs on a persistent backend host.

### 1. Backend on Railway

1. Push this entire project to a GitHub repository. Do not upload `node_modules`, `.env`, `server/data`, or private uploads.
2. In Railway, create a new project from that GitHub repository. The included `Dockerfile` builds and starts the Express server.
3. Add a persistent volume mounted at `/data`. Add a second persistent volume mounted at `/uploads` if uploaded files need to survive redeployments.
4. Set these Railway variables:

   - `NODE_ENV=production`
   - `CLIENT_ORIGIN=https://YOUR-VERCEL-DOMAIN.vercel.app`
   - `SESSION_SECRET=` a random value of at least 32 characters
   - `DATABASE_FILE=/data/relay.sqlite`
   - `UPLOAD_DIR=/uploads`
   - `MAX_UPLOAD_MB=10`

5. Deploy and confirm that `https://YOUR-RAILWAY-DOMAIN/api/health` returns JSON with `status: "ok"`.

### 2. Frontend on Vercel

1. Import the same GitHub repository into Vercel.
2. Vercel should use the root `vercel.json`. The build command is `npm run build:client` and the output directory is `client/dist`.
3. Add the environment variable `VITE_API_URL=https://YOUR-RAILWAY-DOMAIN/api`.
4. Deploy the frontend.
5. Update Railway's `CLIENT_ORIGIN` to the exact final Vercel URL, then redeploy the backend if needed.

The backend uses secure cross-site cookies in production. For the most reliable browser session behavior, use a custom domain arrangement where the frontend and API are same-site (for example, `relay.example.com` and `api.example.com`). Some browsers or privacy settings block third-party cookies even when they are marked `SameSite=None`.

### 3. Persistent data warning

SQLite and local uploads must live on persistent mounted volumes. Without those volumes, the database or files can disappear when the backend container is replaced. Back up `/data/relay.sqlite` and `/uploads` regularly.

## Features and limits

- Registration, login, logout, persistent HttpOnly sessions, and bcrypt password hashing.
- Servers, channels, membership, roles, permissions, invites, and moderation routes.
- Friend requests with sender/recipient direction, blocks, one-to-one/group DMs, and consistent DM membership/block checks for messages, attachments, and typing events.
- Persistent channel and DM messages, edit/delete, reactions, pins, search, and staged uploads.
- Account/profile/settings, notifications, events, and RSVP routes.
- Socket.IO message updates, typing indicators, notifications, presence state, and voice signaling. DM typing and attachment access are revalidated against block state. Voice channels establish browser-to-browser audio with WebRTC and a public STUN server; networks requiring TURN relay may fail. Video and screen sharing are not implemented.
- Password-reset email, payment processing, third-party OAuth, browser push while the app is closed, video/screen sharing, and production TURN infrastructure are not configured.

## Tests

```powershell
npm test
```

The API integration test starts the server against a temporary SQLite database and exercises registration, invites, requester/recipient friend-request direction and acceptance using two independent session cookies, DMs, channel messages, access controls, blocking, and persistence across a server restart. Run it after installing dependencies.

## Security and operations

- Never commit `.env` or production secrets.
- Use a strong unique `SESSION_SECRET` in production.
- Set `CLIENT_ORIGIN` to the exact trusted frontend origin.
- Keep SQLite and uploads on persistent volumes, and configure backups.
- Add monitoring, rate-limit tuning, abuse reporting review, and TURN infrastructure before treating this as a public production service.

## Windows local launch (avoid repeated downloads)

1. Run `Install Dependencies.bat` once in this project folder.
2. After that, use `Start Relay.bat` for normal launches. It never runs `npm install`.
3. For source updates, extract/overwrite the new source into this same folder. Do not delete `node_modules`, `.env`, or the server's data/uploads folders.
4. Only run `Install Dependencies.bat` again if you intentionally change dependencies or the launcher reports that required packages are missing.

The project ZIP intentionally does not include `node_modules`; keeping the existing folder is what avoids downloading the same dependency set again.

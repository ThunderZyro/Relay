# Relay Desktop

Relay Desktop packages the **same React website client** used by Relay in a native desktop window. It does not create a separate account system, database, messaging service or upload store. The desktop client connects to the same Relay API and Socket.IO endpoint as the website, so desktop, browser and mobile users share conversations and communities.

## Build installers

Run these commands from the repository root:

```bash
npm install --workspaces --include-workspace-root=false
npm run test
npm run build:client
npm --prefix desktop install
npm --prefix desktop run dist:win
npm --prefix desktop run dist:mac
npm --prefix desktop run dist:linux
```

Outputs are written to `desktop/dist/`:

- Windows: NSIS installer and portable `.exe`
- macOS: `.dmg` and `.zip`
- Linux: `.AppImage` and `.deb`

GitHub Actions also builds all three operating-system targets. Open **Actions → Relay Desktop builds → Run workflow** to create downloadable build artifacts.

## Connect to another Relay server

The default API is the Relay production service. To connect this desktop client to a different Relay installation, set `RELAY_API_ORIGIN` before launching, or use the command-line argument `--relay-api-origin=https://your-relay.example`.

PowerShell:

```powershell
$env:RELAY_API_ORIGIN = "https://your-relay.example"
.Relay.exe
```

macOS / Linux:

```bash
RELAY_API_ORIGIN=https://your-relay.example ./Relay
```

Remote servers must use HTTPS. Plain HTTP is accepted only for localhost development.

The server must allow the desktop app origin `relay://app`. The Relay backend includes that exact origin in its CORS and Socket.IO origin checks; it does not enable wildcard origins.

## Important

- An internet connection is required. Messages, accounts, presence, voice signalling and uploads remain server-backed.
- Mobile users can continue using the website or installing its PWA. They connect to the same backend.
- macOS builds are not code-signed or notarized by the default workflow. A release intended for broad distribution should be signed with the project's Apple Developer credentials.
- Windows code signing can also be added before public distribution to reduce SmartScreen warnings.

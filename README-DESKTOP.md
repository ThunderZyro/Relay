# Relay Desktop

Relay Desktop is an installable Windows application for the same shared Relay service used by the website.

## One shared Relay

The desktop app opens the hosted Relay website inside a secure Electron window. It does **not** run its own API or database. This means:

- Sign in with the same account as the website.
- Messages, friends, group chats, servers, and uploads are shared.
- A person using Relay Desktop can talk to someone using Relay in a browser.
- An internet connection is required.

The default service address is:

`https://relay-platform-zyro-d26e.vercel.app`

The URL can be changed for a development build with the `RELAY_APP_URL` environment variable. Packaged releases use HTTPS URLs.

## Build a Windows installer

You need Windows 10/11 x64, Node.js 22 or newer, and npm 10 or newer.

1. Run `Install Dependencies.bat` once (or run `npm install`).
2. Run `npm run build`.
3. Run `BUILD RELAY DESKTOP.bat`, or use:

   ```bash
   npm run desktop:build:win
   ```

4. The installer is created in `release/desktop`.

The installer only contains the Electron shell and its updater. It does not bundle a second Relay server, local database, or a private Node runtime. People installing it do not need Node.js or npm.

## GitHub Actions build

The `Build Relay Desktop` workflow builds on a GitHub-hosted Windows runner. It can be run manually from the Actions tab or triggered by a version tag such as `v1.0.2`. The workflow tests and builds Relay before creating the installer. It publishes the installer, `latest.yml`, and blockmap to the matching GitHub Release.

For each new desktop release:

1. Increase the root `package.json` version.
2. Push the reviewed code.
3. Run the workflow manually or push a matching `v<version>` tag.
4. Check the GitHub Release contains the setup executable and update metadata.

The app uses GitHub Releases for automatic updates. Windows may show a SmartScreen warning until Relay has a trusted code-signing certificate.

## App permissions and data

Relay may request microphone access for voice channels and notification permission for desktop notifications. The app keeps Electron context isolation enabled, disables Node integration in the webpage, and opens external links in the system browser.

The desktop shell stores a small diagnostic log in `%APPDATA%\Relay\relay-desktop.log`. Account data and conversations remain in Relay's hosted database; reinstalling the desktop app does not remove them.

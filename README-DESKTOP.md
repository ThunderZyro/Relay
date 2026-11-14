# Relay Desktop for Windows

Relay Desktop is an Electron desktop shell around the existing Relay web client and Express/Socket.IO server. The installer contains the website build, the local API, SQLite runtime dependencies, and a private copy of Node.js. **People installing Relay do not need Node.js, npm, a terminal, or a separate browser.**

The app starts its API on a random loopback-only port (`127.0.0.1`), opens a desktop window to that local service, and stops the API when the app exits. It does not expose the local API to the LAN. SQLite data, the session secret, logs, and uploaded files live in `%APPDATA%\Relay` and are not overwritten by app upgrades.


## Build on GitHub Actions (no local npm setup required)

You do not need to install the desktop builder or run `npm install` on your own PC to produce the Windows installer. This repository includes `.github/workflows/release-desktop.yml`, which builds the installer on a GitHub-hosted Windows machine.

1. Upload the **contents** of this project folder to a GitHub repository (keep the `.github` folder).
2. Make sure the repository is public so the app's built-in GitHub updater can read published releases.
3. In GitHub, choose **Releases → Draft a new release**, create tag `v1.0.0`, and publish it.
4. Open the repository's **Actions** tab. The `Build Relay Desktop` workflow will install dependencies on GitHub's Windows runner, run the client/server build and tests, package the local Node runtime, and publish `Relay-Setup-1.0.0.exe` plus update metadata to that release.
5. Download the installer from the GitHub release assets. Your users do not need Node.js or npm.

The build happens on GitHub's servers, so the large Electron/build dependency downloads do not use your home internet data. You only download the finished installer. Future releases are built the same way using the next version number and tag. Do not upload `.env`, `node_modules`, database files, or GitHub tokens.

The workflow uses GitHub's automatically provided `GITHUB_TOKEN`; no personal access token needs to be committed or pasted into project files. The repository Actions permission must allow workflow write access to contents/releases.

## What is required, and by whom?

| Person | Requirements |
|---|---|
| You, using the recommended GitHub cloud build | A GitHub repository and browser; no local Node.js/npm setup required |
| You, choosing an optional local build | Windows 10/11 x64, Node.js 22+, npm 10+, internet for one-time build dependencies |
| Someone installing RelaySetup.exe | Windows 10/11 x64 only; no Node.js and no npm |
| Publishing automatic updates | A public GitHub repository for desktop releases |

### Optional local build

The `SETUP DESKTOP BUILDER.bat` script now asks before downloading anything. Choose **N** to use GitHub Actions instead. Choose **Y** only when you deliberately want to install the local Electron/packaging toolchain. The installer users will never run npm.

## Optional local Windows build

1. Extract the project to a normal local folder.
2. Double-click `SETUP DESKTOP BUILDER.bat` and choose **Y** only if you want local builder dependencies.
3. Double-click `BUILD RELAY DESKTOP.bat`.
4. Find `Relay-Setup-<version>.exe` in `release\desktop`.

The build must run on Windows because it copies that machine's Windows Node runtime and Windows-native `better-sqlite3` binary into the installer. The packaging stage copies only production dependency folders into the runtime staging area. It does not install dependencies when the installed app launches.

## Automatic desktop updates

The app uses `electron-updater` with the GitHub Releases provider and the NSIS installer target. It checks shortly after startup, downloads a newer release in the background, and prompts the user to restart to apply it. You can also open **Help → Check for Updates…** at any time, or choose **Help → Open GitHub Releases** to view published versions. NSIS differential packages are enabled to reduce update downloads when the changed files allow it. The updater is configured for `ThunderZyro/Relay`.

### First release (recommended cloud build)

1. Upload the complete project contents to a **public** GitHub repository, including `.github/workflows/release-desktop.yml`.
2. In the GitHub repository, open **Settings → Actions → General → Workflow permissions** and allow read/write access to repository contents.
3. Open **Actions → Build Relay Desktop → Run workflow** and run it on the default branch. The current root `package.json` version (`1.0.0`) is used for the release.
4. Wait for the workflow to finish. The workflow runs the build on a GitHub-hosted Windows machine and publishes `Relay-Setup-<version>.exe`, `latest.yml`, and the blockmap asset to GitHub Releases.
5. Download the installer from the release assets and install it once. This first install puts the correct GitHub Releases feed into the app; older installs built with the previous placeholder publisher settings must be updated manually with this installer before automatic updates can work.

The workflow uses GitHub's built-in `GITHUB_TOKEN`; no personal access token needs to be created, copied, or committed. The repository must be public because installed apps need to download release assets without embedding a private token.

### Publish later updates

1. Change the root `package.json` version (for example, from `1.0.0` to `1.0.1`).
2. Commit and push the changed source to GitHub.
3. Run **Actions → Build Relay Desktop → Run workflow** again, or push a matching version tag such as `v1.0.1`.
4. Confirm the new GitHub Release contains the installer, `latest.yml`, and blockmap. Existing installations check for the new release automatically.

You can also publish locally using `PUBLISH RELAY UPDATE.bat`, but that requires the optional local build toolchain and a release-write token. GitHub Actions is the recommended route because its build downloads happen on GitHub, not over your home internet connection. Never put a GitHub token in source code, `.env`, or a committed file.

For signed production distribution, configure a Windows code-signing certificate with electron-builder's supported `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables. Without signing, Windows may show SmartScreen warnings. Keep the same signing identity for future signed updates.

## Local app data and backup

The installed desktop app stores:

- `%APPDATA%\Relay\data\relay.sqlite` — account, messages, friends, servers, settings, and other local database data.
- `%APPDATA%\Relay\uploads\` — files uploaded to this local Relay instance.
- `%APPDATA%\Relay\session-secret` — persistent random session-signing secret.
- `%APPDATA%\Relay\relay.log` — local API and desktop startup/update log.

Back up the `Relay` folder before moving to another PC or performing manual database recovery. Reinstalling/updating the program does not intentionally erase this folder.

## Important distinction: local desktop, local social network

This build runs the Relay backend locally on the computer where it is installed. Accounts, messages, servers, DMs, uploads, and presence are stored on that computer. **Two different computers will not share the same local database just because both have the app installed.** For multi-user communication between PCs over the internet, you need a centrally hosted Relay API/database (or an explicitly configured LAN server). This is different from the web app's previous hosted-backend arrangement.

## Troubleshooting

- If you see `ENOTCACHED` while running `npm install --offline`, that package is not in the local cache. Do not keep retrying offline; use the GitHub Actions cloud build instead.
- If npm prints `allow-scripts` warnings for esbuild, the root `package.json` explicitly allows esbuild's install script. esbuild requires its install step to select/prepare its platform binary.
- If the installer build reports missing builder tools during a deliberate local build, run `SETUP DESKTOP BUILDER.bat` and choose Y.
- If the app fails at startup, inspect `%APPDATA%\Relay\relay.log`.
- If the installed app reports missing runtime files, rebuild the installer using `BUILD RELAY DESKTOP.bat`; do not copy only `Relay.exe` from the install folder.
- If an update is not detected, confirm that the installed build was configured with the correct GitHub owner/repository and that the GitHub Release has a matching `latest.yml` file.
- Updates keep `%APPDATA%\Relay` intact; avoid deleting that folder if you want to preserve local accounts and messages.

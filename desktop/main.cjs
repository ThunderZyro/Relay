'use strict';

const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

app.setName('Relay');
app.setPath('userData', path.join(app.getPath('appData'), 'Relay'));
app.setAppUserModelId('com.relay.platform');

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();

let mainWindow = null;
let apiProcess = null;
let isQuitting = false;
let logFile = null;
let localOrigin = null;
let updateCheckPromise = null;

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { if (logFile) fs.appendFileSync(logFile, line); } catch { /* logging must not stop the app */ }
}

function showFatal(title, message) {
  writeLog(`${title}: ${message}`);
  dialog.showMessageBox({ type: 'error', title, message, buttons: ['Close'] }).finally(() => app.quit());
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForApi(url, child, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`Relay's local server exited with code ${child.exitCode}. See relay.log in the Relay data folder.`));
      const request = http.get(`${url}/api/health`, response => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.setTimeout(1200, () => request.destroy());
      request.on('error', retry);
      function retry() {
        if (Date.now() - started > timeoutMs) return reject(new Error('Relay local server did not become ready within 30 seconds. See relay.log in the Relay data folder.'));
        setTimeout(attempt, 350);
      }
    };
    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#17191c',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (localOrigin && !url.startsWith(localOrigin)) {
      event.preventDefault();
      if (url.startsWith('https://')) shell.openExternal(url);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow.loadURL(localOrigin);
}

async function startLocalServer() {
  const relayRoot = path.join(process.resourcesPath, 'relay');
  const runtime = path.join(process.resourcesPath, 'runtime', 'node.exe');
  const serverEntry = path.join(relayRoot, 'server', 'dist', 'index.js');
  const clientIndex = path.join(relayRoot, 'client', 'dist', 'index.html');
  const modules = path.join(relayRoot, 'node_modules');

  for (const required of [runtime, serverEntry, clientIndex, modules]) {
    if (!fs.existsSync(required)) throw new Error(`The installer is missing a required Relay component: ${required}`);
  }

  const dataRoot = app.getPath('userData');
  const dataDir = path.join(dataRoot, 'data');
  const uploadDir = path.join(dataRoot, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  logFile = path.join(dataRoot, 'relay.log');

  const secretPath = path.join(dataRoot, 'session-secret');
  let sessionSecret;
  if (fs.existsSync(secretPath)) sessionSecret = fs.readFileSync(secretPath, 'utf8').trim();
  else {
    sessionSecret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretPath, sessionSecret, { encoding: 'utf8', mode: 0o600 });
  }

  const port = await reservePort();
  localOrigin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    CLIENT_ORIGIN: localOrigin,
    COOKIE_SECURE: 'false',
    COOKIE_SAME_SITE: 'lax',
    SESSION_SECRET: sessionSecret,
    DATABASE_FILE: path.join(dataDir, 'relay.sqlite'),
    UPLOAD_DIR: uploadDir,
    MAX_UPLOAD_MB: '10'
  };

  writeLog(`Starting local Relay API at ${localOrigin}`);
  apiProcess = spawn(runtime, [serverEntry], {
    cwd: relayRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  apiProcess.stdout.on('data', data => writeLog(String(data).trimEnd()));
  apiProcess.stderr.on('data', data => writeLog(`SERVER ERROR: ${String(data).trimEnd()}`));
  apiProcess.on('error', error => writeLog(`Could not launch local server: ${error.message}`));
  apiProcess.on('exit', (code, signal) => {
    writeLog(`Local server exited (code=${code}, signal=${signal})`);
    if (!isQuitting && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Relay stopped',
        message: 'Relay’s local service stopped unexpectedly. Restart Relay to try again.',
        buttons: ['Close']
      }).finally(() => app.quit());
    }
  });

  await waitForApi(localOrigin, apiProcess);
  writeLog('Relay local API is ready.');
}

async function checkForDesktopUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Updates unavailable',
        message: 'Automatic updates are available in the installed Relay desktop app.'
      });
    }
    return;
  }

  if (updateCheckPromise) {
    if (manual) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Checking for updates',
        message: 'Relay is already checking for updates. Please wait for the result.'
      });
    }
    return updateCheckPromise;
  }

  const check = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!manual || !result) return;

      if (result.isUpdateAvailable) {
        const version = result.updateInfo?.version || 'a newer version';
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update found',
          message: `Relay ${version} is available and is downloading in the background. You’ll be prompted to restart when it is ready.`,
          buttons: ['OK']
        });
      } else {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Relay is up to date',
          message: `You’re running Relay ${app.getVersion()}, the latest available version.`,
          buttons: ['OK']
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLog(`Update check failed: ${message}`);
      if (manual) {
        await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Could not check for updates',
          message: `Relay could not check GitHub Releases. Check your internet connection and try again.\\n\\nDetails: ${message}`,
          buttons: ['OK']
        });
      }
    }
  })();

  updateCheckPromise = check;
  try {
    await check;
  } finally {
    if (updateCheckPromise === check) updateCheckPromise = null;
  }
}

function configureApplicationMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Relay',
      submenu: [
        {
          label: 'About Relay',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About Relay',
            message: `Relay ${app.getVersion()}`,
            detail: 'Relay Desktop'
          })
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => checkForDesktopUpdates(true)
        },
        {
          label: 'Open GitHub Releases',
          click: () => shell.openExternal('https://github.com/ThunderZyro/Relay/releases/latest')
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => writeLog('Checking for desktop updates.'));
  autoUpdater.on('update-available', info => writeLog(`Desktop update available: ${info.version}`));
  autoUpdater.on('update-not-available', info => writeLog(`Relay is up to date (${info.version}).`));
  autoUpdater.on('download-progress', progress => writeLog(`Update download: ${Math.round(progress.percent)}%`));
  autoUpdater.on('error', error => writeLog(`Updater: ${error.message}`));
  autoUpdater.on('update-downloaded', async info => {
    writeLog(`Desktop update downloaded: ${info.version}`);
    if (!mainWindow) {
      autoUpdater.quitAndInstall();
      return;
    }
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Relay update ready',
      message: `Relay ${info.version} has downloaded and is ready to install.`,
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (answer.response === 0) autoUpdater.quitAndInstall();
  });
  setTimeout(() => { void checkForDesktopUpdates(false); }, 10000);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    configureApplicationMenu();
    await startLocalServer();
    await createWindow();
    configureAutoUpdates();
  } catch (error) {
    showFatal('Relay could not start', error instanceof Error ? error.message : String(error));
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (apiProcess && !apiProcess.killed) apiProcess.kill();
});

app.on('window-all-closed', () => app.quit());

'use strict';

const { app, BrowserWindow, dialog, Menu, shell, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');

app.setName('Relay');
app.setAppUserModelId('com.relay.platform');

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();

let mainWindow = null;
let isQuitting = false;
let logFile = null;
let updateCheckPromise = null;

const defaultAppUrl = 'https://relay-platform-zyro-d26e.vercel.app';
const configuredAppUrl = process.env.RELAY_APP_URL || defaultAppUrl;
let appUrl;
let appOrigin;

try {
  appUrl = new URL(configuredAppUrl);
  const localDevelopment = !app.isPackaged && ['localhost', '127.0.0.1'].includes(appUrl.hostname);
  if (appUrl.protocol !== 'https:' && !(localDevelopment && appUrl.protocol === 'http:')) {
    throw new Error('Relay Desktop only accepts HTTPS URLs outside local development.');
  }
  appOrigin = appUrl.origin;
} catch (error) {
  appUrl = new URL(defaultAppUrl);
  appOrigin = appUrl.origin;
  process.nextTick(() => showFatal('Invalid Relay URL', error instanceof Error ? error.message : String(error)));
}

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { if (logFile) fs.appendFileSync(logFile, line); } catch { /* logging must not stop Relay */ }
}

function showFatal(title, message) {
  writeLog(`${title}: ${message}`);
  dialog.showMessageBox({ type: 'error', title, message, buttons: ['Close'] })
    .finally(() => app.quit());
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') void shell.openExternal(parsed.toString());
  } catch {
    writeLog(`Blocked invalid external URL: ${String(url)}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#171d21',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      const parsed = new URL(target);
      if (parsed.origin !== appOrigin) {
        event.preventDefault();
        openExternal(target);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeLog(`Relay window renderer stopped: ${details.reason} (exit code ${details.exitCode}).`);
  });

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  writeLog(`Opening shared Relay service: ${appOrigin}`);
  return mainWindow.loadURL(appUrl.toString());
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
        message: 'Relay is already checking for updates.'
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
          message: `Relay could not check GitHub Releases. Check your internet connection and try again.\n\nDetails: ${message}`,
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Relay',
      submenu: [
        {
          label: 'About Relay',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About Relay',
            message: `Relay ${app.getVersion()}`,
            detail: 'Relay Desktop · Shared online workspace'
          })
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates…', click: () => void checkForDesktopUpdates(true) },
        { label: 'Open Relay in Browser', click: () => openExternal(appUrl.toString()) },
        { label: 'Open GitHub Releases', click: () => openExternal('https://github.com/ThunderZyro/Relay/releases/latest') }
      ]
    }
  ]));
}

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'notifications');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'notifications';
  });
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
  setTimeout(() => { void checkForDesktopUpdates(false); }, 10000).unref();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'Relay'));
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    logFile = path.join(app.getPath('userData'), 'relay-desktop.log');
    configureApplicationMenu();
    configurePermissions();
    await createWindow();
    configureAutoUpdates();
  } catch (error) {
    showFatal('Relay could not start', error instanceof Error ? error.message : String(error));
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  writeLog('Relay Desktop is closing.');
});

app.on('window-all-closed', () => {
  if (!isQuitting) app.quit();
});

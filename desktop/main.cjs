const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  net,
  protocol,
  shell
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_SCHEME = 'relay';
const APP_HOST = 'app';
const APP_URL = 'relay://app/';
const DEFAULT_API_ORIGIN = 'https://relay-platform-gold.vercel.app';

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

function readApiOrigin() {
  const argument = process.argv.find(value => value.startsWith('--relay-api-origin='));
  const raw = (argument ? argument.slice('--relay-api-origin='.length) : process.env.RELAY_API_ORIGIN || DEFAULT_API_ORIGIN).trim();
  const parsed = new URL(raw);
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Relay server URL must use HTTPS.');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('HTTP is only allowed for a local development server. Use HTTPS for remote Relay servers.');
  }
  return parsed.origin;
}

let apiOrigin;
try {
  apiOrigin = readApiOrigin();
} catch (error) {
  app.whenReady().then(() => {
    dialog.showErrorBox('Relay server URL is invalid', error.message || 'Check RELAY_API_ORIGIN.');
    app.quit();
  });
  apiOrigin = DEFAULT_API_ORIGIN;
}

ipcMain.on('relay:get-api-origin', event => {
  event.returnValue = apiOrigin;
});

function clientDistPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'client')
    : path.resolve(__dirname, '../client/dist');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function handleAppRequest(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (url.protocol !== APP_SCHEME + ':' || url.hostname !== APP_HOST) {
    return new Response('Not found', { status: 404 });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad path', { status: 400 });
  }

  const root = clientDistPath();
  const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
  let filePath = path.resolve(root, relativePath);

  if (!isInside(root, filePath)) return new Response('Forbidden', { status: 403 });

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
  } catch {
    // BrowserRouter routes such as /home and /settings/account must resolve
    // to the same packaged index.html. Missing asset files remain real 404s.
    if (path.extname(filePath)) return new Response('Not found', { status: 404 });
    filePath = path.join(root, 'index.html');
  }

  try {
    return await net.fetch(pathToFileURL(filePath).toString());
  } catch {
    return new Response('Relay desktop assets are missing. Build the web client first.', { status: 503 });
  }
}

function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === APP_SCHEME + ':' && url.hostname === APP_HOST;
  } catch {
    return false;
  }
}

async function openExternal(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
      await shell.openExternal(url.toString());
    }
  } catch {
    // Ignore malformed and non-web navigation attempts.
  }
}

function installMenu() {
  const template = [
    {
      label: 'Relay',
      submenu: [
        { role: 'about', label: 'About Relay' },
        { type: 'separator' },
        { role: 'reload', label: 'Reload Relay' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Relay' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Relay website',
          click: () => openExternal(DEFAULT_API_ORIGIN)
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#1a1e26',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    void openExternal(url);
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    // Electron owns the window lifecycle; no renderer process is exposed.
  });

  void window.loadURL(APP_URL).catch(error => {
    dialog.showErrorBox('Relay could not start', error.message || 'The packaged web client could not be loaded.');
    window.close();
  });
}

app.whenReady().then(async () => {
  const indexPath = path.join(clientDistPath(), 'index.html');
  try {
    await fs.access(indexPath);
  } catch {
    dialog.showErrorBox('Relay web client is missing', 'Build the website first with: npm --prefix client run build');
    app.quit();
    return;
  }

  protocol.handle(APP_SCHEME, handleAppRequest);
  installMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

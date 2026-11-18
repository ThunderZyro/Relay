const { contextBridge, ipcRenderer } = require('electron');

// Expose only the server origin the website needs. No Node or Electron APIs
// are made available to the renderer.
const apiOrigin = String(ipcRenderer.sendSync('relay:get-api-origin') || '');
contextBridge.exposeInMainWorld('relayDesktop', Object.freeze({ apiOrigin }));

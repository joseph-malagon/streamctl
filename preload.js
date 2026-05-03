const { contextBridge, ipcRenderer, shell } = require('electron');
const { pathToFileURL } = require('url');
const { version } = require('./package.json');

const allowedChannels = new Set([
  'get-config',
  'save-config',
  'start-bot',
  'stop-bot',
  'pick-sound-file',
  'import-sound-file',
  'save-recorded-sound',
  'search-freesound',
  'import-remote-sound',
  'search-giphy',
  'import-remote-meme',
  'pick-image-file',
  'get-overlay-url',
  'test-sound',
  'test-trigger',
  'test-meme',
  'export-config',
  'import-config',
  'get-history',
  'save-history',
  'check-for-updates',
  'install-update',
  'test-overlay',
  'start-oauth',
  'create-clip'
]);

const allowedEvents = new Set([
  'updater-status',
  'bot-event',
  'tokens-refreshed'
]);

contextBridge.exposeInMainWorld('streamctl', {
  appVersion: version,
  ipc: {
    invoke(channel, ...args) {
      if (!allowedChannels.has(channel)) {
        return Promise.reject(new Error(`Unsupported IPC channel: ${channel}`));
      }
      return ipcRenderer.invoke(channel, ...args);
    },
    on(channel, listener) {
      if (!allowedEvents.has(channel)) return () => {};
      const wrapped = (event, payload) => listener(event, payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  pathToFileURL(filePath) {
    return pathToFileURL(filePath).href;
  },
  openExternal(targetUrl) {
    return shell.openExternal(targetUrl);
  }
});

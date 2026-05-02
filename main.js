const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const url = require('url');
const Store = require('electron-store');
const fetch = require('node-fetch');
const { autoUpdater } = require('electron-updater');
const TwitchBot = require('./bot');

// ── Auto-updater config ───────────────────────────────────────────────────────
// Silently check for updates, download in background, prompt to restart
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Don't check for updates in dev (npm start)
const isDev = !app.isPackaged;

const store = new Store();
let mainWindow;
let bot = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0d14',
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('ui/index.html');
}

app.whenReady().then(() => {
  createWindow();

  // Check for updates after a short delay (let window fully load first)
  if (!isDev) {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify();
    }, 3000);
  }
});

// ── Auto-updater events ───────────────────────────────────────────────────────

autoUpdater.on('checking-for-update', () => {
  sendUpdaterStatus('checking');
});

autoUpdater.on('update-available', (info) => {
  sendUpdaterStatus('available', `Update v${info.version} found — downloading...`);
});

autoUpdater.on('update-not-available', () => {
  sendUpdaterStatus('current');
});

autoUpdater.on('download-progress', (progress) => {
  sendUpdaterStatus('downloading', `Downloading update... ${Math.round(progress.percent)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
  sendUpdaterStatus('ready', `v${info.version} ready — restart to install`);
  // Show a non-intrusive dialog — she can choose when to restart
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `StreamCtl v${info.version} has been downloaded.`,
      detail: 'Restart now to install, or it will install automatically next time you close the app.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  }
});

autoUpdater.on('error', (err) => {
  // Don't bother the user with update errors — just log it
  console.error('Auto-updater error:', err.message);
  sendUpdaterStatus('error');
});

function sendUpdaterStatus(status, message) {
  if (mainWindow) mainWindow.webContents.send('updater-status', { status, message });
}

app.on('window-all-closed', () => {
  if (bot) bot.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => store.store);

ipcMain.handle('save-config', (_, config) => {
  store.set(config);
  return true;
});

ipcMain.handle('start-bot', async (_, config) => {
  try {
    if (bot) await bot.stop();
    bot = new TwitchBot(
      config,
      // Event callback
      (event, data) => {
        if (mainWindow) mainWindow.webContents.send('bot-event', { event, data });
      },
      // Token refresh callback — persist new tokens to store silently
      (newAccessToken, newRefreshToken) => {
        const current = store.get('credentials') || {};
        store.set('credentials', {
          ...current,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken
        });
        // Also notify the UI so it can update its in-memory config
        if (mainWindow) {
          mainWindow.webContents.send('tokens-refreshed', { newAccessToken, newRefreshToken });
        }
      }
    );
    await bot.start();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-bot', async () => {
  if (bot) {
    await bot.stop();
    bot = null;
  }
  return true;
});

ipcMain.handle('pick-sound-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('pick-image-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['gif', 'png', 'jpg', 'webp'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-overlay-url', () => {
  return `http://localhost:9000/overlay`;
});

ipcMain.handle('test-sound', (_, filePath) => {
  if (bot) bot.playSound(filePath);
});

ipcMain.handle('test-trigger', (_, trigger) => {
  if (bot) bot.fireTrigger(trigger);
});

ipcMain.handle('check-for-updates', () => {
  if (!isDev) autoUpdater.checkForUpdatesAndNotify();
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('test-overlay', (_, animConfig) => {
  if (bot) bot.sendOverlay(animConfig);
});

// ── OAuth Flow ────────────────────────────────────────────────────────────────
// Spins up a temporary local server, opens Twitch auth in the browser,
// catches the callback, exchanges the code for a token, then shuts down.

ipcMain.handle('start-oauth', async (_, { clientId, clientSecret, scopes }) => {
  return new Promise((resolve) => {
    const redirectUri = 'http://localhost:3000/callback';
    const state = Math.random().toString(36).substring(2);

    // Build the Twitch auth URL
    const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('force_verify', 'true');

    // Temporary local server to catch the callback
    let server;
    const timeout = setTimeout(() => {
      if (server) server.close();
      resolve({ success: false, error: 'Timed out waiting for Twitch login (2 min).' });
    }, 120000);

    server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/callback') return;

      // Send a nice response page so the browser tab closes cleanly
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><style>
        body { font-family: system-ui; display:flex; align-items:center; justify-content:center;
               height:100vh; margin:0; background:#0d0d14; color:#e8e8f0; }
        h2 { color: #7c5cfc; } p { color: #555570; }
      </style></head><body>
        <div style="text-align:center">
          <h2>✓ Connected!</h2>
          <p>You can close this tab and return to StreamCtl.</p>
        </div>
      </body></html>`);

      server.close();
      clearTimeout(timeout);

      const { code, state: returnedState, error } = parsed.query;

      if (error) return resolve({ success: false, error: `Twitch denied: ${error}` });
      if (returnedState !== state) return resolve({ success: false, error: 'State mismatch — possible CSRF.' });

      // Exchange code for token
      try {
        const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
          })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.access_token) {
          // Also fetch the user's broadcaster ID
          const userRes = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'Client-Id': clientId
            }
          });
          const userData = await userRes.json();
          const user = userData.data?.[0];
          resolve({
            success: true,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            broadcasterId: user?.id,
            login: user?.login,
            displayName: user?.display_name
          });
        } else {
          resolve({ success: false, error: tokenData.message || 'Token exchange failed.' });
        }
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });

    server.listen(3000, () => {
      // Open Twitch auth page in the system browser
      shell.openExternal(authUrl.toString());
    });
  });
});

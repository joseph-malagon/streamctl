const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const Store = require('electron-store');
const fetch = require('node-fetch');
const TwitchBot = require('./bot');

// Don't check for updates in dev (npm start)
const isDev = !app.isPackaged;
let autoUpdater = null;

if (!isDev) {
  ({ autoUpdater } = require('electron-updater'));
  // Silently check for updates, download in background, prompt to restart
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
}

const store = new Store();
let mainWindow;
let bot = null;

function soundLibraryDir() {
  const dir = path.join(app.getPath('userData'), 'sounds');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memeLibraryDir() {
  const dir = path.join(app.getPath('userData'), 'memes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeFilePart(value) {
  return String(value || 'sound')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'sound';
}

function soundId() {
  return crypto.randomBytes(8).toString('hex');
}

function soundMetadata({ id, name, filePath, source = 'local', license = '', attribution = '', sourceUrl = '', duration = null }) {
  return {
    id,
    name: name || path.basename(filePath),
    filePath,
    source,
    license,
    attribution,
    sourceUrl,
    duration,
    createdAt: new Date().toISOString()
  };
}

function memeMetadata({ id, name, filePath, source = 'local', attribution = '', sourceUrl = '', previewUrl = '' }) {
  return {
    id,
    name: name || path.basename(filePath),
    filePath,
    source,
    attribution,
    sourceUrl,
    previewUrl,
    createdAt: new Date().toISOString()
  };
}

function extensionFromContentType(contentType) {
  if (/mpeg|mp3/i.test(contentType || '')) return '.mp3';
  if (/ogg/i.test(contentType || '')) return '.ogg';
  if (/wav/i.test(contentType || '')) return '.wav';
  if (/webm/i.test(contentType || '')) return '.webm';
  return '.mp3';
}

function imageExtensionFromContentType(contentType) {
  if (/gif/i.test(contentType || '')) return '.gif';
  if (/png/i.test(contentType || '')) return '.png';
  if (/webp/i.test(contentType || '')) return '.webp';
  if (/jpe?g/i.test(contentType || '')) return '.jpg';
  return '.gif';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0d14'
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

if (autoUpdater) {
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
}

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
  if (bot) bot.updateConfig(config);
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
    const status = await bot.start();
    return { success: true, ...status };
  } catch (err) {
    if (bot) {
      try { await bot.stop(); } catch {}
      bot = null;
    }
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
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'webm', 'm4a'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('import-sound-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'webm', 'm4a'] }]
  });
  if (result.canceled) return null;

  const sourcePath = result.filePaths[0];
  const id = soundId();
  const ext = path.extname(sourcePath) || '.mp3';
  const name = path.basename(sourcePath, ext);
  const destPath = path.join(soundLibraryDir(), `${safeFilePart(name)}-${id}${ext}`);
  fs.copyFileSync(sourcePath, destPath);
  return soundMetadata({ id, name, filePath: destPath, source: 'local' });
});

ipcMain.handle('save-recorded-sound', async (_, { name, dataUrl, mimeType }) => {
  if (!dataUrl || !/^data:audio\//.test(dataUrl)) throw new Error('Invalid audio recording.');
  const id = soundId();
  const base64 = dataUrl.split(',')[1];
  const ext = extensionFromContentType(mimeType || dataUrl.slice(5, dataUrl.indexOf(';')));
  const filePath = path.join(soundLibraryDir(), `${safeFilePart(name)}-${id}${ext}`);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return soundMetadata({ id, name, filePath, source: 'recorded' });
});

ipcMain.handle('search-freesound', async (_, { apiKey, query }) => {
  if (!apiKey) throw new Error('Add a Freesound API key first.');
  if (!query || !query.trim()) return [];

  const params = new URLSearchParams({
    query: query.trim(),
    token: apiKey,
    page_size: '12',
    fields: 'id,name,duration,license,username,url,previews,tags'
  });

  const res = await fetch(`https://freesound.org/apiv2/search/?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.message || 'Freesound search failed.');
  return (data.results || []).map((sound) => ({
    id: sound.id,
    name: sound.name,
    duration: sound.duration,
    license: sound.license,
    username: sound.username,
    url: sound.url,
    previewUrl: sound.previews?.['preview-hq-mp3'] || sound.previews?.['preview-lq-mp3'] || sound.previews?.['preview-hq-ogg'] || sound.previews?.['preview-lq-ogg'],
    tags: sound.tags || []
  })).filter((sound) => sound.previewUrl);
});

ipcMain.handle('import-remote-sound', async (_, { name, downloadUrl, sourceUrl, license, attribution, duration }) => {
  if (!downloadUrl || !/^https:\/\//.test(downloadUrl)) throw new Error('Invalid sound URL.');
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Could not download sound (${res.status}).`);
  const buffer = await res.buffer();
  const id = soundId();
  const ext = path.extname(new URL(downloadUrl).pathname) || extensionFromContentType(res.headers.get('content-type'));
  const filePath = path.join(soundLibraryDir(), `${safeFilePart(name)}-${id}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return soundMetadata({ id, name, filePath, source: 'freesound', license, attribution, sourceUrl, duration });
});

ipcMain.handle('search-giphy', async (_, { apiKey, query, rating = 'pg-13' }) => {
  if (!apiKey) throw new Error('Add a GIPHY API key first.');
  if (!query || !query.trim()) return [];

  const params = new URLSearchParams({
    api_key: apiKey,
    q: query.trim().slice(0, 50),
    limit: '12',
    rating,
    bundle: 'messaging_non_clips'
  });

  const res = await fetch(`https://api.giphy.com/v1/gifs/search?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.meta?.msg || data.message || 'GIPHY search failed.');

  return (data.data || []).map((gif) => {
    const preview = gif.images?.fixed_width_small || gif.images?.fixed_width || gif.images?.downsized;
    const download = gif.images?.downsized_medium || gif.images?.original || gif.images?.downsized;
    return {
      id: gif.id,
      title: gif.title || 'GIPHY meme',
      username: gif.username || gif.user?.display_name || '',
      url: gif.url,
      previewUrl: preview?.url,
      downloadUrl: download?.url
    };
  }).filter((gif) => gif.previewUrl && gif.downloadUrl);
});

ipcMain.handle('import-remote-meme', async (_, { name, downloadUrl, sourceUrl, attribution, previewUrl }) => {
  if (!downloadUrl || !/^https:\/\//.test(downloadUrl)) throw new Error('Invalid meme URL.');
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Could not download meme (${res.status}).`);
  const buffer = await res.buffer();
  const id = soundId();
  const ext = path.extname(new URL(downloadUrl).pathname) || imageExtensionFromContentType(res.headers.get('content-type'));
  const filePath = path.join(memeLibraryDir(), `${safeFilePart(name || 'meme')}-${id}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return memeMetadata({ id, name, filePath, source: 'giphy', attribution, sourceUrl, previewUrl });
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
  if (bot) {
    bot.playSound(filePath);
  } else if (mainWindow) {
    // Bot not running — send directly so the renderer can still play/preview the file
    mainWindow.webContents.send('bot-event', { event: 'sound-played', data: { file: filePath } });
  }
});

ipcMain.handle('test-trigger', (_, trigger) => {
  if (bot) bot.fireTrigger(trigger);
});

ipcMain.handle('test-meme', (_, filePath, duration, position) => {
  if (!bot) return { ok: false, reason: 'bot-not-running' };
  return bot.showMeme(filePath, duration, position);
});

ipcMain.handle('export-config', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'streamctl-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(store.store, null, 2));
  return true;
});

ipcMain.handle('import-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled) return null;
  try {
    const imported = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    store.set(imported);
    return imported;
  } catch {
    return { error: 'Invalid config file.' };
  }
});

ipcMain.handle('get-history', () => store.get('activityHistory') || []);

ipcMain.handle('save-history', (_, items) => {
  store.set('activityHistory', items.slice(-200));
});

ipcMain.handle('check-for-updates', () => {
  if (autoUpdater) autoUpdater.checkForUpdatesAndNotify();
});

ipcMain.handle('install-update', () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

ipcMain.handle('test-overlay', (_, animConfig) => {
  if (bot) bot.sendOverlay(animConfig);
});

// ── OAuth Flow ────────────────────────────────────────────────────────────────
// Spins up a temporary local HTTP server, opens Twitch auth in the browser,
// catches the callback on http://localhost, exchanges code for token, shuts down.

ipcMain.handle('start-oauth', async (_, { clientId, clientSecret, scopes }) => {
  return new Promise((resolve) => {
    // Port 7878 — high enough to not need admin rights on Windows
    const redirectUri = 'http://localhost:7878';
    const state = crypto.randomBytes(16).toString('hex');
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (server?.listening) server.close();
      resolve(result);
    };

    const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('force_verify', 'true');

    const timeout = setTimeout(() => {
      finish({ success: false, error: 'Timed out waiting for Twitch login (2 min).' });
    }, 120000);

    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      const { code, state: returnedState, error } = parsed.query;

      if (!code && !error) {
        res.writeHead(204);
        res.end();
        return;
      }

      // Twitch redirects to http://localhost/?code=xxx — catch any path
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

      if (error) return finish({ success: false, error: `Twitch denied: ${error}` });
      if (returnedState !== state) return finish({ success: false, error: 'State mismatch.' });

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
          const userRes = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'Client-Id': clientId
            }
          });
          const userData = await userRes.json();
          const user = userData.data?.[0];
          finish({
            success: true,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            broadcasterId: user?.id,
            login: user?.login,
            displayName: user?.display_name
          });
        } else {
          finish({ success: false, error: tokenData.message || 'Token exchange failed.' });
        }
      } catch (err) {
        finish({ success: false, error: err.message });
      }
    });

    server.on('error', (err) => {
      finish({ success: false, error: `Could not start local OAuth callback server: ${err.message}` });
    });

    server.listen(7878, () => {
      shell.openExternal(authUrl.toString());
    });
  });
});

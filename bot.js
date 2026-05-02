const tmi = require('tmi.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

class TwitchBot {
  constructor(config, onEvent, onTokenRefresh) {
    this.config = config;
    this.onEvent = onEvent;
    this.onTokenRefresh = onTokenRefresh; // callback to persist new tokens
    this.chatClient = null;
    this.overlayServer = null;
    this.overlayIO = null;
    this.eventSubInterval = null;
    this.tokenRefreshInterval = null;
    this.running = false;
    this._refreshing = false; // prevent concurrent refresh attempts
  }

  async start() {
    this.running = true;
    await this._startChat();
    // Start the overlay after chat credentials pass validation so failed starts
    // do not leave a server bound to port 9000.
    if (!this.overlayServer) await this._startOverlayServer();
    if (this.config.credentials?.accessToken) {
      this._startEventSubPolling();
      this._startTokenRefreshWatcher();
    }
    this.onEvent('status', { connected: true, message: 'Bot connected!' });
  }

  async stop() {
    this.running = false;
    if (this.chatClient) {
      try { await this.chatClient.disconnect(); } catch {}
      this.chatClient = null;
    }
    if (this.eventSubInterval) {
      clearInterval(this.eventSubInterval);
      this.eventSubInterval = null;
    }
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
    }
    if (this.overlayIO) {
      this.overlayIO.close();
      this.overlayIO = null;
    }
    if (this.overlayServer) {
      await new Promise((resolve) => this.overlayServer.close(resolve));
      this.overlayServer = null;
    }
    this.onEvent('status', { connected: false, message: 'Bot stopped.' });
  }

  // ── Token Refresh ────────────────────────────────────────────────────────────

  // Proactively validate the token every 30 minutes.
  // Twitch tokens expire after ~4 hours but can be revoked at any time.
  // Validating lets us refresh before a stream-killing 401.
  _startTokenRefreshWatcher() {
    this.tokenRefreshInterval = setInterval(() => {
      if (!this.running) return;
      this._validateAndRefreshIfNeeded();
    }, 30 * 60 * 1000); // every 30 min

    // Also validate immediately on start
    this._validateAndRefreshIfNeeded();
  }

  async _validateAndRefreshIfNeeded() {
    const { accessToken } = this.config.credentials || {};
    if (!accessToken || this._refreshing) return;

    try {
      const res = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${accessToken}` }
      });

      if (res.status === 401) {
        // Token is invalid — refresh now
        await this._refreshAccessToken();
      } else if (res.ok) {
        const data = await res.json();
        // expires_in is in seconds — refresh if less than 1 hour left
        if (data.expires_in && data.expires_in < 3600) {
          await this._refreshAccessToken();
        }
      }
    } catch {
      // Network error — will retry next interval
    }
  }

  async _refreshAccessToken() {
    if (this._refreshing) return;
    this._refreshing = true;

    const { refreshToken, clientId, clientSecret } = this.config.credentials || {};
    if (!refreshToken || !clientId || !clientSecret) {
      this._refreshing = false;
      this.onEvent('token-error', { message: 'Cannot refresh — missing refresh token or credentials. Please reconnect Twitch in Settings.' });
      return;
    }

    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      const data = await res.json();

      if (data.access_token) {
        // Update in-memory config
        this.config.credentials.accessToken = data.access_token;
        if (data.refresh_token) {
          this.config.credentials.refreshToken = data.refresh_token;
        }
        // Persist back to electron-store via callback
        if (this.onTokenRefresh) {
          this.onTokenRefresh(this.config.credentials.accessToken, data.refresh_token || refreshToken);
        }
        this.onEvent('token-refreshed', { message: 'Access token refreshed silently.' });
      } else {
        // Refresh token itself is expired — user must re-auth
        this.onEvent('token-error', { message: 'Session expired. Please reconnect Twitch in Settings.' });
      }
    } catch (err) {
      this.onEvent('token-error', { message: `Token refresh failed: ${err.message}` });
    } finally {
      this._refreshing = false;
    }
  }

  // Wrapper around fetch that auto-retries once on 401 after refreshing
  async _apiFetch(url, options = {}) {
    const creds = this.config.credentials || {};
    const headers = {
      Authorization: `Bearer ${creds.accessToken}`,
      'Client-Id': creds.clientId,
      ...options.headers
    };

    let res = await fetch(url, { ...options, headers });

    if (res.status === 401 && !this._refreshing) {
      // Try to refresh and retry once
      await this._refreshAccessToken();
      const newHeaders = {
        Authorization: `Bearer ${this.config.credentials.accessToken}`,
        'Client-Id': creds.clientId,
        ...options.headers
      };
      res = await fetch(url, { ...options, headers: newHeaders });
    }

    return res;
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  async _startChat() {
    const creds = this.config.credentials || {};
    const channel = creds.channel;
    const botUsername = creds.botUsername || creds.botLogin;
    // botAccessToken is the raw token — tmi.js needs it in oauth:TOKEN format
    const oauthToken = creds.oauthToken ||
      (creds.botAccessToken ? `oauth:${creds.botAccessToken}` : null);

    if (!channel || !botUsername || !oauthToken) {
      this.onEvent('status', { connected: false, message: 'Missing chat credentials — connect bot account in Settings.' });
      throw new Error('Missing chat credentials — connect bot account in Settings.');
    }

    // Dedup set — stores message IDs we've already processed
    // Prevents double-firing on reconnect replays
    this._seenMessageIds = new Set();

    // Per-trigger cooldown map: triggerKeyword -> last fired timestamp
    this._triggerLastFired = new Map();

    this.chatClient = new tmi.Client({
      options: { debug: false },
      identity: { username: botUsername, password: oauthToken },
      channels: [channel],
      connection: { reconnect: true, secure: true, maxReconnectAttempts: Infinity }
    });

    this.chatClient.on('message', (ch, tags, message, self) => {
      if (self) return;

      // Deduplicate by message ID — Twitch always sends a unique id tag
      const msgId = tags['id'];
      if (msgId) {
        if (this._seenMessageIds.has(msgId)) return;
        this._seenMessageIds.add(msgId);
        // Keep the set from growing forever — trim when it hits 500
        if (this._seenMessageIds.size > 500) {
          const first = this._seenMessageIds.values().next().value;
          this._seenMessageIds.delete(first);
        }
      }

      this._handleChatMessage(ch, tags, message);
    });

    this.chatClient.on('subscription', (channel, username, methods) => {
      this._handleSub(username, methods?.plan);
    });

    this.chatClient.on('resub', (channel, username, months, msg, userstate, methods) => {
      this._handleSub(username, methods?.plan, months);
    });

    this.chatClient.on('subgift', (channel, gifter, streakMonths, recipient, methods) => {
      this._handleSub(recipient, methods?.plan, null, gifter);
    });

    this.chatClient.on('raided', (channel, username, viewers) => {
      this._handleRaid(username, viewers);
    });

    this.chatClient.on('cheer', (channel, userstate) => {
      const bits = parseInt(userstate.bits || '0', 10);
      const username = userstate['display-name'] || userstate.username;
      if (bits > 0) this._handleBits(username, bits);
    });

    this.chatClient.on('disconnected', (reason) => {
      this._chatConnected = false;
      this.onEvent('status', { connected: false, message: `Disconnected: ${reason}` });
    });

    this.chatClient.on('connected', () => {
      const reconnect = this._chatConnected;
      this._chatConnected = true;
      this.onEvent('status', { connected: true, message: reconnect ? 'Reconnected to chat.' : 'Chat connected!' });
    });

    await this.chatClient.connect();
  }

  // Normalize a string for reliable matching:
  // - lowercase
  // - trim whitespace
  // - strip invisible/zero-width characters Twitch sometimes injects
  // - collapse multiple spaces into one
  _normalize(str) {
    return str
      .toLowerCase()
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '') // invisible chars
      .replace(/\s+/g, ' ')
      .trim();
  }

  _handleChatMessage(channel, tags, message) {
    const normalized = this._normalize(message);
    const username = tags['display-name'] || tags.username;

    this.onEvent('chat', { username, message });

    const triggers = this.config.chatTriggers || [];
    const now = Date.now();

    for (const trigger of triggers) {
      if (!trigger.enabled) continue;
      const keyword = this._normalize(trigger.keyword || '');
      if (!keyword) continue;

      // Per-trigger cooldown — default 3s, configurable
      const cooldownMs = (trigger.cooldownSeconds ?? 3) * 1000;
      const lastFired = this._triggerLastFired.get(keyword) || 0;
      if (now - lastFired < cooldownMs) continue;

      let matches = false;
      if (trigger.matchType === 'exact') {
        matches = normalized === keyword;
      } else if (trigger.matchType === 'startsWith') {
        matches = normalized.startsWith(keyword);
      } else {
        // 'contains' — default, most forgiving
        // Also check if it matches as a whole word to avoid partial false matches
        // e.g. keyword "gg" shouldn't fire on "eggs"
        if (trigger.wholeWord) {
          const re = new RegExp(`(?:^|\\s)${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
          matches = re.test(normalized);
        } else {
          matches = normalized.includes(keyword);
        }
      }

      if (matches) {
        this._triggerLastFired.set(keyword, now);

        if (trigger.response && this.chatClient) {
          const response = trigger.response.replace(/\{user\}/gi, username);
          this.chatClient.say(channel, response).catch(() => {});
        }
        if (trigger.soundFile) this.playSound(trigger.soundFile);
        if (trigger.imageFile) this.showMeme(trigger.imageFile, trigger.memeDuration, trigger.memePosition);
        if (trigger.animation) this.sendOverlay({ ...trigger.animation, username });

        this.onEvent('trigger-fired', { trigger: trigger.keyword, triggerId: trigger.id, username });
      }
    }
  }

  // Called by the UI test button — fires a trigger directly without chat
  fireTrigger(trigger) {
    const username = this.config.credentials?.login || 'TestUser';
    if (trigger.response && this.chatClient) {
      this.chatClient.say(`#${this.config.credentials?.channel}`, trigger.response.replace(/\{user\}/gi, username)).catch(() => {});
    }
    if (trigger.soundFile) this.playSound(trigger.soundFile);
    if (trigger.imageFile) this.showMeme(trigger.imageFile, trigger.memeDuration, trigger.memePosition);
    if (trigger.animation) this.sendOverlay({ ...trigger.animation, username });
    this.onEvent('trigger-fired', { trigger: trigger.keyword, triggerId: trigger.id, username, test: true });
  }

  // ── EventSub (Polling via Helix API) ────────────────────────────────────────

  _startEventSubPolling() {
    // Poll for recent follows/subs/redemptions every 10s
    this._lastFollowCheck = Date.now();
    this._lastSubCheck = Date.now();
    this._processedRedemptions = new Set();

    this.eventSubInterval = setInterval(() => {
      if (!this.running) return;
      this._checkChannelPoints();
      this._checkFollows();
    }, 8000);
  }

  async _checkChannelPoints() {
    const { broadcasterId } = this.config.credentials || {};
    if (!broadcasterId) return;

    try {
      const res = await this._apiFetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${broadcasterId}&status=UNFULFILLED&first=10`
      );
      if (!res.ok) return;
      const data = await res.json();

      for (const redemption of (data.data || [])) {
        if (this._processedRedemptions?.has(redemption.id)) continue;
        if (!this._processedRedemptions) this._processedRedemptions = new Set();
        this._processedRedemptions.add(redemption.id);
        const handled = this._handleRedemption(redemption);
        if (handled) await this._setRedemptionStatus(redemption, 'FULFILLED');
      }
    } catch {}
  }

  async _checkFollows() {
    const { broadcasterId } = this.config.credentials || {};
    if (!broadcasterId) return;

    try {
      const res = await this._apiFetch(
        `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}&first=5`
      );
      if (!res.ok) return;
      const data = await res.json();

      const now = Date.now();
      for (const follow of (data.data || [])) {
        const followedAt = new Date(follow.followed_at).getTime();
        if (followedAt > this._lastFollowCheck) {
          this._handleFollow(follow.user_name);
        }
      }
      this._lastFollowCheck = now;
    } catch {}
  }

  _handleRedemption(redemption) {
    const username = redemption.user_name;
    const rewardTitle = redemption.reward?.title;

    this.onEvent('redemption', { username, reward: rewardTitle });

    const redemptions = this.config.redemptions || [];
    const match = redemptions.find(r =>
      r.enabled && r.rewardName?.toLowerCase() === rewardTitle?.toLowerCase()
    );

    if (match) {
      if (match.soundFile) this.playSound(match.soundFile);
      if (match.imageFile) this.showMeme(match.imageFile, match.memeDuration, match.memePosition);
      if (match.animation) this.sendOverlay({ ...match.animation, username });
      if (match.chatMessage && this.chatClient) {
        const msg = match.chatMessage.replace(/\{user\}/gi, username);
        this.chatClient.say(`#${this.config.credentials.channel}`, msg).catch(() => {});
      }
      return true;
    }
    return false;
  }

  async _setRedemptionStatus(redemption, status) {
    const { broadcasterId } = this.config.credentials || {};
    const rewardId = redemption.reward?.id;
    if (!broadcasterId || !rewardId || !redemption.id) return;

    try {
      await this._apiFetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${broadcasterId}&reward_id=${rewardId}&id=${redemption.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        }
      );
    } catch {}
  }

  _handleFollow(username) {
    this.onEvent('follow', { username });
    const alerts = this.config.alerts || {};

    if (alerts.follow?.enabled) {
      if (alerts.follow.soundFile) this.playSound(alerts.follow.soundFile);
      if (alerts.follow.animation) this.sendOverlay({ ...alerts.follow.animation, username });
      if (alerts.follow.chatMessage && this.chatClient) {
        const msg = alerts.follow.chatMessage.replace(/\{user\}/gi, username);
        this.chatClient.say(`#${this.config.credentials.channel}`, msg).catch(() => {});
      }
    }
  }

  _handleSub(username, plan, months, gifter) {
    this.onEvent('sub', { username, plan, months, gifter });
    const alerts = this.config.alerts || {};

    if (alerts.sub?.enabled) {
      if (alerts.sub.soundFile) this.playSound(alerts.sub.soundFile);
      if (alerts.sub.animation) this.sendOverlay({ ...alerts.sub.animation, username });
      if (alerts.sub.chatMessage && this.chatClient) {
        const msg = alerts.sub.chatMessage.replace(/\{user\}/gi, username);
        this.chatClient.say(`#${this.config.credentials.channel}`, msg).catch(() => {});
      }
    }
  }

  _handleBits(username, bits) {
    this.onEvent('bits', { username, bits });
    const alerts = this.config.alerts || {};

    if (alerts.bits?.enabled && bits >= (alerts.bits.threshold ?? 1)) {
      if (alerts.bits.soundFile) this.playSound(alerts.bits.soundFile);
      if (alerts.bits.animation) this.sendOverlay({ ...alerts.bits.animation, username });
      if (alerts.bits.chatMessage && this.chatClient) {
        const msg = alerts.bits.chatMessage
          .replace(/\{user\}/gi, username)
          .replace(/\{bits\}/gi, bits);
        this.chatClient.say(`#${this.config.credentials.channel}`, msg).catch(() => {});
      }
    }
  }

  _handleRaid(username, viewers) {
    this.onEvent('raid', { username, viewers });
    const alerts = this.config.alerts || {};

    if (alerts.raid?.enabled) {
      if (alerts.raid.soundFile) this.playSound(alerts.raid.soundFile);
      if (alerts.raid.animation) this.sendOverlay({ ...alerts.raid.animation, username });
      if (alerts.raid.chatMessage && this.chatClient) {
        const msg = alerts.raid.chatMessage.replace(/\{user\}/gi, username);
        this.chatClient.say(`#${this.config.credentials.channel}`, msg).catch(() => {});
      }
    }
  }

  // ── Sound ───────────────────────────────────────────────────────────────────

  playSound(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    this.onEvent('sound-played', { file: filePath });
  }

  showMeme(filePath, duration = 5, position = 'center') {
    if (!filePath || !fs.existsSync(filePath)) return;
    const url = `http://localhost:9000/media?path=${encodeURIComponent(filePath)}`;
    if (this.overlayIO) this.overlayIO.emit('show-meme', { url, duration, position });
  }

  // ── Overlay Server ──────────────────────────────────────────────────────────

  async _startOverlayServer() {
    const expressApp = express();
    expressApp.use('/sounds', express.static(path.dirname(this.config.soundsDir || '.')));
    expressApp.get('/overlay', (req, res) => {
      res.sendFile(path.join(__dirname, 'overlay/overlay.html'));
    });
    // Serve local media files (images/GIFs) for meme popups
    expressApp.get('/media', (req, res) => {
      const filePath = path.resolve(decodeURIComponent(req.query.path || ''));
      if (!this._allowedMediaFiles().has(filePath)) return res.status(403).send('Forbidden');
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
      const ext = path.extname(filePath).toLowerCase();
      if (!['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return res.status(403).send('Forbidden');
      res.sendFile(filePath);
    });

    this.overlayServer = http.createServer(expressApp);
    this.overlayIO = new Server(this.overlayServer, { cors: { origin: '*' } });

    this.overlayIO.on('connection', (socket) => {
      console.log('Overlay connected');
    });

    await new Promise((resolve, reject) => {
      this.overlayServer.once('error', reject);
      this.overlayServer.listen(9000, '127.0.0.1', resolve);
    });
  }

  sendOverlay(animConfig) {
    if (this.overlayIO) {
      this.overlayIO.emit('animate', animConfig);
    }
  }

  _allowedMediaFiles() {
    const files = new Set();
    const add = (filePath) => {
      if (filePath) files.add(path.resolve(filePath));
    };

    for (const redemption of this.config.redemptions || []) add(redemption.imageFile);
    for (const trigger of this.config.chatTriggers || []) add(trigger.imageFile);

    return files;
  }
}

module.exports = TwitchBot;

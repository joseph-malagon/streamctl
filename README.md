# StreamCtl — Custom Twitch Bot

A solid, reliable Twitch bot with a clean UI. Built with Electron + Node.js.

## Features
- 🎮 Channel Point Redemptions → play MP3 sounds + overlay animations
- 💬 Chat Trigger Commands → respond to keywords with messages + sounds + animations
- 🔔 Follow / Sub / Raid Alerts → sounds + chat messages
- 🎬 OBS Overlay → browser source with 4 animation styles (slideIn, bounce, explosion, rainbow)

---

## Setup

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Install dependencies
Open a terminal/command prompt in this folder and run:
```
npm install
```

### 3. Start the app
```
npm start
```

---

## First-Time Configuration

### Get your credentials (do this once):

1. **Create a bot account** on Twitch (e.g. `yourname_bot`)

2. **Get OAuth token** (for chat):
   - Go to https://twitchapps.com/tmi/
   - Log in as your BOT account
   - Copy the `oauth:xxxxx` token

3. **Get Client ID + Access Token** (for channel points/follows):
   - Go to https://dev.twitch.tv/console
   - Create a new Application
   - Copy the Client ID
   - For the Access Token, use the Twitch Token Generator:
     https://twitchtokengenerator.com
     - Select scopes: `channel:read:redemptions`, `moderator:read:followers`
     - Copy the Access Token

4. **Get your Broadcaster ID**:
   - Go to https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
   - Enter your channel name → copy the ID

5. **In your Twitch chat**, type: `/mod yourbotname`

### In the app:
1. Click **Credentials** in the sidebar
2. Fill in all fields
3. Click **Save Credentials**
4. Click **GO LIVE**

---

## OBS Overlay Setup (do once)

1. Start the app and click GO LIVE
2. Click **Overlay** in the sidebar
3. Copy the URL: `http://localhost:9000/overlay`
4. In OBS → Sources → Add → Browser Source
5. Paste the URL, set width: **1920**, height: **1080**
6. Check "Shutdown source when not visible" = OFF

---

## Adding Sounds

1. Click **Redemptions** or **Chat Triggers** in sidebar
2. Click **+ Add**
3. Click **Browse** next to Sound File
4. Pick your MP3 file from anywhere on your computer

---

## Animation Styles

| Style | Effect |
|-------|--------|
| Slide In | Alert box slides in from the right |
| Bounce | Text pops in the center with bounce |
| Explosion | Text + confetti particle burst |
| Rainbow | Cycling color text animation |

---

## Troubleshooting

**Bot won't connect** → Check OAuth token starts with `oauth:`, check bot is modded in chat

**Sounds not playing** → Check the file path still exists, try a different MP3

**Overlay not showing** → Make sure bot is running (GO LIVE), refresh OBS browser source

**Channel points not firing** → Requires Twitch Affiliate or Partner status

# StreamCtl — Twitch Bot

A solid, reliable Twitch bot with a clean desktop UI. Built with Electron + Node.js.

## Features
- 🎮 **Channel Point Redemptions** — play MP3 sounds + overlay animations
- 💬 **Chat Trigger Commands** — respond to keywords with messages, sounds, and animations
- 🔔 **Follow Alerts** — sounds + chat messages on new follows
- 🎬 **OBS Overlay** — browser source with 4 animation styles (Slide In, Bounce, Explosion, Rainbow)
- 🔑 **Built-in OAuth** — connect Twitch accounts directly, no third-party token sites
- 🔄 **Auto token refresh** — tokens refresh silently, no mid-stream disconnects
- ⬆️ **Auto updates** — app updates itself silently in the background

---

## Installation (End User)

Download the latest `StreamCtl Setup x.x.x.exe` from the [Releases](../../releases) page and run it. It installs like any normal Windows app and appears in your Start menu.

---

## First-Time Setup

### Step 1 — Register your app on Twitch (one time)

1. Go to [dev.twitch.tv/console](https://dev.twitch.tv/console) and log in with your **main Twitch account**
2. Make sure **Two-Factor Authentication** is enabled on your account (required by Twitch)
3. Click **Applications → Register Your Application**
4. Fill in:
   - **Name:** `StreamCtl` (must be unique — add numbers if taken)
   - **OAuth Redirect URL:** `http://localhost:7878`
   - **Category:** Chat Bot
5. Click **Create**, then **Manage**
6. Copy the **Client ID**
7. Click **New Secret** and copy the **Client Secret**

### Step 2 — Connect your main Twitch account

1. Open StreamCtl and go to **Credentials**
2. Paste your Client ID and Client Secret
3. Click **Connect with Twitch** — your browser will open
4. Log in as your **main streaming account** and approve permissions
5. You'll be redirected back automatically

### Step 3 — Connect your bot account

1. Create a second Twitch account for the bot (e.g. `yourname_bot`)
2. In StreamCtl, click **🤖 Connect Bot Account** — your browser will open
3. Log in as the **bot account** and approve permissions
4. In your Twitch chat, type `/mod yourname_bot`

### Step 4 — Go live

1. Click **Save All & Connect**
2. Click **GO LIVE** in the sidebar
3. The activity feed should show "Bot connected!"

---

## OBS Overlay Setup (one time)

1. Make sure the bot is running (GO LIVE is active)
2. In OBS → **Sources → Add → Browser Source**
3. URL: `http://localhost:9000/overlay`
4. Width: **1920**, Height: **1080**
5. Uncheck "Shutdown source when not visible"
6. Click OK — done, never touch it again

Test it by going to the **Overlay** page in StreamCtl and clicking any of the animation test buttons.

---

## Adding Chat Triggers

1. Click **Chat Triggers** in the sidebar
2. Type a keyword and a bot response in the quick add bar at the top
3. Press **Enter** or click **+ Add**
4. Click **⚙** to expand and add a sound file or overlay animation
5. Click **▶ Test** to verify it works before going live

**Variables you can use in responses:**
- `{user}` — the username of the person who triggered it

---

## Adding Sound Redemptions

1. Click **Redemptions** in the sidebar
2. Click **+ Add**
3. Enter the reward name **exactly** as it appears on Twitch
4. Browse for your MP3 file
5. Optionally add a chat message and overlay animation

> Requires Twitch Affiliate or Partner status for Channel Points

---

## Animation Styles

| Style | Effect |
|-------|--------|
| Slide In | Alert box slides in from the right |
| Bounce | Text pops in the center with a bounce |
| Explosion | Text + confetti particle burst |
| Rainbow | Cycling color text animation |

---

## Troubleshooting

**Bot won't connect**
- Make sure you've completed all 3 credential steps
- Check that the bot account is modded in your chat (`/mod botname`)

**Sounds not playing**
- Check the file still exists at the saved path
- Try re-selecting the file via the Browse button

**Overlay not showing in OBS**
- Make sure the bot is running (GO LIVE active)
- Right-click the Browser Source in OBS → Refresh

**Channel points not firing**
- Requires Twitch Affiliate or Partner status
- Reward name must match exactly (case-insensitive)

**OAuth button does nothing / times out**
- Make sure `http://localhost:7878` is set as the redirect URI in your Twitch dev console app

---

## Developer Setup

```bash
# Clone the repo
git clone https://github.com/joseph-malagon/streamctl.git
cd streamctl

# Install dependencies
npm install

# Run in development mode
npm start
```

## Releasing an Update

```bash
# Make your changes, then:
git add .
git commit -m "describe what changed"
git tag v1.x.x
git push && git push --tags
```

GitHub Actions builds the Windows installer automatically and publishes it as a release. The app checks for updates on launch and installs them silently.

---

## Project Structure

```
streamctl/
├── main.js          — Electron main process, IPC handlers, OAuth flow
├── bot.js           — Twitch bot core (chat, polling, token refresh, overlay server)
├── ui/
│   └── index.html   — Control panel UI (all HTML/CSS/JS in one file)
├── overlay/
│   └── overlay.html — OBS browser source (animations via Socket.IO)
├── .github/
│   └── workflows/
│       └── release.yml — GitHub Actions build & publish workflow
└── package.json     — Dependencies and electron-builder config
```
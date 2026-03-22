# OpenSync - Video Sync Extension for Firefox

Watch videos together on PopcornMovies.org! Sync playback across devices just like Teleparty.

## Features

- 🎬 **Synchronized Playback** - Play, pause, and seek sync across all viewers
- 💬 **Real-time Chat** - Chat with friends while watching
- 🔗 **Easy Room Sharing** - 6-character room codes to join
- 🎨 **Modern UI** - Beautiful dark-themed overlay and popup

## Quick Start

### 1. Start the Sync Server

```bash
cd server
npm install
npm start
```

The server will run on `ws://localhost:3000`

### 2. Load the Extension in Firefox

1. Open Firefox and go to `about:debugging`
2. Click **"This Firefox"** in the sidebar
3. Click **"Load Temporary Add-on..."**
4. Navigate to the `OpenSync` folder and select `manifest.json`

### 3. Use OpenSync

1. Navigate to a video on [popcornmovies.org](https://popcornmovies.org)
2. Click the OpenSync extension icon
3. Click **"Create Room"** to start a watch party
4. Share the 6-character room code with friends
5. Friends enter the code and click **"Join"**
6. Enjoy synchronized viewing!

## Project Structure

```
OpenSync/
├── manifest.json          # Extension manifest
├── background.js          # Background script
├── popup/                 # Extension popup UI
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content/               # Content scripts (injected into pages)
│   ├── content.js         # Main orchestration
│   ├── videoController.js # Video player control
│   ├── websocketClient.js # WebSocket sync client
│   ├── overlay.js         # In-page UI overlay
│   └── overlay.css        # Overlay styles
├── lib/
│   └── protocol.js        # Shared message definitions
├── icons/                 # Extension icons
│   ├── icon-48.png
│   └── icon-96.png
└── server/                # WebSocket sync server
    ├── package.json
    └── index.js
```

## Building the Extension Zip

To generate a `.zip` file for uploading to [Firefox Add-ons](https://addons.mozilla.org):

### Steps

1. **Update the version** in both files:
   - `manifest.json` &rarr; `"version": "x.y.z"`
   - `popup/popup.html` &rarr; `<span class="version-badge">vx.y.z</span>`

2. **Run the build script** from the project root:
   ```powershell
   .\build.ps1
   ```
   This produces `OpenSync-vX.Y.Z.zip` containing only the extension files with correct forward-slash paths.

3. **Upload** the zip at https://addons.mozilla.org/developers/addon/submit

### What the build script does

- Reads the version from `manifest.json` automatically
- Verifies the popup HTML version badge matches
- Includes only extension files (`manifest.json`, `background.js`, `content/`, `popup/`, `lib/`, `icons/`)
- Excludes `server/`, `node_modules/`, `test/`, `.git/`, `.gitignore`, `README.md`, `*.zip`, `build.ps1`
- Uses forward-slash paths in the zip (required by Firefox's validator)

### Manual build (without the script)

If you prefer not to use the script, any tool that creates a standard zip with forward-slash paths works. For example, on Linux/macOS:

```bash
zip -r OpenSync-v1.2.0.zip manifest.json background.js content/ popup/ lib/ icons/
```

> **Note:** Do NOT use PowerShell's `Compress-Archive` directly -- it produces backslash paths on Windows which Firefox rejects.

---

## 🌍 Sharing with Friends (Remote Sync)

To watch with friends over the internet, you need to expose your local server and share the extension.

### 1. Expose Server with ngrok

Since the server runs on your computer (`localhost`), friends can't access it directly. Use **ngrok** to create a public link.

1.  Make sure the server is running (`npm start` inside `server/`).
2.  Open a new terminal in `OpenSync/`.
3.  Run:
    ```bash
    ngrok http 3000
    ```
4.  Copy the Forwarding URL (e.g., `https://a1b2-c3d4.ngrok-free.app`). **Note:** Use the `https` link, but you might need to change `https://` to `wss://` in the extension setting if websocket connection fails, though usually modern sockets handle the upgrade. *Actually, just use the domain.*

### 2. Share the Extension

We have packaged the extension for you.

1.  Locate **`OpenSync-Extension.zip`** in this folder.
2.  Send this zip file to your friends.

### 3. Friends' Setup (Firefox)

Your friends need to:

1.  Unzip `OpenSync-Extension.zip`.
2.  Open Firefox and go to `about:debugging`.
3.  Click **"This Firefox"**.
4.  Click **"Load Temporary Add-on..."**.
5.  Select the `manifest.json` file inside the unzipped folder.

### 4. Connect Together

1.  EVERYONE (Host and Friends) opens the **OpenSync Popup**.
2.  In the **Server URL** box, paste the ngrok URL (e.g., `wss://a1b2-c3d4.ngrok-free.app`).
    *   *Tip: Replace `https://` with `wss://` for better compatibility.*
3.  Select your streaming platform (Netflix, etc.).
4.  Host creates a room.
5.  Friends join using the code.

## 📺 Supported Platforms

- **Netflix** (with auto-fix for interruptions)
- **Amazon Prime Video**
- **Disney+ Hotstar**
- **PopcornMovies.org**

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **"Pardon the interruption" (Netflix)** | Ensure you are using the latest version of the extension. Refresh the page. |
| **"Could not connect to server"** | Check if ngrok is running. Ensure you are using `wss://` protocol in the Server URL setting. |
| **Video not syncing** | Click the **Force Sync (🔄)** button in the overlay. |
| **Firefox: "Extension is invalid"** | Make sure you load `manifest.json` from the unzipped folder. |

## License

MIT

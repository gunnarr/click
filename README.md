# Click

A simple web screenshot service. Enter a URL, get a 1280x800 PNG.

Runs on a local server with [Puppeteer](https://pptr.dev/) and is exposed publicly via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

## Features

- **Web UI** — paste a URL, preview the screenshot, download it
- **Bookmarklet** — drag "Click" from the homepage to your bookmark bar, then click it on any page to instantly download a screenshot
- **API** — `GET /shot?url=https://example.com` returns a PNG (add `&dl` to trigger download)
- **Popup dismissal** — automatically closes modals and cookie banners
- **Canvas-aware** — skips overlay removal on pages with `<canvas>` elements (maps, WebGL)

## Setup

```bash
npm install
node server.js
```

The server starts on port 3131.

## API

```
GET /shot?url=<url>         → returns PNG image
GET /shot?url=<url>&dl      → returns PNG with download header
```

## Bookmarklet

Visit the homepage and drag the **Click** button to your bookmark bar. Clicking it on any page will take a screenshot and download it as a PNG.

## Deployment

Designed to run as a `launchd` service on macOS, exposed via `cloudflared`:

```bash
# Start the server
launchctl load ~/Library/LaunchAgents/se.gunnar.webshot.plist

# Start the tunnel
launchctl load ~/Library/LaunchAgents/se.gunnar.cloudflared.plist
```

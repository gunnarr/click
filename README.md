# Click

A simple web screenshot service. Enter a URL, get a PNG in multiple formats.

Runs on a Mac Pro with [Puppeteer](https://pptr.dev/) and is exposed publicly via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) at [click.grj.se](https://click.grj.se).

## Variants

| Page | Size | Description |
|------|------|-------------|
| `/` | 1280×800 | Desktop |
| `/mobile` | 390×844 | iPhone with device frame |
| `/tablet` | 820×1180 | iPad with device frame |
| `/big` | 1720×1410 | Large desktop |
| `/full` | 1280×auto | Full page (entire scrollable height) |
| `/all` | All of the above | Downloads as ZIP |

## Features

- **Web UI** — paste a URL, preview the screenshot, download it
- **Bookmarklets** — each variant has a drag-and-drop bookmarklet for one-click screenshots
- **API** — `GET /shot?url=https://example.com` returns a PNG (add `&dl` to trigger download)
- **Popup dismissal** — automatically closes modals and cookie banners
- **Canvas-aware** — skips overlay removal on pages with `<canvas>` elements (maps, WebGL)
- **Device frames** — mobile and tablet screenshots are wrapped in realistic device mockups

## API

```
GET /shot?url=<url>             → Desktop PNG
GET /shot/mobile?url=<url>      → iPhone PNG with device frame
GET /shot/tablet?url=<url>      → iPad PNG with device frame
GET /shot/big?url=<url>         → Large desktop PNG
GET /shot/full?url=<url>        → Full page PNG
GET /shot/all?url=<url>         → ZIP with all variants
```

Add `&dl` to any endpoint to trigger a download header.

## Setup

```bash
npm install
node server.js
```

The server starts on port 3131.

## Deployment

Designed to run as a `launchd` service on macOS, exposed via `cloudflared`:

```bash
# Start the server
launchctl load ~/Library/LaunchAgents/se.gunnar.webshot.plist

# Start the tunnel
launchctl load ~/Library/LaunchAgents/se.gunnar.cloudflared.plist
```

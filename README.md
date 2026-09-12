# Click

A simple web screenshot service. Enter a URL, get a PNG in multiple formats.

Built on [Puppeteer](https://pptr.dev/) and running at [click.grj.se](https://click.grj.se).

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
GET /health                     → JSON status (200 healthy, 503 degraded)
```

Add `&dl` to any screenshot endpoint to trigger a download header.

## Safety

The service renders arbitrary URLs, so requests are constrained:

- **SSRF protection** — private, loopback, link-local and CGNAT ranges are rejected, both
  for the target URL and for every subresource the page tries to load. Responses that
  arrive from an internal IP anyway (DNS rebinding) discard the screenshot.
- **Rate limit** — 20 requests per IP per 5 minutes.
- **Concurrency limit** — at most 3 screenshots at a time; further requests get a 429.
- The Chrome sandbox is left enabled. Do not add `--no-sandbox`.

## Setup

```bash
npm install     # postinstall downloads the matching Chrome build
npm start
```

The server listens on `127.0.0.1:3131`. Set `HOST=0.0.0.0` to accept connections from
other machines — note that the rate limiter then only trusts the socket address, since
`cf-connecting-ip` can be forged by anything that reaches the port directly.

### Chrome

Puppeteer's own postinstall — the step that downloads Chrome — cannot be relied on,
for two independent reasons:

- npm 11 blocks install scripts from dependencies outright, so it never runs at all.
- On any npm version it only runs when Puppeteer itself is (re)installed. It therefore
  never repairs a browser cache that has been emptied.

The `postinstall` script in this package runs on every `npm install` regardless — npm
only gates dependencies — which is what makes a deploy self-healing. To install or
repair the browser by hand:

```bash
npx puppeteer browsers install chrome
```

Verify the extraction actually completed — it has been observed to exit 0 after
unpacking only part of the archive:

```bash
ls ~/.cache/puppeteer/chrome/*/chrome-mac-*/"Google Chrome for Testing.app"/Contents/Frameworks/
```

If `Frameworks/` is missing, unzip the cached archive manually over the same directory.

## Tests

```bash
npm test
```

Runs the full suite (no browser required — Puppeteer is stubbed).

## Deployment

Runs as a long-lived service behind a reverse proxy that terminates TLS, with the app
bound to loopback. `/health` is intended for an uptime monitor: it returns 503 when the
browser cannot be launched or when the error rate over the last 5 minutes exceeds the
threshold.

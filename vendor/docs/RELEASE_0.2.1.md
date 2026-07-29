# BowEcho Radar Toolbox 0.2.1

## Scope

This patch release isolates byte-range relay requests from full-object cache entries. It protects NCI ZIP-member range extraction when applications use either the bundled Cloudflare Worker or an older deployed relay that still keys cached responses only by request URL.

## Changes

- The SDK adds a deterministic `__bowecho_range` query parameter containing the requested byte range to relay URLs.
- The bundled Worker bypasses Cache API reads and writes for incoming range requests.
- Range upstream subrequests use `cache: "no-store"`, including redirect hops.
- Partial responses preserve `206`, `Accept-Ranges`, `Content-Length`, and `Content-Range`, and return `Cache-Control: no-store`.

## Verification

- `npm test`: SDK, universal-client, relay, and strict TypeScript declaration contracts.
- Relay contracts assert byte-range forwarding, redirected `cache: "no-store"` subrequests, preserved partial-response headers, and zero Cache API access.
- Universal-client contracts assert distinct range-specific relay URLs for both `fetch(url, init)` and `fetch(Request)` forms.
- `npm pack --dry-run`: publish artifact census.

## Install

```bash
npm install https://github.com/FahrenheitResearch/bowecho-radar-toolbox/releases/download/v0.2.1/fahrenheitresearch-bowecho-radar-toolbox-0.2.1.tgz
```

The package is not currently published in the npm registry.

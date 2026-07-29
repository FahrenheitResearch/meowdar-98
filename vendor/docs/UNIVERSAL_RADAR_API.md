# Universal radar API

Use this API when an application should choose a physical radar while BowEcho
handles provider discovery, browser/relay transport, source priority, freshness,
fallback, decoding, rendering, and provenance.

## Five-line path

```js
import { createRadarClient } from "./radar-toolbox.js";

const radar = createRadarClient({ relayUrl: "https://your-relay.example/radar" });
const session = await radar.open("RO:ROBUC", { frames: 3, product: "REF" });
session.draw(document.querySelector("canvas"));
console.log(session.snapshot().provenance);
```

The relay is required when an app promises every supported international
provider. BowEcho still tries direct browser access first wherever upstream
CORS permits it. The included `relay/` Worker is allowlisted and byte-preserving;
provider planning, merge/decompression, WASM decode, products, cuts, and rendering
remain in the visitor's browser.

Keep `radar-toolbox.js`, `global-radar-catalog.js`, `worker.js`, and `pkg/`
together when self-hosting. Package-aware bundlers resolve the worker and WASM
relative to the module.

## Logical sites

Logical IDs describe physical radars rather than upstream object names:
`US:KTLX`, `DE:ASB`, `JP:ITOK`, `EE:EESUR`, and `RO:ROBUC`.

```js
const international = radar.sites({
  live: true,
  source: "international",
  dataClass: "polar-volume",
});

const romanian = radar.sites({ country: "RO" });
const markers = radar.sitesGeoJson({ sources: ["international", "community"] });
const mapboxSource = radar.mapboxSiteSource({ source: "international" });
```

Filters include `query`, `country`/`countries`, `providerId`/`providers`,
`source`/`sources`, `dataClass`, and `live`. Do not infer international coverage
from `countryCode !== "US"`: NEXRAD includes non-US sites and source type is an
explicit catalog field.

`radar.site(id)` resolves a logical ID or a provider-native reference.
`radar.resolve(id)` returns the ordered source plan without downloading data.

## Open and display

```js
const session = await radar.open("IT:DES", {
  frames: 4,
  product: "REF",
  width: 768,
  height: 768,
  rangeKm: 230,
  minimumFrames: 1,
  maxAgeMinutes: 60,
});

session.draw(canvas);
session.setIndex(0);
session.draw(canvas);
```

Provider-specific freshness is applied automatically. Australia NCI is a
delayed archive source and is not rejected by a real-time 60-minute rule.

The session exposes UI discovery without reaching into internal loop objects:

```js
const products = session.productChoices({ availableOnly: true });
const cuts = session.cutChoices({ displayableOnly: true });
const capabilities = session.capabilities();
const timeline = session.timeline();

await session.setProduct(products[0].id);
await session.setCut(cuts[0].index);
session.draw(canvas);
```

Product and cut changes rerender cached decoded volumes; they do not redownload
the radar loop.

## MapLibre or Mapbox

`syncMapLibre` draws the selected frame, creates the canvas source/layer on the
first call, and refreshes it on later calls. Static canvas animation defaults
off, and the helper briefly pulses the source only long enough for the map to
upload changed pixels.

```js
session.syncMapLibre(map, {
  canvas,
  opacity: 0.86,
  beforeId: "place-labels",
  fit: true,
});

session.setIndex(1);
session.syncMapLibre(map, { canvas });
```

Use `session.mapbox({ canvas })` when an application wants only the raw source
and layer specs. `session.textureLayer()` supplies renderer-neutral geometry and
RGBA metadata for deck.gl, WebGL, or WebGPU integrations.

## Polling and failover

```js
const result = await session.poll({ followLatest: true });
if (result.status === "source-changed") {
  console.info(result.previousSourceId, result.sourceId);
}
session.syncMapLibre(map, { canvas });
```

Initial loads and polls preserve every failed/selected attempt in
`session.snapshot().provenance.attempts`. Built-in overlapping Estonia and
Romania sites prefer national sources and fall back to ORD. Applications may
add their own mirrors with `createRadarClient({ sourceBindings: [...] })`.

Resolution failures are typed:

```js
import { isRadarSourceResolutionError } from "./radar-toolbox.js";

try {
  await radar.open("RO:ROBUC");
} catch (error) {
  if (isRadarSourceResolutionError(error)) console.table(error.attempts);
  else throw error;
}
```

## Cache controls

```js
await radar.configureCache({ bytes: 64 * 1024 * 1024, renders: 24 });
console.log(await radar.cacheStats());
await radar.clearCache();
```

Use smaller limits on mobile, clear cached source state when moving between many
stations, and keep loop sizes bounded. The Worker owns byte, decoded-volume,
metadata, render, diagnostics, and analysis caches.

## Full-provider deployment checklist

1. Serve the complete package directory or install the package with its worker
   and `pkg/` assets.
2. Deploy `relay/cloudflare-worker.mjs` with the included `wrangler.jsonc` and
   set `ALLOWED_ORIGINS` to the website origins.
3. Pass the Worker URL as `relayUrl`.
4. Build the UI from `radar.sites()` and open logical IDs; do not reimplement
   provider URL conventions.
5. Show or log `snapshot().provenance` so the selected provider and fallbacks
   remain auditable.
6. Run `npm test` and the optional `tests/live-matrix.html` provider matrix
   before releasing a modified bundle. Retain the dated result alongside the
   harness; `tests/live-matrix-results-2026-07-29.md` is the current baseline.

The catalog currently contains 235 international logical radars represented by
243 bindings across all 14 BowEcho international provider families, plus
NEXRAD and browser-compatible community Level II feeds.

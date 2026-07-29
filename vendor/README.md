# BowEcho Radar Toolbox

Client-side radar toolkit for building fast browser radar apps from BowEcho-derived processing code.

The package exposes a typed JavaScript API, a Web Worker, and a WASM decoder/renderer bundle. Public Level II, community GR2A, and supported international radar feeds are fetched by the end user's browser, decoded in the worker, cached locally, and rendered without server-side radar processing.

## Universal Site API

Version 0.2 adds a provider-independent API above the original provider-specific toolbox. Applications choose one logical physical radar; BowEcho ranks its source bindings, rejects stale or incomplete loops, retries an optional relay, fails over to another upstream, and records the selected source and every failed attempt.

```js
import { createRadarClient } from "./radar-toolbox.js";

const radar = createRadarClient({
  // Optional. Direct browser access remains preferred where CORS works.
  relayUrl: "https://radar-relay.example/radar",
});

const internationalSites = radar.sites({ live: true })
  .filter((site) => site.countryCode !== "US");

const session = await radar.open("DE:ASB", {
  frames: 6,
  product: "REF",
  width: 768,
  height: 768,
});

session.draw(canvas);
console.log(session.snapshot().provenance);

const mapbox = session.mapbox({ canvas, opacity: 0.86 });
map.addSource(mapbox.sourceId, mapbox.source);
map.addLayer(mapbox.layer);
```

Logical IDs are country-prefixed (`US:KTLX`, `DE:ASB`, `JP:ITOK`, `DK:06177`). `radar.site()` also accepts existing `provider:site` references for migration. Existing calls such as `toolbox.loadInternationalLoop("dwd", "asb", options)` are unchanged.

Additional native, mirror, archive, or application-owned bindings can be attached without changing the UI:

```js
const radar = createRadarClient({
  sourceBindings: [{
    logicalSiteId: "DE:ASB",
    id: "my-mirror:asb",
    providerId: "my-mirror",
    providerSiteId: "asb",
    role: "fallback",
    priority: 200,
    access: "relay-required",
    load: ({ options, toolbox }) => toolbox.loadInternationalLoop("dwd", "asb", options),
  }],
});
```

See `examples/universal-international-radar.html` for a dependency-free site picker and `relay/` for the allowlisted, byte-preserving Cloudflare Worker fallback.

## Install Shape

This initial release is packaged as a static browser SDK. Import from `radar-toolbox.js` in a browser app or serve this directory directly while prototyping.

```js
import {
  createRadarToolbox,
  createRadarSession,
  customPollLinksFromGis,
  drawFrameToCanvas,
  fetchSpcEventDay,
  fetchSpcOutlook,
  globalRadarSitesGeoJson,
  nexradArchiveListingUrl,
  recentInternationalFrames,
} from "./radar-toolbox.js";

const toolbox = createRadarToolbox();
const session = createRadarSession(toolbox, {
  site: "KTLX",
  mode: "live",
  product: "REF",
  frameCount: 6,
  width: 768,
  height: 768,
  rangeKm: 230,
});

await session.load({ warmProducts: ["DVEL", "SRV"], concurrency: 4 });
await session.setProduct("DVEL");
await session.setCut(session.cutChoices()[0].index);
drawFrameToCanvas(canvas, session.currentFrame());

const archiveLoop = await toolbox.loadArchiveLoop("KTLX", "2026-06-12", {
  targetTime: "2026-06-12T06:36:00Z",
  frameCount: 8,
  product: "REF",
  width: 768,
  height: 768,
});
drawFrameToCanvas(canvas, archiveLoop.frame(archiveLoop.length - 1));
console.log(nexradArchiveListingUrl("KTLX", "2026-06-12"));

const eventDay = await fetchSpcEventDay("2011-04-27", { includeConsolidated: false });
const outlook = await fetchSpcOutlook(1, "cat", { now: new Date() });
const customLinks = customPollLinksFromGis(gisText, "https://example.test/level2/raw");
const customFeed = toolbox.customPollLinkFeed(customLinks[0]);
```

## What Is Ready

- NEXRAD Level II live, recent, and arbitrary-date archive frame loading, worker/WASM decode, cache warming, product switching, arbitrary displayable tilt selection, and quick loop playback.
- SPC outlook polygon parsing/fetch planning, live/archive issue fallback, convective-day storm report parsing, dated report/WCM tornado-track fetch planning, event radar selection, and archive-window planning for track replay.
- Browser imports for NEXRAD Level II, ODIM_H5, CfRadial 1.x classic netCDF, DORADE sweep, JMA polar radar GRIB2 tar byte buffers, and mobile/research radar ZIP archives.
- Community GR2A `dir.list` feed planning and polling, plus saved custom poll-link normalization, map markers, and GR GIS import helpers.
- Browser-plannable international feeds for SMHI, GeoSphere, SHMU, DWD, CHMI, JMA, EUMETNET ORD, DMI, and FMI.
- Logical global radar IDs, extensible source bindings, direct/relay transport selection, freshness and completeness validation, health cooldowns, automatic failover, and per-loop provenance.
- Map/renderer adapters for canvas, Mapbox/MapLibre, deck.gl, custom WebGL/WebGPU, Web Mercator view state, tile coverage, and radar quad meshes.
- Product/cut capability hints, palette import/export, multi-site synchronized loops, pixel-level compositing, cross sections, native RHI/mobile-scan panels, storm/rotation overlays, TOR tracks, TDS markers, and decoded-volume diagnostics for 3D buffer planning.

## Rules For Generated UIs

- Keep radar fetch/decode/render work client-side unless the user explicitly asks for server processing.
- Use `createRadarSession` for ordinary single-radar controls so product, tilt, cache warming, playback, and live polling share one state machine.
- Use `session.setProduct()` and `session.setCut()` for product/tilt changes; do not reload loops for every control change.
- Use `textureLayer`, `loopTextureLayers`, and the map adapter helpers for full-resolution georeferenced radar imagery.
- Do not implicitly downscale radar pixels. Native RHI defaults to native gate/radial dimensions, and compositing refuses oversized implicit output unless `allowDownscale: true` is explicitly passed.
- Use `npm test` before publishing or handing off a generated UI.

## Examples

The `examples/` directory includes minimal usage, session controls, date archive replay, SPC event planning, cache warming, byte/archive import, map contracts, global source catalogs, community/custom GR2A feeds, international planners, synchronized loops, compositing, palettes, cross sections, native RHI/mobile scans, volume diagnostics, analysis overlays, and TOR tracks.

`examples/dogfood-radar-app.html` is the compact end-to-end app check: clickable NEXRAD map, live/recent/archive loading, product and tilt controls, playback, cache warming, SPC outlook URL planning, and exact-pixel canvas rendering.

The full API contract, AI handoff prompt, parity ledger, and release notes live in this package's `docs/` directory.

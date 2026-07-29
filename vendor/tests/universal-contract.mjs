import assert from "node:assert/strict";
import {
  INTERNATIONAL_RADAR_SITES,
  RadarSourceResolutionError,
  createRadarClient,
  isRadarSourceResolutionError,
  logicalRadarSite,
  logicalRadarSites,
} from "../radar-toolbox.js";

assert.equal(INTERNATIONAL_RADAR_SITES.length, 243);
assert.equal(logicalRadarSites().length, 457);
assert.equal(logicalRadarSite("JP:ITOK")?.country, "Japan");
assert.equal(logicalRadarSite("DK:06177")?.label, "Stevns");
assert.equal(logicalRadarSite("KR:RKSG")?.country, "South Korea");
assert.equal(logicalRadarSite("JP:RODN")?.country, "Japan");
assert.equal(logicalRadarSite("US:RKJK"), null);
assert.equal(logicalRadarSite("FR:FRTRE")?.sources[0]?.access, "relay-required");
assert.equal(logicalRadarSite("FI:FIANJ")?.sources[0]?.access, "either");
assert.equal(logicalRadarSite("AU:2")?.sources[0]?.maxAgeMinutes, 14 * 24 * 60);
assert.equal(logicalRadarSite("IT:BRIC")?.sources[0]?.access, "relay-required");
assert.deepEqual(logicalRadarSite("EE:EESUR")?.sources.map((source) => [source.id, source.role, source.priority]), [
  ["kaia:eesur", "preferred", 50],
  ["ord:eesur", "fallback", 100],
]);
assert.deepEqual(logicalRadarSite("RO:ROBUC")?.sources.map((source) => [source.id, source.role, source.priority]), [
  ["meteoromania:BUC", "preferred", 50],
  ["ord:robuc", "fallback", 100],
]);
assert.equal(logicalRadarSite("US:FWLX")?.sources[0]?.planner, "community");
assert.equal(logicalRadarSite("US:FWLX")?.sources[0]?.access, "relay-required");
assert.equal(logicalRadarSite("US:FWLX")?.capabilities.failover, false);
assert.equal(logicalRadarSites({ providerId: "community-gr2a" }).length, 18);
assert.equal(logicalRadarSite("US:LARE"), null);
const internationalLogicalSites = logicalRadarSites({ source: "international" });
const internationalSourceBindings = internationalLogicalSites.flatMap((site) => site.sources.filter((source) => source.source === "international"));
assert.equal(internationalLogicalSites.length, 235);
assert.equal(internationalSourceBindings.length, 243);
assert.equal(new Set(internationalSourceBindings.map((source) => source.providerId)).size, 14);
assert.equal(internationalSourceBindings.filter((source) => source.access === "relay-required").length, 217);
assert.equal(logicalRadarSite("AU:2")?.capabilities.archiveDelayed, true);
assert.equal(logicalRadarSite("AU:2")?.capabilities.realtime, false);

const loop = (id, volumeTime) => {
  const frame = { id, cacheKey: id, volumeTime, complete: true };
  const rendered = { frame, rgba: new Uint8Array(16), width: 2, height: 2 };
  return {
    length: 1,
    frames: [frame],
    renderedFrames: [rendered],
    frame() { return rendered; },
  };
};

const delayedArchiveClient = createRadarClient({
  toolbox: { loadLoop() {} },
  includeNexrad: false,
  includeInternational: false,
  includeCommunity: false,
  now: () => new Date("2026-07-29T05:00:00Z"),
  extraSites: [{
    id: "AU:DELAYED",
    label: "Delayed archive fixture",
    country: "Australia",
    countryCode: "AU",
    lat: -37,
    lon: 145,
    sources: [{
      id: "delayed-source",
      providerId: "australia-nci",
      providerSiteId: "2",
      maxAgeMinutes: 14 * 24 * 60,
      async load() { return loop("delayed-frame", "2026-07-26T05:00:00Z"); },
    }],
  }],
});
const delayedArchiveSession = await delayedArchiveClient.open("AU:DELAYED", { maxAgeMinutes: 60 });
assert.equal(delayedArchiveSession.provenance.sourceId, "delayed-source");
delayedArchiveSession.destroy();

const nativeFailoverCalls = [];
const nativeFailoverClient = createRadarClient({
  toolbox: {
    loadLoop() {},
    async loadInternationalLoop(providerId, providerSiteId) {
      nativeFailoverCalls.push([providerId, providerSiteId]);
      if (providerId === "kaia") throw new Error("no frames for EESUR");
      return loop("ord-sur-fallback", "2026-07-29T04:58:00Z");
    },
  },
  relayUrl: "https://relay.example/",
  fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
  includeNexrad: false,
  includeCommunity: false,
  now: () => new Date("2026-07-29T05:00:00Z"),
});
const nativeFailoverSession = await nativeFailoverClient.open("EE:EESUR");
assert.deepEqual(nativeFailoverCalls, [["kaia", "eesur"], ["ord", "eesur"]]);
assert.equal(nativeFailoverSession.binding.id, "ord:eesur");
assert.equal(nativeFailoverSession.provenance.providerId, "ord");
assert.deepEqual(nativeFailoverSession.provenance.attempts.map((attempt) => attempt.status), ["failed", "selected"]);
nativeFailoverSession.destroy();

const preprocessingRelayRequests = [];
let preprocessingOptions = null;
const preprocessingRelayClient = createRadarClient({
  toolbox: {
    loadLoop() {},
    async loadInternationalLoop(providerId, providerSiteId, options) {
      assert.equal(providerId, "australia-nci");
      assert.equal(providerSiteId, "2");
      preprocessingOptions = options;
      await options.fetch("https://thredds.nci.example/daily.zip", { headers: { Range: "bytes=0-0" } });
      return loop("nci-delayed-frame", "2026-07-26T05:00:00Z");
    },
  },
  relayUrl: "https://relay.example/",
  fetch: async (url, init) => {
    preprocessingRelayRequests.push([String(url), init?.headers?.Range]);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  },
  includeNexrad: false,
  includeCommunity: false,
  now: () => new Date("2026-07-29T05:00:00Z"),
});
const preprocessingRelaySession = await preprocessingRelayClient.open("AU:2", { maxAgeMinutes: 60 });
assert.equal(preprocessingOptions.prefetchBytes, true);
assert.equal(preprocessingOptions.urlTransform, null);
assert.deepEqual(preprocessingRelayRequests, [[
  "https://relay.example/?url=https%3A%2F%2Fthredds.nci.example%2Fdaily.zip",
  "bytes=0-0",
]]);
assert.equal(preprocessingRelaySession.provenance.transport, "relay");
preprocessingRelaySession.destroy();

const client = createRadarClient({
  toolbox: { loadLoop() {} },
  includeNexrad: false,
  includeInternational: false,
  now: () => new Date("2026-07-29T05:00:00Z"),
  extraSites: [{
    id: "ZZ:TEST",
    label: "Universal test radar",
    country: "Testland",
    countryCode: "ZZ",
    lat: 1,
    lon: 2,
    sources: [
      {
        id: "primary",
        providerId: "fixture",
        providerSiteId: "primary",
        priority: 1,
        async load() { throw new Error("fixture outage"); },
      },
      {
        id: "backup",
        providerId: "fixture",
        providerSiteId: "backup",
        priority: 2,
        async load() { return loop("backup-frame", "2026-07-29T04:58:00Z"); },
      },
    ],
  }],
});

const session = await client.open("ZZ:TEST");
assert.equal(session.binding.id, "backup");
assert.equal(session.provenance.attempts[0].status, "failed");
assert.equal(session.provenance.attempts[1].status, "selected");
assert.equal(session.snapshot().volumeTime, "2026-07-29T04:58:00Z");
session.destroy();

let polledProduct = null;
const velocityLoop = {
  ...loop("velocity-frame", "2026-07-29T04:59:00Z"),
  site: "ZZF",
  product: "VEL",
  cut: 0,
};
const fallbackClient = createRadarClient({
  toolbox: { loadLoop() {} },
  includeNexrad: false,
  includeInternational: false,
  now: () => new Date("2026-07-29T05:00:00Z"),
  extraSites: [{
    id: "ZZ:FALLBACK",
    label: "Product fallback radar",
    country: "Testland",
    countryCode: "ZZ",
    lat: 1,
    lon: 2,
    sources: [{
      id: "fallback-source",
      providerId: "fixture",
      providerSiteId: "fallback",
      priority: 1,
      async load() { return velocityLoop; },
      async poll({ options }) {
        polledProduct = options.product;
        return { status: "idle", loop: velocityLoop };
      },
    }],
  }],
});
const fallbackSession = await fallbackClient.open("ZZ:FALLBACK", { product: "REF", fallbackProducts: ["VEL"] });
assert.equal(fallbackSession.snapshot().product, "VEL");
await fallbackSession.poll();
assert.equal(polledProduct, "VEL");
fallbackSession.destroy();

let semanticLoadAttempts = 0;
const semanticFailureClient = createRadarClient({
  toolbox: { loadLoop() {} },
  relayUrl: "https://relay.example/",
  includeNexrad: false,
  includeInternational: false,
  extraSites: [{
    id: "ZZ:EMPTY",
    label: "Empty source",
    country: "Testland",
    countryCode: "ZZ",
    lat: 1,
    lon: 2,
    sources: [{
      id: "empty-source",
      providerId: "fixture",
      providerSiteId: "empty",
      access: "either",
      priority: 1,
      async load() {
        semanticLoadAttempts += 1;
        throw new Error("no frames for EMPTY");
      },
    }],
  }],
});
await assert.rejects(() => semanticFailureClient.open("ZZ:EMPTY"), (error) => {
  assert.ok(error instanceof RadarSourceResolutionError);
  assert.equal(isRadarSourceResolutionError(error), true);
  assert.equal(error.code, "RADAR_SOURCE_RESOLUTION_FAILED");
  assert.equal(error.site.id, "ZZ:EMPTY");
  assert.equal(error.attempts.length, 1);
  assert.match(error.attempts[0].error, /no frames for EMPTY/);
  return true;
});
assert.equal(semanticLoadAttempts, 1);

let staleLoadAttempts = 0;
const staleFailureClient = createRadarClient({
  toolbox: { loadLoop() {} },
  relayUrl: "https://relay.example/",
  includeNexrad: false,
  includeInternational: false,
  extraSites: [{
    id: "ZZ:STALE",
    label: "Stale source",
    country: "Testland",
    countryCode: "ZZ",
    lat: 1,
    lon: 2,
    sources: [{
      id: "stale-source",
      providerId: "fixture",
      providerSiteId: "stale",
      access: "either",
      priority: 1,
      async load() {
        staleLoadAttempts += 1;
        throw new Error("source latest volume is stale by 47 minutes");
      },
    }],
  }],
});
await assert.rejects(() => staleFailureClient.open("ZZ:STALE"), /source latest volume is stale by 47 minutes/);
assert.equal(staleLoadAttempts, 1);

const transportRequests = [];
const relayRequiredClient = createRadarClient({
  toolbox: { loadLoop() {} },
  relayUrl: "https://relay.example/",
  now: () => new Date("2026-07-29T05:00:00Z"),
  fetch: async (url) => {
    transportRequests.push(String(url));
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  },
  includeNexrad: false,
  includeInternational: false,
  extraSites: [{
    id: "ZZ:RELAY",
    label: "Relay-required test radar",
    country: "Testland",
    countryCode: "ZZ",
    lat: 1,
    lon: 2,
    sources: [{
      id: "relay-source",
      providerId: "fixture",
      providerSiteId: "relay",
      access: "relay-required",
      async load({ options }) {
        await options.fetch("https://upstream.example/volume");
        return loop("relay-frame", "2026-07-29T04:59:00Z");
      },
    }],
  }],
});
const relaySession = await relayRequiredClient.open("ZZ:RELAY");
assert.equal(relaySession.provenance.transport, "relay");
assert.deepEqual(transportRequests, ["https://relay.example/?url=https%3A%2F%2Fupstream.example%2Fvolume"]);
relaySession.destroy();

const cacheCalls = [];
const facadeCalls = [];
const richLoop = {
  ...loop("facade-frame", "2026-07-29T04:59:00Z"),
  site: "FAC",
  product: "REF",
  cut: 0,
  siteDescriptor: { id: "FAC", name: "Facade fixture", lat: 10, lon: 20 },
};
richLoop.renderedFrames[0].imageData = {};
richLoop.renderedFrames[0].renderOptions = { product: "REF", cut: 0 };
const facadeToolbox = {
  loadLoop() {},
  configureCache(options) {
    cacheCalls.push(["configure", options]);
    return Promise.resolve({ bytes: 100 });
  },
  stats() {
    cacheCalls.push(["stats"]);
    return Promise.resolve({ bytes: 100 });
  },
  clearCache() {
    cacheCalls.push(["clear"]);
    return Promise.resolve({ cleared: true });
  },
  productChoices(metaOrLoop, options) {
    facadeCalls.push(["products", metaOrLoop, options]);
    return [{ product: "REF", selected: true }];
  },
  cutChoices(metaOrLoop, options) {
    facadeCalls.push(["cuts", metaOrLoop, options]);
    return [{ index: 0, selected: true }];
  },
  capabilityHints(metaOrLoop, options) {
    facadeCalls.push(["capabilities", metaOrLoop, options]);
    return { type: "bowecho-capability-hints-v1", site: options.site };
  },
  loopTimeline(metaOrLoop, options) {
    facadeCalls.push(["timeline", metaOrLoop, options]);
    return [{ index: 0, current: options.currentIndex === 0 }];
  },
  textureLayer() {
    return {
      bounds: { west: 19, south: 9, east: 21, north: 11 },
      quad: [[19, 11], [21, 11], [21, 9], [19, 9]],
    };
  },
  mapboxCanvasSource(radarLayer, canvas, options) {
    facadeCalls.push(["mapbox-source", radarLayer, canvas, options]);
    return {
      type: "canvas",
      canvas,
      animate: options.animate,
      coordinates: [[19, 11], [21, 11], [21, 9], [19, 9]],
    };
  },
  mapboxRasterLayer(_radarLayer, options) {
    return {
      id: options.layerId,
      type: "raster",
      source: options.sourceId,
      paint: {},
    };
  },
};
const facadeClient = createRadarClient({
  toolbox: facadeToolbox,
  includeNexrad: false,
  includeInternational: false,
  includeCommunity: false,
  now: () => new Date("2026-07-29T05:00:00Z"),
  extraSites: [{
    id: "ZZ:FACADE",
    label: "Facade fixture",
    country: "Testland",
    countryCode: "ZZ",
    dataClass: "mobile-polar",
    lat: 10,
    lon: 20,
    sources: [{
      id: "facade-source",
      providerId: "fixture",
      providerSiteId: "FAC",
      source: "international",
      async load() { return richLoop; },
    }],
  }],
});
assert.deepEqual(facadeClient.sites({ source: "international", dataClass: "mobile-polar" }).map((site) => site.id), ["ZZ:FACADE"]);
assert.equal(facadeClient.sites({ source: "nexrad" }).length, 0);
const facadeGeoJson = facadeClient.sitesGeoJson({ source: "international" });
assert.equal(facadeGeoJson.type, "FeatureCollection");
assert.equal(facadeGeoJson.features[0].properties.dataClass, "mobile-polar");
assert.deepEqual(facadeGeoJson.features[0].geometry.coordinates, [20, 10]);
assert.deepEqual(facadeClient.mapboxSiteSource({ source: "international" }), { type: "geojson", data: facadeGeoJson });
await facadeClient.configureCache({ bytes: 100 });
await facadeClient.cacheStats();
await facadeClient.clearCache();
assert.deepEqual(cacheCalls, [["configure", { bytes: 100 }], ["stats"], ["clear"]]);

const facadeSession = await facadeClient.open("ZZ:FACADE");
assert.equal(facadeSession.productChoices()[0].product, "REF");
assert.equal(facadeSession.cutChoices()[0].index, 0);
assert.equal(facadeSession.capabilities().site, "ZZ:FACADE");
assert.equal(facadeSession.timeline()[0].current, true);
const fakeCanvas = {
  width: 0,
  height: 0,
  getContext() {
    return { imageSmoothingEnabled: true, putImageData() {} };
  },
};
assert.equal(facadeSession.mapbox({ canvas: fakeCanvas }).source.animate, false);
const sourceControllerCalls = [];
const sourceController = {
  setCoordinates(coordinates) { sourceControllerCalls.push(["coordinates", coordinates]); },
  play() { sourceControllerCalls.push(["play"]); },
  pause() { sourceControllerCalls.push(["pause"]); },
};
const mapSources = new Map();
const mapLayers = new Map();
const mapCalls = [];
const fakeMap = {
  getSource(id) { return mapSources.get(id); },
  addSource(id, source) {
    mapCalls.push(["addSource", id, source]);
    mapSources.set(id, sourceController);
  },
  getLayer(id) { return mapLayers.get(id); },
  addLayer(layer, beforeId) {
    mapCalls.push(["addLayer", layer.id, beforeId]);
    mapLayers.set(layer.id, layer);
  },
  triggerRepaint() { mapCalls.push(["repaint"]); },
  fitBounds(bounds, options) { mapCalls.push(["fitBounds", bounds, options]); },
};
const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback) => {
  callback();
  return 1;
};
try {
  const syncResult = facadeSession.syncMapLibre(fakeMap, { canvas: fakeCanvas, fit: true });
  assert.equal(syncResult.frame.frame.id, "facade-frame");
  assert.equal(syncResult.source.animate, false);
  facadeSession.syncMapLibre(fakeMap, { canvas: fakeCanvas });
} finally {
  if (previousRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = previousRequestAnimationFrame;
}
assert.equal(mapCalls.filter(([name]) => name === "addSource").length, 1);
assert.equal(mapCalls.filter(([name]) => name === "addLayer").length, 1);
assert.equal(sourceControllerCalls.filter(([name]) => name === "play").length, 2);
assert.equal(sourceControllerCalls.filter(([name]) => name === "pause").length, 2);
const facadeSnapshot = facadeSession.snapshot();
assert.equal(facadeSnapshot.frame.id, "facade-frame");
assert.equal(facadeSnapshot.capabilities.type, "bowecho-capability-hints-v1");
assert.equal(facadeSnapshot.timeline.length, 1);
facadeSession.destroy();

const pollFailoverClient = createRadarClient({
  toolbox: { loadLoop() {} },
  includeNexrad: false,
  includeInternational: false,
  includeCommunity: false,
  now: () => new Date("2026-07-29T05:00:00Z"),
  extraSites: [{
    id: "ZZ:POLL",
    label: "Poll failover fixture",
    country: "Testland",
    countryCode: "ZZ",
    lat: 1,
    lon: 2,
    sources: [{
      id: "poll-primary",
      providerId: "fixture",
      providerSiteId: "primary",
      priority: 1,
      async load() { return loop("primary-frame", "2026-07-29T04:58:00Z"); },
      async poll() { throw new Error("primary poll outage"); },
    }, {
      id: "poll-backup",
      providerId: "fixture",
      providerSiteId: "backup",
      priority: 2,
      async load() { return loop("backup-frame", "2026-07-29T04:59:00Z"); },
    }],
  }],
});
const pollFailoverSession = await pollFailoverClient.open("ZZ:POLL");
assert.equal(pollFailoverSession.binding.id, "poll-primary");
const pollFailoverResult = await pollFailoverSession.poll();
assert.equal(pollFailoverResult.status, "source-changed");
assert.equal(pollFailoverSession.binding.id, "poll-backup");
assert.deepEqual(pollFailoverResult.provenance.attempts.map((attempt) => [attempt.sourceId, attempt.status]), [
  ["poll-primary", "failed"],
  ["poll-backup", "selected"],
]);
assert.match(pollFailoverResult.provenance.attempts[0].error, /primary poll outage/);
pollFailoverSession.destroy();

console.log("universal-contract ok");

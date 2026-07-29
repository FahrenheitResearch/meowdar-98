import assert from "node:assert/strict";
import {
  INTERNATIONAL_RADAR_SITES,
  createRadarClient,
  logicalRadarSite,
  logicalRadarSites,
} from "../radar-toolbox.js";

assert.equal(INTERNATIONAL_RADAR_SITES.length, 159);
assert.equal(logicalRadarSites().length, 363);
assert.equal(logicalRadarSite("JP:ITOK")?.country, "Japan");
assert.equal(logicalRadarSite("DK:06177")?.label, "Stevns");
assert.equal(logicalRadarSite("KR:RKSG")?.country, "South Korea");
assert.equal(logicalRadarSite("JP:RODN")?.country, "Japan");
assert.equal(logicalRadarSite("US:RKJK"), null);

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
await assert.rejects(() => semanticFailureClient.open("ZZ:EMPTY"), /no frames for EMPTY/);
assert.equal(semanticLoadAttempts, 1);

console.log("universal-contract ok");

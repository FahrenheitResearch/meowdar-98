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

console.log("universal-contract ok");

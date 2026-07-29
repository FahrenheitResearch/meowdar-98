import {
  RadarSourceResolutionError,
  createRadarClient,
  isRadarSourceResolutionError,
  logicalRadarSite,
  type LogicalRadarSiteFeatureCollection,
  type MapLibreMapLike,
  type LogicalRadarSite,
  type RadarSourceAvailability,
  type RadarSourceBinding,
  type UniversalRadarSession,
} from "../radar-toolbox.js";

const site: LogicalRadarSite | null = logicalRadarSite("DE:ASB");
const binding: RadarSourceBinding | undefined = site?.sources[0];
const availability: RadarSourceAvailability | undefined = binding?.metadata.availability;
const realtime: boolean | undefined = site?.capabilities.realtime;

const radar = createRadarClient({
  relayUrl: "https://radar-relay.example/radar",
  sourceBindings: binding ? [{
    ...binding,
    id: "example-fallback",
    logicalSiteId: "DE:ASB",
    role: "fallback",
    priority: 200,
  }] : [],
});

const internationalSites: LogicalRadarSite[] = radar.sites({
  source: "international",
  dataClass: "polar-volume",
  live: true,
});
const markers: LogicalRadarSiteFeatureCollection = radar.sitesGeoJson({ sources: ["international", "community"] });
const markerSource = radar.mapboxSiteSource({ country: ["DE", "FR"] });

declare const canvas: HTMLCanvasElement;
declare const map: MapLibreMapLike;

async function smoke(): Promise<UniversalRadarSession> {
  await radar.configureCache({ bytes: 64 * 1024 * 1024, renders: 24 });
  await radar.cacheStats();
  await radar.clearCache();
  const session = await radar.open("DE:ASB", {
    frames: 4,
    product: "REF",
    maxAgeMinutes: 30,
  });
  session.productChoices({ availableOnly: true });
  session.cutChoices({ displayableOnly: true });
  session.capabilities({ selectedProduct: "REF" });
  session.timeline({ currentIndex: "latest" });
  const specs = session.mapbox({ canvas });
  const synced = session.syncMapLibre(map, { canvas, fit: true, beforeId: "labels" });
  const snapshot = session.snapshot();
  snapshot.frame?.volumeTime;
  snapshot.capabilities?.availableProducts;
  snapshot.timeline[0]?.current;
  specs.source.animate;
  synced.frame.width;
  await session.setProduct("DVEL");
  await session.poll();
  return session;
}

async function typedFailure(): Promise<void> {
  try {
    await radar.open("XX:MISSING");
  } catch (error) {
    if (isRadarSourceResolutionError(error)) {
      const typed: RadarSourceResolutionError = error;
      typed.code;
      typed.site.id;
      typed.attempts[0]?.transport;
    }
  }
}

void availability;
void realtime;
void internationalSites;
void markers;
void markerSource;
void smoke;
void typedFailure;

import {
  createRadarClient,
  logicalRadarSite,
  type LogicalRadarSite,
  type RadarSourceBinding,
  type UniversalRadarSession,
} from "../radar-toolbox.js";

const site: LogicalRadarSite | null = logicalRadarSite("DE:ASB");
const binding: RadarSourceBinding | undefined = site?.sources[0];

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

async function smoke(): Promise<UniversalRadarSession> {
  const session = await radar.open("DE:ASB", {
    frames: 4,
    product: "REF",
    maxAgeMinutes: 30,
  });
  await session.setProduct("DVEL");
  await session.poll();
  return session;
}

void smoke;

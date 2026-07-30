import { createRadarClient, radarOffsetToLonLat } from "./vendor/radar-toolbox.js?v=meowdar98-universal9";

const config = window.MEOWDAR_CONFIG || {};
const ui = Object.fromEntries([
  "loadButton","refreshButton","playButton","countrySelect","siteSearch","siteSelect","siteCode","siteName",
  "productSelect","frameCount","renderSize","providerValue","transportValue","nativeIdValue","volumeValue",
  "receipt","displayTitle","frameLabel","radarCanvas","emptyState","loadingState","loadingCopy","frameSlider",
  "timelineCopy","healthDot","engineStatus","statusLead","catalogCount","mapElement","siteMarkerLayer",
].map((id) => [id, document.getElementById(id)]));

const mapConfig = config.map || {};
const radarSourceId = "meowdar98-global-radar";
const radarLayerId = `${radarSourceId}-layer`;
const nativeRadarLayerId = `${radarSourceId}-native-gates`;
const sitePointSourceId = "meowdar98-radar-sites";
const sitePointLayerId = `${sitePointSourceId}-points`;
const sitePointHitLayerId = `${sitePointSourceId}-hit-targets`;
const sitePillZoom = 4.2;
const compactMobile = window.matchMedia?.("(max-width: 760px)").matches;
const nativePolarEnabled = config.experimentalPolarRenderer !== false;

const client = createRadarClient({
  relayUrl: config.radarRelayUrl || undefined,
  defaults: { frames: 3, product: "REF", fallbackProducts: ["VEL", "CC"], width: 768, height: 768, rangeKm: 230 },
});
const queryParams = new URLSearchParams(location.search);
const requestedFromUrl = queryParams.get("site");
const requestedSiteId = requestedFromUrl ? client.site(requestedFromUrl)?.id || null : null;
const catalogSites = client.sites({ live: true });
// These catalog entries were the only stale/no-current-volume results in the
// exhaustive live audit. This is a safety quarantine, not a permanent denylist:
// lightweight metadata probes below automatically restore a site as soon as it
// has a volume no more than one hour old.
const availabilityAuditWatchlist = new Set([
  "US:TBNA", "US:TMSP",
  "ES:ESAHR",
  "HR:HRBIL", "HR:HRDEB", "HR:HRGRA", "HR:HRPUN", "HR:HRULJ",
  "PL:PLLEG", "SE:LEKSAND",
]);
const availabilityBySite = new Map();
const availabilityMaxAgeMinutes = 60;
const availabilityProbeTimeoutMs = 8000;
const availabilityRefreshIntervalMs = 5 * 60_000;
let realtimeNexradSiteIds = null;
let availabilityRefreshPromise = null;
let session = null;
let loadingSiteId = null;
let loadGeneration = 0;
let lastRequestedSiteId = null;
let sites = selectableCatalogSites();
let visibleSites = [];
let playTimer = null;
let map = null;
let mapReady = false;
let markerUpdateQueued = false;
const sitePills = new Map();
let nativeRadarData = null;
let nativeRadarLayer = null;
let nativeRadarGeneration = 0;
let nativeRadarPreloadGeneration = 0;
let nativeRadarPreloadPromise = null;
const nativeRadarCache = new Map();
const nativeRadarBuilds = new Map();

window.__MEOWDAR98_GLOBAL__ = {
  client,
  get sites() { return sites; },
  get session() { return session; },
  get map() { return map; },
  get nativeRadar() { return window.__MEOWDAR98_NATIVE_RADAR__; },
  get availability() { return Object.fromEntries(availabilityBySite); },
  refreshAvailability: () => refreshLiveAvailability(),
};

initialize();

async function initialize() {
  initializeMap();
  if (compactMobile) {
    // Modern phones use the same three-frame, 768 px fallback as desktop.
    // The visible map uses native gate/radial textures, whose size is dictated
    // by the radar volume rather than this Cartesian safety raster.
    ui.frameCount.value = "3";
    ui.renderSize.value = "768";
    await client.configureCache({
      bytes: 8,
      volumes: 8,
      metadata: 24,
      renders: 24,
      sections: 8,
      nativePpi: 8,
      nativeRhi: 8,
      diagnostics: 8,
      analyses: 8,
      torTracks: 8,
    });
  }
  const countries = [...new Map(sites.map((site) => [site.countryCode, site.country])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1]));
  ui.countrySelect.append(new Option(`All countries (${sites.length})`, ""));
  for (const [code, name] of countries) ui.countrySelect.append(new Option(`${name} (${code})`, code));
  ui.catalogCount.textContent = `${sites.length} selectable radars`;
  ui.countrySelect.addEventListener("change", refreshSiteList);
  ui.siteSearch.addEventListener("input", refreshSiteList);
  ui.siteSelect.addEventListener("change", describeSelectedSite);
  ui.loadButton.addEventListener("click", loadSelectedRadar);
  ui.refreshButton.addEventListener("click", refreshSource);
  ui.playButton.addEventListener("click", togglePlayback);
  ui.frameSlider.addEventListener("input", () => drawFrame(Number(ui.frameSlider.value)));
  ui.productSelect.addEventListener("change", () => { if (session) rerenderProduct(); });
  for (const control of [ui.frameCount, ui.renderSize]) {
    control.addEventListener("change", () => { if (session) loadSelectedRadar(); });
  }
  const requested = requestedFromUrl || config.defaultInternationalSite || "FI:FIANJ";
  const requestedSite = client.site(requested);
  const liveRequestedSite = sites.find((site) => site.id === requestedSite?.id);
  const initial = liveRequestedSite || sites.find((site) => site.id === "FI:FIANJ") || sites[0];
  ui.countrySelect.value = initial?.countryCode || "";
  refreshSiteList(initial?.id);
  createSitePills();
  if (requestedFromUrl && !liveRequestedSite) {
    const label = requestedSite?.id || requestedFromUrl;
    showError(new Error(`${label} is not currently publishing in the realtime inventory. Choose another live radar; archive coverage remains available.`));
  } else if (queryParams.get("autoload") === "1") {
    loadSelectedRadar();
  }
  // Availability discovery is deliberately not awaited: the map, controls,
  // and an explicitly requested healthy site stay interactive while only
  // small listings/HEAD metadata are checked in the background.
  void refreshLiveAvailability();
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshLiveAvailability();
  }, availabilityRefreshIntervalMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshLiveAvailability();
  });
}

function selectableCatalogSites() {
  return catalogSites.filter((site) => {
    const pinned = site.id === loadingSiteId
      || site.id === session?.site?.id
      || (site.id === requestedSiteId && !availabilityBySite.has(site.id));
    if (pinned) return true;
    const watched = availabilityAuditWatchlist.has(site.id);
    if (watched && currentAvailabilityEvidence(site.id)?.status !== "fresh") return false;
    if (!realtimeNexradSiteIds) return true;
    return site.sources.some((source) => source.source !== "nexrad"
      || realtimeNexradSiteIds.has(source.providerSiteId));
  });
}

function reconcileAvailableSites() {
  const preferredId = ui.siteSelect.value;
  const preferredCountry = ui.countrySelect.value;
  sites = selectableCatalogSites();
  const countries = [...new Map(sites.map((site) => [site.countryCode, site.country])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1]));
  ui.countrySelect.replaceChildren(
    new Option(`All countries (${sites.length})`, ""),
    ...countries.map(([code, name]) => new Option(`${name} (${code})`, code)),
  );
  ui.countrySelect.value = countries.some(([code]) => code === preferredCountry) ? preferredCountry : "";
  const hiddenCount = catalogSites.length - sites.length;
  ui.catalogCount.textContent = hiddenCount
    ? `${sites.length} selectable radars · ${hiddenCount} offline/stale`
    : `${sites.length} selectable radars`;
  refreshSiteList(preferredId);
  createSitePills();
  updateSitePointSelection();
}

async function refreshLiveAvailability() {
  if (availabilityRefreshPromise) return availabilityRefreshPromise;
  availabilityRefreshPromise = (async () => {
    const inventoryTask = client.toolbox.nexradRealtimeSiteIds({ timeoutMs: availabilityProbeTimeoutMs })
      .then((ids) => { realtimeNexradSiteIds = new Set(ids); })
      .catch((error) => console.info("Realtime NEXRAD inventory unavailable; retaining the last inventory", error));
    const watchTask = mapWithConcurrency([...availabilityAuditWatchlist], 3, async (siteId) => {
      const evidence = await probeSiteAvailability(client.site(siteId));
      const previous = availabilityBySite.get(siteId);
      let resolved = evidence;
      if (evidence.status === "unknown" && previous?.volumeTime) {
        const agedPrevious = freshnessEvidence(previous.volumeTime);
        if (agedPrevious.status === "fresh") resolved = { ...previous, ...agedPrevious };
      }
      availabilityBySite.set(siteId, { ...resolved, checkedAt: new Date().toISOString() });
    });
    await Promise.all([inventoryTask, watchTask]);
    reconcileAvailableSites();
  })().finally(() => { availabilityRefreshPromise = null; });
  return availabilityRefreshPromise;
}

function currentAvailabilityEvidence(siteId) {
  const evidence = availabilityBySite.get(siteId);
  if (!evidence) return null;
  if (evidence.volumeTime) return { ...evidence, ...freshnessEvidence(evidence.volumeTime) };
  const checkedMillis = Date.parse(String(evidence.checkedAt || ""));
  if (evidence.status === "fresh"
      && (!Number.isFinite(checkedMillis) || Date.now() - checkedMillis > 2 * availabilityRefreshIntervalMs)) {
    return { ...evidence, status: "unknown", reason: "freshness evidence expired" };
  }
  return evidence;
}

async function probeSiteAvailability(site) {
  if (!site?.sources?.length) return { status: "unavailable", reason: "no source bindings" };
  const results = [];
  for (const source of site.sources) {
    const result = source.source === "nexrad"
      ? await probeNexradSource(source)
      : source.source === "international"
        ? await probeInternationalSource(source)
        : { status: "unknown", reason: `no metadata probe for ${source.source}` };
    results.push(result);
    if (result.status === "fresh") return result;
  }
  const unknown = results.find((result) => result.status === "unknown");
  return unknown || results[0] || { status: "unavailable", reason: "no usable source" };
}

async function probeNexradSource(source) {
  const now = new Date();
  const hours = [now, new Date(now.getTime() - 60 * 60_000)];
  const fetchers = [client.fetch, client.relayFetch].filter((fetcher, index, list) =>
    typeof fetcher === "function" && list.indexOf(fetcher) === index);
  let lastError = null;
  for (const fetcher of fetchers) {
    try {
      const frames = [];
      for (const hour of hours) {
        const stamp = `${hour.getUTCFullYear()}${pad2(hour.getUTCMonth() + 1)}${pad2(hour.getUTCDate())}_${pad2(hour.getUTCHours())}`;
        const prefix = `${client.toolbox.nexradArchiveDatePrefix(source.providerSiteId, hour)}${source.providerSiteId}${stamp}`;
        const url = client.toolbox.nexradArchiveListingUrl(source.providerSiteId, hour, { prefix, maxKeys: 1000 });
        const text = await fetchProbeText(fetcher, url);
        frames.push(...client.toolbox.parseNexradArchiveListing(source.providerSiteId, hour, text, { prefix }));
      }
      if (!frames.length) return { status: "unavailable", reason: "no current-hour archive volume" };
      const newest = frames.map((frame) => frame.volumeTime).filter(Boolean).sort().at(-1);
      return freshnessEvidence(newest);
    } catch (error) {
      lastError = error;
    }
  }
  return { status: "unknown", reason: String(lastError?.message || lastError || "NEXRAD metadata probe failed") };
}

async function probeInternationalSource(source) {
  const directFetch = source.access === "relay-required" ? null : client.fetch;
  const fetchers = [directFetch, client.relayFetch].filter((fetcher, index, list) =>
    typeof fetcher === "function" && list.indexOf(fetcher) === index);
  let lastError = null;
  for (const fetcher of fetchers) {
    try {
      const plan = await client.toolbox.latestInternationalFramePlan(source.providerId, source.providerSiteId, {
        fetch: fetcher,
        timeoutMs: availabilityProbeTimeoutMs,
        now: new Date(),
      });
      return freshnessEvidence(plan?.volumeTime);
    } catch (error) {
      lastError = error;
      if (isDefinitiveAvailabilityFailure(error)) {
        return { status: "unavailable", reason: String(error?.message || error) };
      }
    }
  }
  return { status: "unknown", reason: String(lastError?.message || lastError || "international metadata probe failed") };
}

function freshnessEvidence(volumeTime) {
  const volumeMillis = Date.parse(String(volumeTime || ""));
  if (!Number.isFinite(volumeMillis)) return { status: "unknown", reason: "latest volume has no parseable timestamp" };
  const ageMinutes = (Date.now() - volumeMillis) / 60_000;
  if (ageMinutes < -15) return { status: "unknown", reason: `latest volume is ${Math.round(-ageMinutes)} minutes in the future` };
  if (ageMinutes > availabilityMaxAgeMinutes) {
    return { status: "unavailable", reason: `latest volume is stale by ${Math.round(ageMinutes)} minutes`, volumeTime };
  }
  return { status: "fresh", reason: `latest volume is ${Math.max(0, Math.round(ageMinutes))} minutes old`, volumeTime };
}

function isDefinitiveAvailabilityFailure(error) {
  const message = String(error?.message || error);
  return /\bno (?:recent |current |archive )?(?:frames?|volumes?|files?|objects?|sweeps?|date director(?:y|ies)|tarlists?)\b/i.test(message)
    || /\b(?:no frames|no chunks|empty radar loop|latest volume is stale)\b/i.test(message);
}

async function fetchProbeText(fetcher, url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), availabilityProbeTimeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, cache: "no-store" });
    if (!response?.ok) throw new Error(`${response?.status || 0} ${response?.statusText || "metadata fetch failed"}`);
    return response.text();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(workers);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function refreshSiteList(preferredId = "") {
  const country = ui.countrySelect.value;
  const query = ui.siteSearch.value.trim().toLowerCase();
  visibleSites = sites.filter((site) => (!country || site.countryCode === country)
    && (!query || `${site.id} ${site.label} ${site.name} ${site.country}`.toLowerCase().includes(query)));
  ui.siteSelect.replaceChildren(...visibleSites.map((site) => new Option(`${site.id.padEnd(12)} ${site.label}`, site.id)));
  const selected = visibleSites.some((site) => site.id === preferredId) ? preferredId : visibleSites[0]?.id;
  if (selected) ui.siteSelect.value = selected;
  describeSelectedSite();
}

function describeSelectedSite() {
  const site = client.site(ui.siteSelect.value);
  ui.siteCode.textContent = site?.id || "—";
  ui.siteName.textContent = site ? `${site.label} · ${site.country} · ${site.sources.length} source${site.sources.length === 1 ? "" : "s"}` : "No matching radar";
  ui.loadButton.disabled = !site;
  updateSitePillSelection();
}

function createSitePills() {
  ui.siteMarkerLayer.replaceChildren();
  sitePills.clear();
  if (compactMobile) {
    updateSitePillSelection();
    return;
  }
  for (const site of sites) {
    if (!Number.isFinite(Number(site.lon)) || !Number.isFinite(Number(site.lat))) continue;
    const button = document.createElement("button");
    button.type = "button";
    // Keep markers out of the hit-test stack until MapLibre has projected
    // them. Otherwise every unpositioned button overlaps at the origin and a
    // click can select whichever catalog entry was appended last.
    button.className = "site-pill offscreen";
    button.dataset.site = site.id;
    button.setAttribute("aria-label", `Select ${site.id}, ${site.label}`);
    button.title = `${site.id} · ${site.label} · ${site.country}`;
    button.innerHTML = `<i aria-hidden="true"></i><span>${escapeHtml(compactSiteId(site.id))}</span><em>${escapeHtml(site.label)}</em>`;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await selectRadarSite(site);
    });
    ui.siteMarkerLayer.append(button);
    sitePills.set(site.id, button);
  }
  updateSitePillSelection();
  scheduleSitePillPositions();
}

function compactSiteId(siteId) {
  const pieces = String(siteId).split(":");
  return pieces[pieces.length - 1];
}

function updateSitePillSelection() {
  const selected = ui.siteSelect.value;
  sitePills.forEach((button, siteId) => button.classList.toggle("selected", siteId === selected));
  updateSitePointSelection();
}

async function selectRadarSite(site) {
  if (!site || !ui.loadingState.hidden) return;
  ui.siteSearch.value = "";
  ui.countrySelect.value = site.countryCode || "";
  refreshSiteList(site.id);
  map?.flyTo({ center: [site.lon, site.lat], zoom: Math.max(6.2, map.getZoom()), duration: 500 });
  await loadSelectedRadar();
}

function sitePointGeoJson() {
  const selected = ui.siteSelect.value;
  return {
    type: "FeatureCollection",
    features: sites
      .filter((site) => Number.isFinite(Number(site.lon)) && Number.isFinite(Number(site.lat)))
      .map((site) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(site.lon), Number(site.lat)] },
        properties: {
          siteId: site.id,
          selected: site.id === selected,
        },
      })),
  };
}

function updateSitePointSelection() {
  map?.getSource(sitePointSourceId)?.setData?.(sitePointGeoJson());
}

function installSitePointLayers() {
  if (!map || map.getSource(sitePointSourceId)) return;
  map.addSource(sitePointSourceId, { type: "geojson", data: sitePointGeoJson() });
  map.addLayer({
    id: sitePointLayerId,
    type: "circle",
    source: sitePointSourceId,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3.5, 5, 5, 10, 6],
      "circle-color": ["case", ["boolean", ["get", "selected"], false], "#ffff00", "#00b040"],
      "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], "#000080", "#003d16"],
      "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 2.5, 1.25],
    },
  });
  map.addLayer({
    id: sitePointHitLayerId,
    type: "circle",
    source: sitePointSourceId,
    paint: {
      "circle-radius": compactMobile
        ? ["interpolate", ["linear"], ["zoom"], 1, 18, 7, 22]
        : ["interpolate", ["linear"], ["zoom"], 1, 9, 7, 14],
      "circle-color": "#000000",
      "circle-opacity": 0.001,
    },
  });
  map.on("click", sitePointHitLayerId, (event) => {
    const siteId = event.features?.[0]?.properties?.siteId;
    const site = client.site(siteId);
    if (site) void selectRadarSite(site);
  });
  map.on("mouseenter", sitePointHitLayerId, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", sitePointHitLayerId, () => { map.getCanvas().style.cursor = ""; });
}

function scheduleSitePillPositions() {
  if (markerUpdateQueued) return;
  markerUpdateQueued = true;
  requestAnimationFrame(() => {
    markerUpdateQueued = false;
    updateSitePillPositions();
  });
}

function updateSitePillPositions() {
  if (!mapReady || !map) return;
  const rect = ui.mapElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const zoom = Number(map.getZoom());
  const overview = zoom < sitePillZoom;
  const detail = zoom >= 7;
  const selected = ui.siteSelect.value;
  ui.siteMarkerLayer.classList.toggle("detail", detail);
  sitePills.forEach((button, siteId) => {
    if (overview && siteId !== selected) {
      button.classList.add("offscreen");
      return;
    }
    const site = client.site(siteId);
    const point = map.project([site.lon, site.lat]);
    const margin = 70;
    const offscreen = point.x < -margin || point.y < -margin || point.x > rect.width + margin || point.y > rect.height + margin;
    button.classList.toggle("offscreen", offscreen);
    button.style.left = `${point.x}px`;
    button.style.top = `${point.y}px`;
  });
}

async function loadSelectedRadar() {
  const site = client.site(ui.siteSelect.value);
  if (!site) return;
  const generation = ++loadGeneration;
  loadingSiteId = site.id;
  stopPlayback();
  setBusy(true, `Resolving ${site.id}…`);
  try {
    const sourceChanged = lastRequestedSiteId && lastRequestedSiteId !== site.id;
    resetNativeRadar();
    session?.destroy();
    session = null;
    if (compactMobile && sourceChanged) await client.clearCache();
    lastRequestedSiteId = site.id;
    const size = Number(ui.renderSize.value);
    const openedSession = await client.open(site.id, {
      frames: Number(ui.frameCount.value),
      product: ui.productSelect.value,
      width: size,
      height: size,
      rangeKm: 230,
      minimumFrames: 1,
      maxAgeMinutes: 60,
    });
    if (generation !== loadGeneration || ui.siteSelect.value !== site.id) {
      openedSession.destroy();
      return;
    }
    session = openedSession;
    ui.productSelect.value = session.snapshot().product;
    configureTimeline();
    drawFrame(session.length - 1, { fit: true });
    void preloadNativeRadarFrames(session);
    renderReceipt();
    ui.refreshButton.disabled = false;
    ui.playButton.disabled = session.length < 2;
    ui.healthDot.className = "good";
    ui.engineStatus.textContent = "WASM decode verified";
    ui.emptyState.hidden = true;
  } catch (error) {
    if (generation === loadGeneration) {
      showError(error);
      quarantineDefinitivelyUnavailableSite(site, error);
    }
  } finally {
    if (generation === loadGeneration) {
      loadingSiteId = null;
      setBusy(false);
      if (currentAvailabilityEvidence(site.id)?.status === "unavailable") reconcileAvailableSites();
    }
  }
}

async function refreshSource() {
  if (!session) return loadSelectedRadar();
  setBusy(true, `Polling ${session.site.id}…`);
  try {
    const result = await session.poll({ followLatest: true });
    resetNativeRadar();
    configureTimeline();
    drawFrame(session.length - 1);
    void preloadNativeRadarFrames(session);
    renderReceipt();
    ui.statusLead.innerHTML = `<b>${result.status === "source-changed" ? "Failover selected" : result.status === "updated" ? "Updated" : "Current"}</b>`;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

function configureTimeline() {
  ui.frameSlider.max = String(Math.max(0, session.length - 1));
  ui.frameSlider.value = String(Math.max(0, session.length - 1));
  ui.frameSlider.disabled = session.length < 2;
  ui.timelineCopy.textContent = `${session.length} frame${session.length === 1 ? "" : "s"}`;
}

function drawFrame(index, options = {}) {
  if (!session) return;
  session.setIndex(index);
  const frame = session.draw(ui.radarCanvas, index);
  ui.frameSlider.value = String(index);
  const snapshot = session.snapshot();
  ui.displayTitle.textContent = `${snapshot.site.id} · ${snapshot.site.label} · ${productLabel(snapshot.product)}`;
  ui.frameLabel.textContent = snapshot.volumeTime ? new Date(snapshot.volumeTime).toLocaleString([], { timeZone: "UTC", timeZoneName: "short" }) : `Frame ${index + 1}`;
  ui.volumeValue.textContent = snapshot.volumeTime || "Unknown";
  ui.timelineCopy.textContent = `${index + 1} / ${session.length}`;
  ui.emptyState.hidden = true;
  mountRadarMap(index, options);
  scheduleNativeRadarMap(index);
  return frame;
}

async function initializeMap() {
  try {
    await ensureMapLibre();
    map = new window.maplibregl.Map({
      container: ui.mapElement,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [mapConfig.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            maxzoom: Number(mapConfig.maxZoom || 19),
            attribution: mapConfig.attribution || "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm-basemap", type: "raster", source: "osm" }],
      },
      center: [10, 30],
      zoom: 1.7,
      minZoom: 1,
      maxZoom: Math.min(18, Number(mapConfig.maxZoom || 19)),
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
      cooperativeGestures: false,
    });
    map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      mapReady = true;
      map.resize();
      installSitePointLayers();
      scheduleSitePillPositions();
      if (session) {
        mountRadarMap(session.index, { fit: true });
        scheduleNativeRadarMap(session.index);
      }
    });
    map.on("movestart", () => ui.siteMarkerLayer.classList.add("moving"));
    map.on("moveend", () => {
      ui.siteMarkerLayer.classList.remove("moving");
      scheduleSitePillPositions();
    });
    map.on("error", (event) => console.info("Basemap resource error", event?.error || event));
    window.addEventListener("resize", () => { map?.resize(); scheduleSitePillPositions(); });
    if (window.ResizeObserver) new ResizeObserver(() => { map?.resize(); scheduleSitePillPositions(); }).observe(ui.mapElement);
  } catch (error) {
    console.info("OpenStreetMap basemap unavailable", error);
    ui.engineStatus.textContent = "Radar ready · map unavailable";
  }
}

function mountRadarMap(index, options = {}) {
  if (!session || !mapReady || !map) return;
  const specs = session.syncMapLibre(map, {
    canvas: ui.radarCanvas,
    index,
    sourceId: radarSourceId,
    layerId: radarLayerId,
    opacity: 0.84,
    fadeDuration: 0,
    beforeId: map.getLayer(sitePointLayerId) ? sitePointLayerId : undefined,
    fit: Boolean(options.fit),
    fitOptions: { padding: 36, duration: 650, maxZoom: 8 },
  });
  // Keep MapLibre's default linear filter. Its 5.24 nearest path selects an
  // unavailable mipmap for 512/1024 canvas textures and samples a black quad.
  return specs;
}

function scheduleNativeRadarMap(index) {
  const activeSession = session;
  if (!nativePolarEnabled || !activeSession || !mapReady || !map
      || typeof client.toolbox.renderNativePpi !== "function") {
    nativeRadarData = null;
    removeNativeRadarLayer();
    setCartesianRadarVisible(true);
    updateNativeRadarDebug({ status: nativePolarEnabled ? "unsupported" : "disabled" });
    return;
  }

  const renderedFrame = activeSession.frame(index);
  const sourceFrame = renderedFrame?.frame || renderedFrame?.sourceFrame;
  if (!sourceFrame) {
    nativeRadarData = null;
    removeNativeRadarLayer();
    setCartesianRadarVisible(true);
    updateNativeRadarDebug({ status: "fallback", reason: "native source frame unavailable" });
    return;
  }

  const generation = ++nativeRadarGeneration;
  const request = nativeRadarRequest(activeSession, renderedFrame, sourceFrame, index);
  const cached = nativeRadarCache.get(request.key);
  if (cached) {
    activateNativeRadar(cached, generation, activeSession);
    return;
  }

  nativeRadarData = null;
  removeNativeRadarLayer();
  setCartesianRadarVisible(true);
  updateNativeRadarDebug({ status: "building", site: activeSession.site.id, index, key: request.key });
  void getOrBuildNativeRadar(request)
    .then((data) => activateNativeRadar(data, generation, activeSession))
    .catch((error) => {
      if (generation !== nativeRadarGeneration || activeSession !== session) return;
      console.warn("Native gate rendering failed; retaining the Cartesian fallback.", error);
      nativeRadarData = null;
      removeNativeRadarLayer();
      setCartesianRadarVisible(true);
      ui.engineStatus.textContent = "WASM decode verified · raster fallback";
      updateNativeRadarDebug({ status: "fallback", reason: String(error?.message || error) });
    });
}

function nativeRadarRequest(activeSession, renderedFrame, sourceFrame, index) {
  const snapshot = activeSession.snapshot();
  const product = renderedFrame?.renderOptions?.product || snapshot.product || "REF";
  const cutValue = renderedFrame?.renderOptions?.cut
    ?? renderedFrame?.renderOptions?.cutIndex
    ?? snapshot.cut
    ?? 0;
  const cut = Number.isFinite(Number(cutValue)) ? Number(cutValue) : 0;
  let site = activeSession.site;
  try {
    site = activeSession.textureLayer(index)?.site || site;
  } catch {
    // The logical site remains a valid georeference when no texture adapter exists.
  }
  const volumeTime = nativeFrameTime(renderedFrame) || snapshot.volumeTime || `frame-${index}`;
  return {
    activeSession,
    renderedFrame,
    sourceFrame,
    index,
    product,
    cut,
    site,
    key: [nativeRadarPreloadGeneration, activeSession.site.id, volumeTime, product, cut].join("|"),
  };
}

function nativeFrameTime(frame) {
  return frame?.volumeTime
    ?? frame?.timestamp
    ?? frame?.time
    ?? frame?.scanTime
    ?? frame?.metadata?.volumeTime
    ?? frame?.metadata?.timestamp
    ?? frame?.frame?.volumeTime
    ?? frame?.frame?.timestamp
    ?? null;
}

function getOrBuildNativeRadar(request) {
  const cached = nativeRadarCache.get(request.key);
  if (cached) return Promise.resolve(cached);
  const building = nativeRadarBuilds.get(request.key);
  if (building) return building;
  const sessionGeneration = nativeRadarPreloadGeneration;
  const promise = buildNativeRadarData(request).then((data) => {
    if (sessionGeneration === nativeRadarPreloadGeneration && request.activeSession === session) {
      nativeRadarCache.set(request.key, data);
      while (nativeRadarCache.size > Math.max(3, Math.min(8, request.activeSession.length))) {
        nativeRadarCache.delete(nativeRadarCache.keys().next().value);
      }
    }
    return data;
  }).finally(() => nativeRadarBuilds.delete(request.key));
  nativeRadarBuilds.set(request.key, promise);
  return promise;
}

async function buildNativeRadarData(request) {
  if (request.activeSession === session && request.index === session.index) {
    updateNativeRadarDebug({ status: "decoding-gates", startedAt: new Date().toISOString() });
  }
  const native = await client.toolbox.renderNativePpi(request.sourceFrame, {
    product: request.product,
    cut: request.cut,
    rangeKm: 230,
  });
  if (request.activeSession === session && request.index === session.index) {
    updateNativeRadarDebug({ status: "projecting-gates" });
  }
  const meta = native?.meta || {};
  const gateRange = meta.gateRange || meta.native?.gateRange || {};
  const gateCount = Number(native?.width || gateRange.gateCount || 0);
  const radialCount = Number(native?.height || meta.native?.radialCount || 0);
  const firstGateKm = Number(gateRange.firstGateM || 0) / 1000;
  const gateSpacingKm = Number(gateRange.gateSpacingM || 0) / 1000;
  const texture = native?.rgba instanceof Uint8Array
    ? new Uint8Array(native.rgba.buffer, native.rgba.byteOffset, native.rgba.byteLength)
    : new Uint8Array(native?.rgba || []);
  if (!Number.isInteger(gateCount) || gateCount < 1 || !Number.isInteger(radialCount) || radialCount < 1) {
    throw new Error(`invalid native gate geometry ${gateCount}x${radialCount}`);
  }
  if (!Number.isFinite(gateSpacingKm) || gateSpacingKm <= 0) {
    throw new Error(`invalid native gate spacing ${gateSpacingKm}`);
  }
  if (texture.byteLength !== gateCount * radialCount * 4) {
    throw new Error(`native RGBA length ${texture.byteLength} does not match ${gateCount}x${radialCount}`);
  }
  const fullRangeKm = firstGateKm + gateSpacingKm * Math.max(0, gateCount - 0.5);
  const reportedRangeKm = Number(native.rangeKm || meta.rangeKm || fullRangeKm);
  const rangeKm = Math.min(230, Number.isFinite(reportedRangeKm) && reportedRangeKm > 0 ? reportedRangeKm : fullRangeKm);
  if (request.activeSession === session && request.index === session.index) {
    updateNativeRadarDebug({ status: "mapping-azimuths" });
  }
  const azimuthLookup = buildAzimuthLookup(native.azimuths, radialCount);
  if (request.activeSession === session && request.index === session.index) {
    updateNativeRadarDebug({ status: "projecting-mesh" });
  }
  const mesh = buildNativeRadarMesh(request.site, rangeKm);
  return {
    key: request.key,
    texture,
    gateCount,
    radialCount,
    firstGateKm,
    gateSpacingKm,
    rangeKm,
    azimuthLookup,
    mesh,
    meta,
    site: request.site,
    product: request.product,
    cut: request.cut,
    volumeTime: nativeFrameTime(request.renderedFrame),
  };
}

function buildAzimuthLookup(values, radialCount, size = null) {
  const source = values ? Array.from(values) : [];
  if (source.length !== radialCount || radialCount < 2) {
    throw new Error(`native azimuth count ${source.length} does not match ${radialCount} radial rows`);
  }
  const samples = source
    .map((value, row) => ({ angle: normalizeAzimuth(Number(value)), row }))
    .filter((sample) => Number.isFinite(sample.angle))
    .sort((left, right) => left.angle - right.angle);
  if (samples.length !== radialCount) {
    throw new Error(`native azimuth metadata contains ${radialCount - samples.length} non-finite value(s)`);
  }
  const lookupSize = size || Math.max(4096, nextPowerOfTwo(radialCount * 4));
  if (lookupSize > 16384) throw new Error(`native scan has too many radials for an exact azimuth lookup (${radialCount})`);

  const spacings = [];
  for (let index = 0; index < samples.length; index += 1) {
    const next = samples[(index + 1) % samples.length];
    const spacing = normalizeAzimuth(next.angle - samples[index].angle);
    if (spacing > 0.001 && spacing <= 15) spacings.push(spacing);
  }
  spacings.sort((left, right) => left - right);
  const typicalSpacing = spacings.length
    ? spacings[Math.floor(spacings.length * 0.5)]
    : 360 / Math.max(1, samples.length);
  const maximumDistance = Math.max(360 / lookupSize, Math.min(7.5, typicalSpacing * 0.6));
  const bytes = new Uint8Array(lookupSize * 4);

  for (let bin = 0; bin < lookupSize; bin += 1) {
    const angle = (bin + 0.5) * 360 / lookupSize;
    const nearest = nearestAzimuthSample(samples, angle);
    const distance = circularAzimuthDistance(angle, nearest.angle);
    if (distance > maximumDistance || nearest.row > 65535) continue;
    const offset = bin * 4;
    bytes[offset] = nearest.row & 255;
    bytes[offset + 1] = (nearest.row >>> 8) & 255;
    bytes[offset + 3] = 255;
  }
  return { bytes, size: lookupSize, typicalSpacing, validSamples: samples.length };
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value && result < 32768) result *= 2;
  return result;
}

function nearestAzimuthSample(samples, angle) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].angle < angle) low = middle + 1;
    else high = middle;
  }
  const after = samples[low % samples.length];
  const before = samples[(low - 1 + samples.length) % samples.length];
  return circularAzimuthDistance(angle, before.angle) <= circularAzimuthDistance(angle, after.angle) ? before : after;
}

function normalizeAzimuth(value) {
  if (!Number.isFinite(value)) return NaN;
  return ((value % 360) + 360) % 360;
}

function circularAzimuthDistance(left, right) {
  const distance = Math.abs(normalizeAzimuth(left) - normalizeAzimuth(right));
  return Math.min(distance, 360 - distance);
}

function buildNativeRadarMesh(site, rangeKm, divisions = 32) {
  if (!site || !Number.isFinite(Number(site.lat)) || !Number.isFinite(Number(site.lon))) {
    throw new Error("native radar site is missing finite latitude/longitude");
  }
  const positions = [];
  const locals = [];
  const centerX = lonLatToNormalizedMercator(site.lon, site.lat).x;
  const project = (eastKm, northKm) => {
    const lonLat = radarOffsetToLonLat(site, { eastKm, northKm });
    const point = lonLatToNormalizedMercator(lonLat.lon, lonLat.lat);
    if (point.x - centerX > 0.5) point.x -= 1;
    else if (point.x - centerX < -0.5) point.x += 1;
    return point;
  };
  const append = (eastKm, northKm, point) => {
    positions.push(point.x, point.y);
    locals.push(eastKm, northKm);
  };
  const points = [];
  for (let row = 0; row <= divisions; row += 1) {
    const northKm = rangeKm - (2 * rangeKm * row / divisions);
    const pointRow = [];
    for (let column = 0; column <= divisions; column += 1) {
      const eastKm = -rangeKm + (2 * rangeKm * column / divisions);
      pointRow.push(project(eastKm, northKm));
    }
    points.push(pointRow);
  }
  for (let row = 0; row < divisions; row += 1) {
    const north0 = rangeKm - (2 * rangeKm * row / divisions);
    const north1 = rangeKm - (2 * rangeKm * (row + 1) / divisions);
    for (let column = 0; column < divisions; column += 1) {
      const east0 = -rangeKm + (2 * rangeKm * column / divisions);
      const east1 = -rangeKm + (2 * rangeKm * (column + 1) / divisions);
      const p00 = points[row][column];
      const p10 = points[row][column + 1];
      const p01 = points[row + 1][column];
      const p11 = points[row + 1][column + 1];
      append(east0, north0, p00);
      append(east1, north0, p10);
      append(east0, north1, p01);
      append(east1, north0, p10);
      append(east1, north1, p11);
      append(east0, north1, p01);
    }
  }
  return {
    positions: new Float32Array(positions),
    locals: new Float32Array(locals),
    vertexCount: positions.length / 2,
  };
}

function lonLatToNormalizedMercator(lon, lat) {
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, Number(lat)));
  const latitudeRadians = clampedLat * Math.PI / 180;
  return {
    x: (Number(lon) + 180) / 360,
    y: (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2,
  };
}

function activateNativeRadar(data, generation, activeSession) {
  if (!data || generation !== nativeRadarGeneration || activeSession !== session || !mapReady || !map) return;
  nativeRadarData = data;
  if (!ensureNativeRadarLayer()) {
    setCartesianRadarVisible(true);
    updateNativeRadarDebug({ status: "fallback", reason: "could not mount native WebGL layer" });
    return;
  }
  setCartesianRadarVisible(false);
  map.triggerRepaint?.();
  ui.engineStatus.textContent = "Native gate renderer active";
  updateNativeRadarDebug({
    status: "active",
    reason: "",
    site: activeSession.site.id,
    product: data.product,
    cut: data.cut,
    gateCount: data.gateCount,
    radialCount: data.radialCount,
    rangeKm: data.rangeKm,
    azimuthSamples: data.azimuthLookup.validSamples,
    azimuthSpacingDeg: data.azimuthLookup.typicalSpacing,
    source: data.meta?.source || "native-ppi-gates",
  });
}

async function preloadNativeRadarFrames(activeSession) {
  if (!nativePolarEnabled || !activeSession || activeSession !== session || activeSession.length < 2) return;
  if (nativeRadarPreloadPromise) return nativeRadarPreloadPromise;
  const generation = nativeRadarPreloadGeneration;
  nativeRadarPreloadPromise = (async () => {
    for (let index = activeSession.length - 1; index >= 0; index -= 1) {
      if (generation !== nativeRadarPreloadGeneration || activeSession !== session) return;
      if (index === activeSession.index) continue;
      await waitForNativePreloadIdle();
      if (generation !== nativeRadarPreloadGeneration || activeSession !== session) return;
      const renderedFrame = activeSession.frame(index);
      const sourceFrame = renderedFrame?.frame || renderedFrame?.sourceFrame;
      if (!sourceFrame) continue;
      const request = nativeRadarRequest(activeSession, renderedFrame, sourceFrame, index);
      try {
        await getOrBuildNativeRadar(request);
      } catch (error) {
        console.info(`Native gate preload skipped for frame ${index}`, error);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })().finally(() => {
    if (generation === nativeRadarPreloadGeneration) nativeRadarPreloadPromise = null;
  });
  return nativeRadarPreloadPromise;
}

function waitForNativePreloadIdle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 1500 });
    } else {
      setTimeout(resolve, 16);
    }
  });
}

function resetNativeRadar() {
  nativeRadarGeneration += 1;
  nativeRadarPreloadGeneration += 1;
  nativeRadarPreloadPromise = null;
  nativeRadarData = null;
  nativeRadarCache.clear();
  nativeRadarBuilds.clear();
  removeNativeRadarLayer();
  setCartesianRadarVisible(true);
  updateNativeRadarDebug({
    status: "idle",
    reason: "",
    site: "",
    product: "",
    cut: null,
    gateCount: null,
    radialCount: null,
    rangeKm: null,
    azimuthSamples: null,
    azimuthSpacingDeg: null,
    source: "",
  });
}

function updateNativeRadarDebug(update) {
  const current = window.__MEOWDAR98_NATIVE_RADAR__ || {};
  window.__MEOWDAR98_NATIVE_RADAR__ = { ...current, ...update };
  const debug = window.__MEOWDAR98_NATIVE_RADAR__;
  document.body.dataset.nativeRadar = debug.status || "";
  document.body.dataset.nativeRadarReason = debug.reason || "";
  document.body.dataset.nativeRadarGates = Number.isFinite(debug.gateCount) ? String(debug.gateCount) : "";
  document.body.dataset.nativeRadarRadials = Number.isFinite(debug.radialCount) ? String(debug.radialCount) : "";
  document.body.dataset.nativeRadarProduct = debug.product || "";
}

function setCartesianRadarVisible(visible) {
  document.body.dataset.cartesianRadar = visible ? "visible" : "hidden";
  if (!map?.getLayer?.(radarLayerId)) return;
  try {
    map.setPaintProperty(radarLayerId, "raster-opacity", visible ? 0.84 : 0);
  } catch {
    // Layer replacement during a source change is harmless.
  }
}

function ensureNativeRadarLayer() {
  if (!map || !mapReady || !nativeRadarData) return false;
  if (!nativeRadarLayer) nativeRadarLayer = createNativeRadarLayer();
  if (map.getLayer(nativeRadarLayerId)) return true;
  try {
    const beforeId = map.getLayer(sitePointLayerId) ? sitePointLayerId : undefined;
    if (beforeId) map.addLayer(nativeRadarLayer, beforeId);
    else map.addLayer(nativeRadarLayer);
    return true;
  } catch (error) {
    console.warn("Could not add native radar layer.", error);
    if (map.getLayer(nativeRadarLayerId)) map.removeLayer(nativeRadarLayerId);
    nativeRadarLayer = null;
    return false;
  }
}

function removeNativeRadarLayer() {
  if (map?.getLayer?.(nativeRadarLayerId)) map.removeLayer(nativeRadarLayerId);
  nativeRadarLayer = null;
}

function createNativeRadarLayer() {
  return {
    id: nativeRadarLayerId,
    type: "custom",
    renderingMode: "2d",
    program: null,
    positionBuffer: null,
    localBuffer: null,
    polarTexture: null,
    azimuthTexture: null,
    uploadedKey: "",
    locations: null,
    onAdd(_map, gl) {
      const data = nativeRadarData;
      const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (!data || data.gateCount > maximumTextureSize
          || data.radialCount > maximumTextureSize
          || data.azimuthLookup.size > maximumTextureSize) {
        throw new Error("native radar texture exceeds this GPU's maximum texture size");
      }
      const vertexShader = compileNativeRadarShader(gl, gl.VERTEX_SHADER, `
        attribute vec2 a_position;
        attribute vec2 a_local_km;
        uniform mat4 u_matrix;
        varying vec2 v_local_km;
        void main() {
          v_local_km = a_local_km;
          gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
        }
      `);
      const fragmentShader = compileNativeRadarShader(gl, gl.FRAGMENT_SHADER, `
        precision highp float;
        varying vec2 v_local_km;
        uniform sampler2D u_polar;
        uniform sampler2D u_azimuth_rows;
        uniform float u_range_km;
        uniform float u_first_gate_km;
        uniform float u_gate_spacing_km;
        uniform float u_gate_count;
        uniform float u_radial_count;
        uniform float u_opacity;
        const float TWO_PI = 6.283185307179586;
        void main() {
          float range_km = length(v_local_km);
          if (range_km > u_range_km) discard;
          float gate = floor((range_km - u_first_gate_km) / u_gate_spacing_km + 0.5);
          if (gate < 0.0 || gate >= u_gate_count) discard;
          float azimuth = atan(v_local_km.x, v_local_km.y);
          if (azimuth < 0.0) azimuth += TWO_PI;
          vec4 row_code = texture2D(u_azimuth_rows, vec2(azimuth / TWO_PI, 0.5));
          if (row_code.a < 0.5) discard;
          float radial = floor(row_code.r * 255.0 + 0.5)
            + 256.0 * floor(row_code.g * 255.0 + 0.5);
          if (radial < 0.0 || radial >= u_radial_count) discard;
          vec2 uv = vec2((gate + 0.5) / u_gate_count, (radial + 0.5) / u_radial_count);
          vec4 color = texture2D(u_polar, uv);
          if (color.a <= 0.01) discard;
          gl_FragColor = vec4(color.rgb, color.a * u_opacity);
        }
      `);
      this.program = linkNativeRadarProgram(gl, vertexShader, fragmentShader);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      this.positionBuffer = gl.createBuffer();
      this.localBuffer = gl.createBuffer();
      this.polarTexture = gl.createTexture();
      this.azimuthTexture = gl.createTexture();
      this.locations = {
        position: gl.getAttribLocation(this.program, "a_position"),
        local: gl.getAttribLocation(this.program, "a_local_km"),
        matrix: gl.getUniformLocation(this.program, "u_matrix"),
        polar: gl.getUniformLocation(this.program, "u_polar"),
        azimuthRows: gl.getUniformLocation(this.program, "u_azimuth_rows"),
        rangeKm: gl.getUniformLocation(this.program, "u_range_km"),
        firstGateKm: gl.getUniformLocation(this.program, "u_first_gate_km"),
        gateSpacingKm: gl.getUniformLocation(this.program, "u_gate_spacing_km"),
        gateCount: gl.getUniformLocation(this.program, "u_gate_count"),
        radialCount: gl.getUniformLocation(this.program, "u_radial_count"),
        opacity: gl.getUniformLocation(this.program, "u_opacity"),
      };
      uploadNativeRadarTextures(gl, this, data);
    },
    render(gl, matrix) {
      const data = nativeRadarData;
      if (!data || !this.program) return;
      const matrixArray = nativeCustomLayerMatrix(matrix);
      if (!matrixArray) return;
      try {
        gl.useProgram(this.program);
        uploadNativeRadarTextures(gl, this, data);
        uploadNativeRadarMesh(gl, this, data);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.polarTexture);
        gl.uniform1i(this.locations.polar, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.azimuthTexture);
        gl.uniform1i(this.locations.azimuthRows, 1);
        gl.uniformMatrix4fv(this.locations.matrix, false, matrixArray);
        gl.uniform1f(this.locations.rangeKm, data.rangeKm);
        gl.uniform1f(this.locations.firstGateKm, data.firstGateKm);
        gl.uniform1f(this.locations.gateSpacingKm, data.gateSpacingKm);
        gl.uniform1f(this.locations.gateCount, data.gateCount);
        gl.uniform1f(this.locations.radialCount, data.radialCount);
        gl.uniform1f(this.locations.opacity, 0.84);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, data.mesh.vertexCount);
        gl.activeTexture(gl.TEXTURE0);
      } catch (error) {
        queueNativeRadarFallback(error);
      }
    },
    onRemove(_map, gl) {
      if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
      if (this.localBuffer) gl.deleteBuffer(this.localBuffer);
      if (this.polarTexture) gl.deleteTexture(this.polarTexture);
      if (this.azimuthTexture) gl.deleteTexture(this.azimuthTexture);
      if (this.program) gl.deleteProgram(this.program);
      this.program = null;
      this.positionBuffer = null;
      this.localBuffer = null;
      this.polarTexture = null;
      this.azimuthTexture = null;
      this.uploadedKey = "";
    },
  };
}

function uploadNativeRadarTextures(gl, layer, data) {
  if (layer.uploadedKey === data.key) return;
  for (let attempt = 0; attempt < 4 && gl.getError() !== gl.NO_ERROR; attempt += 1) {
    // Clear stale MapLibre errors so the checks below describe these uploads.
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, layer.polarTexture);
  configureNearestTexture(gl);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.gateCount, data.radialCount, 0, gl.RGBA, gl.UNSIGNED_BYTE, data.texture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, layer.azimuthTexture);
  configureNearestTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.azimuthLookup.size, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data.azimuthLookup.bytes);
  gl.activeTexture(gl.TEXTURE0);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`native radar texture upload failed with WebGL error ${error}`);
  layer.uploadedKey = data.key;
}

function queueNativeRadarFallback(error) {
  if (document.body.dataset.nativeRadar === "fallback") return;
  console.warn("Native radar draw failed; restoring the Cartesian fallback.", error);
  document.body.dataset.nativeRadar = "fallback";
  queueMicrotask(() => {
    nativeRadarData = null;
    removeNativeRadarLayer();
    setCartesianRadarVisible(true);
    ui.engineStatus.textContent = "WASM decode verified · raster fallback";
    updateNativeRadarDebug({ status: "fallback", reason: String(error?.message || error) });
  });
}

function configureNearestTexture(gl) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}

function uploadNativeRadarMesh(gl, layer, data) {
  gl.bindBuffer(gl.ARRAY_BUFFER, layer.positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(layer.locations.position);
  gl.vertexAttribPointer(layer.locations.position, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, layer.localBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.mesh.locals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(layer.locations.local);
  gl.vertexAttribPointer(layer.locations.local, 2, gl.FLOAT, false, 0, 0);
}

function nativeCustomLayerMatrix(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value;
  return value?.defaultProjectionData?.mainMatrix
    || value?.modelViewProjectionMatrix
    || value?.matrix
    || value?.projectionMatrix
    || null;
}

function compileNativeRadarShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(shader) || "unknown shader compile failure";
    gl.deleteShader(shader);
    throw new Error(reason);
  }
  return shader;
}

function linkNativeRadarProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const reason = gl.getProgramInfoLog(program) || "unknown shader link failure";
    gl.deleteProgram(program);
    throw new Error(reason);
  }
  return program;
}

async function rerenderProduct() {
  if (!session) return;
  const activeSession = session;
  const generation = ++loadGeneration;
  stopPlayback();
  resetNativeRadar();
  setBusy(true, `Rendering ${productLabel(ui.productSelect.value)}…`);
  try {
    await activeSession.setProduct(ui.productSelect.value, {
      fallbackProducts: ["REF", "VEL", "CC"].filter((product) => product !== ui.productSelect.value),
    });
    if (generation !== loadGeneration || session !== activeSession) return;
    ui.productSelect.value = activeSession.snapshot().product;
    configureTimeline();
    drawFrame(Math.min(activeSession.index, activeSession.length - 1));
    void preloadNativeRadarFrames(activeSession);
    renderReceipt();
    ui.statusLead.innerHTML = `<b>${productLabel(activeSession.snapshot().product)} rendered from cache</b>`;
  } catch (error) {
    if (generation === loadGeneration && session === activeSession) {
      ui.productSelect.value = activeSession.snapshot().product;
      showError(error);
    }
  } finally {
    if (generation === loadGeneration) setBusy(false);
  }
}

async function ensureMapLibre() {
  if (window.maplibregl) return window.maplibregl;
  for (const href of [mapConfig.cssUrl, ...(mapConfig.cssFallbackUrls || [])].filter(Boolean)) {
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.crossOrigin = "anonymous";
      document.head.append(link);
    }
  }
  let lastError = null;
  for (const url of [mapConfig.libraryUrl, ...(mapConfig.libraryFallbackUrls || [])].filter(Boolean)) {
    try {
      await loadScript(url);
      if (window.maplibregl) return window.maplibregl;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not load MapLibre GL JS");
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${url}`));
    document.head.append(script);
  });
}

function renderReceipt() {
  const snapshot = session.snapshot();
  ui.providerValue.textContent = snapshot.provenance.providerId;
  ui.transportValue.textContent = snapshot.provenance.transport;
  ui.nativeIdValue.textContent = snapshot.provenance.providerSiteId;
  ui.receipt.textContent = JSON.stringify({
    logicalSite: snapshot.site.id,
    selectedSource: snapshot.source.id,
    provider: snapshot.provenance.providerId,
    nativeSite: snapshot.provenance.providerSiteId,
    transport: snapshot.provenance.transport,
    selectedAt: snapshot.provenance.selectedAt,
    attempts: snapshot.provenance.attempts,
  }, null, 2);
  ui.statusLead.innerHTML = `<b>${snapshot.provenance.providerId} selected</b>`;
}

function togglePlayback() {
  if (playTimer) return stopPlayback();
  if (!session || session.length < 2) return;
  ui.playButton.textContent = "Ⅱ Pause";
  playTimer = setInterval(() => {
    const next = (Number(ui.frameSlider.value) + 1) % session.length;
    drawFrame(next);
  }, 800);
}

function stopPlayback() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  ui.playButton.textContent = "▶ Play";
}

function setBusy(busy, copy = "") {
  ui.loadingState.hidden = !busy;
  ui.loadingCopy.textContent = copy;
  ui.loadButton.disabled = busy || !ui.siteSelect.value;
  ui.refreshButton.disabled = busy || !session;
  sitePills.forEach((button) => { button.disabled = busy; });
  ui.healthDot.className = busy ? "busy" : ui.healthDot.className;
}

function showError(error) {
  const message = String(error?.message || error);
  const shortMessage = /^all radar sources failed/i.test(message)
    ? "No recent usable volume is available from this radar. Try another nearby site."
    : message.length > 180 ? `${message.slice(0, 177)}\u2026` : message;
  ui.healthDot.className = "bad";
  ui.engineStatus.textContent = "Source failed";
  ui.statusLead.innerHTML = "<b>Load failed</b>";
  ui.providerValue.textContent = "Not loaded";
  ui.transportValue.textContent = "—";
  ui.nativeIdValue.textContent = "—";
  ui.volumeValue.textContent = "—";
  ui.receipt.textContent = JSON.stringify({ error: message, attempts: error?.attempts || [] }, null, 2);
  ui.emptyState.hidden = false;
  ui.emptyState.innerHTML = `<b>Could not load this source</b><span>${escapeHtml(shortMessage)}</span>`;
}

function quarantineDefinitivelyUnavailableSite(site, error) {
  const attempts = Array.isArray(error?.attempts) ? error.attempts.filter((attempt) => attempt?.status === "failed") : [];
  const attemptsBySource = attempts.reduce((groups, attempt) =>
    groups.set(attempt.sourceId, [...(groups.get(attempt.sourceId) || []), attempt]), new Map());
  const definitivelyUnavailable = attemptsBySource.size
    ? [...attemptsBySource.values()].every((sourceAttempts) =>
      sourceAttempts.some((attempt) => isDefinitiveAvailabilityFailure(attempt.error)))
    : isDefinitiveAvailabilityFailure(error);
  if (!site?.id || !definitivelyUnavailable) return;
  availabilityAuditWatchlist.add(site.id);
  availabilityBySite.set(site.id, {
    status: "unavailable",
    reason: String(error?.message || error),
    checkedAt: new Date().toISOString(),
  });
  reconcileAvailableSites();
}

function productLabel(code) {
  return ({ REF: "Reflectivity", VEL: "Velocity", CC: "Correlation coefficient" })[code] || code || "Radar";
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

import { createRadarClient } from "./vendor/radar-toolbox.js?v=meowdar98-universal1";

const config = window.MEOWDAR_CONFIG || {};
const ui = Object.fromEntries([
  "loadButton","refreshButton","playButton","countrySelect","siteSearch","siteSelect","siteCode","siteName",
  "productSelect","frameCount","renderSize","providerValue","transportValue","nativeIdValue","volumeValue",
  "receipt","displayTitle","frameLabel","radarCanvas","emptyState","loadingState","loadingCopy","frameSlider",
  "timelineCopy","healthDot","engineStatus","statusLead","catalogCount",
].map((id) => [id, document.getElementById(id)]));

const client = createRadarClient({
  relayUrl: config.radarRelayUrl || undefined,
  defaults: { frames: 3, product: "REF", width: 768, height: 768, rangeKm: 230 },
});
const sites = client.sites({ live: true });
let visibleSites = [];
let session = null;
let playTimer = null;

window.__MEOWDAR98_GLOBAL__ = { client, sites, get session() { return session; } };

initialize();

function initialize() {
  const countries = [...new Map(sites.map((site) => [site.countryCode, site.country])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1]));
  ui.countrySelect.append(new Option(`All countries (${sites.length})`, ""));
  for (const [code, name] of countries) ui.countrySelect.append(new Option(`${name} (${code})`, code));
  ui.catalogCount.textContent = `${sites.length} live logical radars`;
  ui.countrySelect.addEventListener("change", refreshSiteList);
  ui.siteSearch.addEventListener("input", refreshSiteList);
  ui.siteSelect.addEventListener("change", describeSelectedSite);
  ui.loadButton.addEventListener("click", loadSelectedRadar);
  ui.refreshButton.addEventListener("click", refreshSource);
  ui.playButton.addEventListener("click", togglePlayback);
  ui.frameSlider.addEventListener("input", () => drawFrame(Number(ui.frameSlider.value)));
  for (const control of [ui.productSelect, ui.frameCount, ui.renderSize]) {
    control.addEventListener("change", () => { if (session) loadSelectedRadar(); });
  }
  const requested = new URLSearchParams(location.search).get("site") || config.defaultInternationalSite || "FI:FIANJ";
  const initial = client.site(requested) || client.site("FI:FIANJ") || sites[0];
  ui.countrySelect.value = initial?.countryCode || "";
  refreshSiteList(initial?.id);
  if (new URLSearchParams(location.search).get("autoload") === "1") loadSelectedRadar();
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
}

async function loadSelectedRadar() {
  const site = client.site(ui.siteSelect.value);
  if (!site) return;
  stopPlayback();
  setBusy(true, `Resolving ${site.id}…`);
  try {
    session?.destroy();
    const size = Number(ui.renderSize.value);
    session = await client.open(site.id, {
      frames: Number(ui.frameCount.value),
      product: ui.productSelect.value,
      width: size,
      height: size,
      rangeKm: 230,
      minimumFrames: 1,
      maxAgeMinutes: 60,
    });
    configureTimeline();
    drawFrame(session.length - 1);
    renderReceipt();
    ui.refreshButton.disabled = false;
    ui.playButton.disabled = session.length < 2;
    ui.healthDot.className = "good";
    ui.engineStatus.textContent = "WASM decode verified";
    ui.emptyState.hidden = true;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function refreshSource() {
  if (!session) return loadSelectedRadar();
  setBusy(true, `Polling ${session.site.id}…`);
  try {
    const result = await session.poll({ followLatest: true });
    configureTimeline();
    drawFrame(session.length - 1);
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

function drawFrame(index) {
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
  return frame;
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
  ui.healthDot.className = busy ? "busy" : ui.healthDot.className;
}

function showError(error) {
  ui.healthDot.className = "bad";
  ui.engineStatus.textContent = "Source failed";
  ui.statusLead.innerHTML = "<b>Load failed</b>";
  ui.receipt.textContent = JSON.stringify({ error: String(error?.message || error), attempts: error?.attempts || [] }, null, 2);
  ui.emptyState.hidden = false;
  ui.emptyState.innerHTML = `<b>Could not load this source</b><span>${escapeHtml(String(error?.message || error))}</span>`;
}

function productLabel(code) {
  return ({ REF: "Reflectivity", VEL: "Velocity", CC: "Correlation coefficient" })[code] || code || "Radar";
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [script, styles] = await Promise.all([
  readFile(new URL("../global.js", import.meta.url), "utf8"),
  readFile(new URL("../global.css", import.meta.url), "utf8"),
]);

assert.match(script, /initializeMap\(\);\s*if \(compactMobile\)/, "map initialization must not wait behind inventory I/O");
assert.match(script, /ui\.frameCount\.value = "1"/, "mobile defaults to one frame");
assert.match(script, /ui\.renderSize\.value = "512"/, "mobile defaults to a bounded render texture");
assert.match(script, /compactMobile && sourceChanged[^\n]+clearCache/, "mobile clears prior-station worker state on source changes");
assert.match(script, /session\.syncMapLibre\(map,[\s\S]+fitOptions/, "global app dogfoods the bounded SDK MapLibre refresh helper");
assert.doesNotMatch(script, /animate:\s*true/, "global radar canvas does not keep MapLibre repainting while idle");
assert.match(script, /client\.configureCache\(/, "mobile cache limits use the universal client facade");
assert.match(script, /client\.clearCache\(/, "mobile source changes clear cache through the universal client facade");
assert.match(script, /ui\.productSelect\.addEventListener\("change", \(\) => \{ if \(session\) rerenderProduct\(\); \}\)/, "product changes rerender the loaded volume instead of downloading it again");
assert.match(script, /async function rerenderProduct\([\s\S]+activeSession\.setProduct/, "cached product rerender path is present");
assert.match(script, /if \(compactMobile\) \{\s*updateSitePillSelection\(\);\s*return;/, "mobile skips hundreds of redundant DOM site pills");

assert.match(script, /void refreshLiveAvailability\(\)/, "live availability checks run without blocking the initial UI");
assert.doesNotMatch(script, /await refreshLiveAvailability\(\)/, "initialization must not wait for the availability matrix");
assert.match(script, /mapWithConcurrency\(\[\.\.\.availabilityAuditWatchlist\], 3,/, "metadata probes use bounded concurrency");
assert.match(script, /latestInternationalFramePlan/, "international availability uses planning metadata, not a full decoded volume");
assert.match(script, /nexradArchiveListingUrl/, "NEXRAD freshness uses lightweight archive listings");
assert.match(script, /site\.sources\.some\(\(source\) => source\.source !== "nexrad"/, "a missing NEXRAD source cannot hide a healthy alternate source");
assert.match(script, /availabilityMaxAgeMinutes = 60/, "the selectable-site freshness gate matches the one-hour load gate");
assert.match(script, /attempts\.reduce[\s\S]+attemptsBySource\.values\(\)[\s\S]+sourceAttempts\.some/, "transport attempts are grouped so one authoritative semantic failure can quarantine each source");
assert.ok(script.includes("archive )?(?:frames?"), "actual NEXRAD 'no archive frames' failures are definitive");
assert.match(script, /availabilityAuditWatchlist\.add\(site\.id\)/, "new semantic no-data failures join the runtime recheck set");
assert.match(script, /currentAvailabilityEvidence\(site\.id\)/, "cached freshness evidence is aged against the current clock");
assert.match(script, /site\.id === loadingSiteId[\s\S]+site\.id === session\?\.site\?\.id/, "availability reconciliation pins the loading and displayed radar");
assert.match(script, /generation !== loadGeneration \|\| ui\.siteSelect\.value !== site\.id/, "an obsolete in-flight load cannot replace the newly selected radar");
assert.match(script, /site\.id === requestedSiteId && !availabilityBySite\.has\(site\.id\)/, "a requested watched site remains provisional until its first probe");
for (const siteId of [
  "US:TBNA", "US:TMSP", "ES:ESAHR", "HR:HRBIL", "HR:HRDEB", "HR:HRGRA", "HR:HRPUN", "HR:HRULJ", "PL:PLLEG", "SE:LEKSAND",
]) {
  assert.ok(script.includes(`"${siteId}"`), `${siteId} remains quarantined until a runtime freshness probe passes`);
}
const availabilityProbeBlock = script.slice(script.indexOf("async function refreshLiveAvailability"), script.indexOf("function refreshSiteList"));
assert.doesNotMatch(availabilityProbeBlock, /client\.open\(/, "availability checks must never download and decode full radar volumes");

const mobileBlock = styles.slice(styles.indexOf("@media(max-width:760px)"));
assert.match(mobileBlock, /\.display\{order:-1;/, "the map appears before the long controls on phones");
assert.match(mobileBlock, /\.toolbar\{flex-wrap:wrap;overflow:visible\}/, "the phone toolbar cannot create a horizontal scrollbar");
assert.match(mobileBlock, /\.window-buttons\{display:none\}/, "decorative window buttons do not consume phone width");
assert.match(mobileBlock, /\.toolbar \.chip\{display:none\}/, "the status chip does not overflow the phone toolbar");

console.log("global-mobile-contract ok");

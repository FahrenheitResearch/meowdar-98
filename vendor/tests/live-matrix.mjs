import { createRadarClient } from "../radar-toolbox.js?v=live-matrix-2";

const FAILURE_CLASSES = Object.freeze([
  "unavailable",
  "stale",
  "planner",
  "download",
  "decode",
  "render",
]);
const FAILURE_CLASS_SET = new Set(FAILURE_CLASSES);
const params = new URLSearchParams(location.search);
const providerFilters = parseStringSet(params.get("provider"), (value) => value.toLowerCase());
const countryFilters = parseStringSet(params.get("country"), (value) => value.toUpperCase());
const requestedSites = parseStringSet(params.get("sites"), (value) => value.toUpperCase());
const requestedSourceId = String(params.get("source") || "").trim().toLowerCase();
const requestedSourceProvider = String(params.get("sourceProvider") || "").trim().toLowerCase();
const timeoutMs = boundedNumber(params.get("timeout"), 45_000, 5_000, 300_000);
const frameCount = boundedInteger(params.get("frames"), 1, 1, 3);
const renderSize = boundedInteger(params.get("size"), 256, 64, 1_024);
const rangeKm = boundedNumber(params.get("rangeKm"), 230, 10, 1_000);
const fallbackProducts = parseFallbackProducts(params.get("fallback"));
const strictRef = fallbackProducts.length === 0;
const maxAgeMinutes = parseMaximumAge(params.get("maxAge"));
const requireVolumeTime = queryBoolean("requireTime", true);
const clearCacheBetweenCases = queryBoolean("clearCache", queryBoolean("clear", true));
const collectCacheStats = queryBoolean("cacheStats", false);
const limit = boundedInteger(params.get("limit"), 0, 0, 100_000);
const shardCount = boundedInteger(params.get("shards"), 1, 1, 1_000);
const shardIndex = boundedInteger(params.get("shard"), 0, 0, shardCount - 1);
const requestedScope = String(params.get("scope") || "both").trim().toLowerCase();
const scope = new Set(["logical", "sources", "both"]).has(requestedScope) ? requestedScope : "both";
const relayParameter = params.get("relay");
const relayUrl = /^(?:0|false|off|none)$/i.test(String(relayParameter || "").trim())
  ? null
  : relayParameter || "https://meowdar-98-radar-relay.copy-leo.workers.dev/";

const summary = document.getElementById("summary");
const resultsElement = document.getElementById("results");
const copyButton = document.getElementById("copy-report");
const canvas = document.getElementById("render");
if (!summary || !resultsElement || !canvas) throw new Error("live matrix page is missing its report or render elements");

const client = createRadarClient({
  relayUrl,
  defaults: {
    frames: frameCount,
    product: "REF",
    fallbackProducts,
    width: renderSize,
    height: renderSize,
    rangeKm,
    maxAgeMinutes,
  },
});

const allLiveSites = client.sites({ live: true });
const knownSiteIds = new Set(allLiveSites.map((site) => site.id.toUpperCase()));
const knownProviders = new Set(allLiveSites.flatMap((site) => site.sources.map((source) => source.providerId.toLowerCase())));
const knownCountries = new Set(allLiveSites.map((site) => site.countryCode.toUpperCase()));
const selfChecks = runClassifierSelfChecks();

let selectedSites = allLiveSites
  .filter((site) => !providerFilters.size || site.sources.some((source) => providerFilters.has(source.providerId.toLowerCase())))
  .filter((site) => !countryFilters.size || countryFilters.has(site.countryCode.toUpperCase()))
  .filter((site) => !requestedSites.size || requestedSites.has(site.id.toUpperCase()))
  .filter((site) => !requestedSourceId || site.sources.some((source) => source.id.toLowerCase() === requestedSourceId))
  .filter((site) => !requestedSourceProvider || site.sources.some((source) => source.providerId.toLowerCase() === requestedSourceProvider))
  .sort((left, right) => left.id.localeCompare(right.id));
const filteredSiteCount = selectedSites.length;
if (shardCount > 1) selectedSites = selectedSites.filter((_, index) => index % shardCount === shardIndex);
if (limit) selectedSites = selectedSites.slice(0, limit);

const cases = selectedSites.flatMap(buildCasesForSite);
const selectionErrors = [];
for (const siteId of requestedSites) {
  if (!knownSiteIds.has(siteId)) selectionErrors.push(`unknown requested logical site '${siteId}'`);
}
for (const providerId of providerFilters) {
  if (!knownProviders.has(providerId)) selectionErrors.push(`unknown provider filter '${providerId}'`);
}
for (const countryCode of countryFilters) {
  if (!knownCountries.has(countryCode)) selectionErrors.push(`unknown country filter '${countryCode}'`);
}
if (requestedSourceId && !allLiveSites.some((site) => site.sources.some((source) => source.id.toLowerCase() === requestedSourceId))) {
  selectionErrors.push(`unknown source binding '${requestedSourceId}'`);
}
if (requestedSourceProvider && !knownProviders.has(requestedSourceProvider)) {
  selectionErrors.push(`unknown source provider '${requestedSourceProvider}'`);
}
if (!cases.length) selectionErrors.push("filters selected zero test cases");
if (!selfChecks.passed) selectionErrors.push("built-in failure-classifier self-check failed");

const report = {
  type: "meowdar-live-matrix-v2",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  selfChecks,
  filters: {
    providers: [...providerFilters],
    countries: [...countryFilters],
    sites: [...requestedSites],
    sourceId: requestedSourceId || null,
    sourceProvider: requestedSourceProvider || null,
    scope,
    limit,
    shardCount,
    shardIndex,
  },
  pipeline: {
    requestedProduct: "REF",
    strictRef,
    fallbackProducts,
    frameCount,
    renderSize,
    rangeKm,
    timeoutMs,
    maxAgeMinutes,
    requireVolumeTime,
    forceProbe: true,
    clearCacheBetweenCases,
    collectCacheStats,
    relayConfigured: Boolean(relayUrl),
  },
  selection: {
    catalogLiveSites: allLiveSites.length,
    filteredSitesBeforeShard: filteredSiteCount,
    selectedSites: selectedSites.length,
    totalCases: cases.length,
    selectionErrors,
  },
  total: cases.length,
  completed: 0,
  passed: 0,
  failed: 0,
  failureCounts: emptyFailureCounts(),
  attemptFailureCounts: emptyFailureCounts(),
  warnings: [],
  cache: {
    initial: null,
    final: null,
    finalClear: null,
  },
  results: [],
};

globalThis.__MEOWDAR_LIVE_MATRIX__ = report;
copyButton?.addEventListener("click", copyReport);
renderReport(true);
void run().catch(finishFatally);

async function run() {
  if (collectCacheStats) report.cache.initial = await safelyReadCacheStats();

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    summary.textContent = `Testing ${index + 1}/${report.total}: ${testCase.caseId}`;
    const result = await runCase(testCase);
    recordResult(result);
    renderReport();
  }

  if (collectCacheStats) report.cache.final = await safelyReadCacheStats();
  if (clearCacheBetweenCases) {
    try {
      await client.toolbox.clearCache();
      report.cache.finalClear = { ok: true };
    } catch (error) {
      report.cache.finalClear = { ok: false, error: errorMessage(error) };
      report.warnings.push(`final cache clear failed: ${errorMessage(error)}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.failed === 0 && report.selection.selectionErrors.length === 0;
  summary.textContent = finalSummary();
  document.body.dataset.complete = "true";
  document.body.dataset.ok = String(report.ok);
  renderReport(true);
}

async function runCase(testCase) {
  const started = performance.now();
  const testedAt = new Date();
  const logicalSources = describeLogicalSources(testCase.site);
  const base = {
    caseId: testCase.caseId,
    testKind: testCase.testKind,
    siteId: testCase.site.id,
    siteLabel: testCase.site.label,
    country: testCase.site.country,
    countryCode: testCase.site.countryCode,
    requestedSourceId: testCase.sourceId,
    requestedSourceRole: testCase.sourceRole,
    logicalSources,
    eligibleSources: [],
    testedAt: testedAt.toISOString(),
  };
  const controller = new AbortController();
  let timer;
  let phase = "cache";
  let session;
  let snapshot;
  let cacheBefore = null;
  let cacheAfter = null;
  let cacheClear = { requested: clearCacheBetweenCases, ok: null };

  if (collectCacheStats) cacheBefore = await safelyReadCacheStats();
  if (clearCacheBetweenCases) {
    try {
      await client.toolbox.clearCache();
      cacheClear = { requested: true, ok: true };
    } catch (error) {
      cacheClear = { requested: true, ok: false, error: errorMessage(error) };
      report.warnings.push(`${testCase.caseId}: pre-case cache clear failed: ${errorMessage(error)}`);
    }
  }

  try {
    const sourceOptions = testCase.sourceId ? { sourceId: testCase.sourceId } : {};
    phase = "planner";
    const resolution = client.resolve(testCase.site.id, { ...sourceOptions, forceProbe: true });
    base.eligibleSources = resolution.sources.map((source) => source.id);
    if (!resolution.sources.length) throw new HarnessFailure("planner", "resolution plan contains no eligible sources");

    phase = "download-decode";
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException(`Timed out after ${timeoutMs} ms`, "TimeoutError");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    session = await Promise.race([
      client.open(testCase.site.id, {
        ...sourceOptions,
        frames: frameCount,
        product: "REF",
        fallbackProducts,
        width: renderSize,
        height: renderSize,
        rangeKm,
        minimumFrames: 1,
        maxAgeMinutes,
        signal: controller.signal,
        forceProbe: true,
      }),
      timeout,
    ]);
    clearTimeout(timer);
    timer = undefined;

    phase = "render-validation";
    const frame = session.frame();
    if (!frame || !ArrayBuffer.isView(frame.rgba) || frame.rgba.length !== frame.width * frame.height * 4) {
      const rgbaType = frame?.rgba?.constructor?.name || typeof frame?.rgba;
      throw new HarnessFailure(
        "render",
        `decoded frame has no complete RGBA render (rgba=${rgbaType}:${frame?.rgba?.length}, size=${frame?.width}x${frame?.height})`,
      );
    }

    snapshot = session.snapshot();
    const actualProduct = normalizeProduct(snapshot.product || frame.renderOptions?.product);
    if (strictRef && actualProduct !== "REF") {
      throw new HarnessFailure("planner", `strict REF request selected '${actualProduct || "unknown"}'`);
    }

    const volumeTime = snapshot.volumeTime || frame.frame?.volumeTime || frame.meta?.volumeTime || null;
    const volumeAgeMinutes = ageMinutes(volumeTime, testedAt);
    const freshnessPolicy = describeFreshnessPolicy(snapshot.source, maxAgeMinutes, volumeAgeMinutes);
    if (requireVolumeTime && !Number.isFinite(volumeAgeMinutes)) {
      throw new HarnessFailure("planner", "selected live frame has no parseable volume time");
    }
    if (freshnessPolicy.effectiveMaxAgeMinutes !== null
      && Number.isFinite(volumeAgeMinutes)
      && volumeAgeMinutes > freshnessPolicy.effectiveMaxAgeMinutes) {
      throw new HarnessFailure("stale", `selected volume is stale by ${roundOne(volumeAgeMinutes)} minutes`);
    }

    const frameBytes = byteView(frame.rgba);
    const frameChecksum = checksum(frameBytes);
    session.draw(canvas);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new HarnessFailure("render", "canvas 2D context is unavailable");
    const canvasBytes = context.getImageData(0, 0, frame.width, frame.height).data;
    const canvasChecksum = checksum(canvasBytes);
    if (frameChecksum !== canvasChecksum) {
      throw new HarnessFailure("render", `canvas checksum ${canvasChecksum} does not match RGBA checksum ${frameChecksum}`);
    }

    const attempts = normalizeAttempts(snapshot.provenance?.attempts, logicalSources);
    const chosen = describeChosenSource(snapshot.source, logicalSources, attempts, Boolean(testCase.sourceId));
    if (collectCacheStats) cacheAfter = await safelyReadCacheStats();
    return {
      ...base,
      status: "passed",
      durationMs: Math.round(performance.now() - started),
      requestedProduct: "REF",
      product: actualProduct,
      productFallbackUsed: actualProduct !== "REF",
      volumeTime,
      volumeAgeMinutes: Number.isFinite(volumeAgeMinutes) ? roundOne(volumeAgeMinutes) : null,
      freshnessPolicy,
      frames: snapshot.length,
      chosenSource: chosen,
      transport: snapshot.provenance?.transport || null,
      attempts,
      pipelineEvidence: {
        forceProbe: true,
        workerCacheClearedBeforeCase: cacheClear.ok === true,
        transport: snapshot.provenance?.transport || null,
        sourceDownloadCompleted: true,
        wasmDecodeAndRenderCompleted: true,
        rgbaType: frame.rgba.constructor?.name || null,
        rgbaBytes: frameBytes.byteLength,
        rgbaChecksum: frameChecksum,
        canvasChecksum,
        canvasDrawVerified: true,
        nonTransparentPixels: countNonTransparentPixels(frameBytes),
        totalPixels: frame.width * frame.height,
        width: frame.width,
        height: frame.height,
        frameCacheHit: Boolean(frame.cacheHit),
        renderElapsedMs: Number.isFinite(Number(frame.elapsedMs)) ? Number(frame.elapsedMs) : null,
      },
      cache: { before: cacheBefore, after: cacheAfter, clear: cacheClear },
    };
  } catch (error) {
    const rawAttempts = Array.isArray(error?.attempts)
      ? error.attempts
      : snapshot?.provenance?.attempts || [];
    const attempts = normalizeAttempts(rawAttempts, logicalSources);
    const failureClass = classifyFailure(error, phase, attempts);
    const failureClasses = [...new Set([
      failureClass,
      ...attempts.map((attempt) => attempt.failureClass).filter(Boolean),
    ])];
    const chosen = snapshot
      ? describeChosenSource(snapshot.source, logicalSources, attempts, Boolean(testCase.sourceId))
      : null;
    if (collectCacheStats) cacheAfter = await safelyReadCacheStats();
    return {
      ...base,
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      phase,
      failureClass,
      failureClasses,
      errorName: String(error?.name || "Error"),
      error: errorMessage(error),
      reportedStaleAgeMinutes: staleAgeFromMessage(errorMessage(error)),
      chosenSource: chosen,
      transport: snapshot?.provenance?.transport || null,
      attempts,
      cache: { before: cacheBefore, after: cacheAfter, clear: cacheClear },
    };
  } finally {
    clearTimeout(timer);
    session?.destroy();
  }
}

function buildCasesForSite(site) {
  const sources = describeLogicalSources(site);
  if (requestedSourceId) {
    const source = sources.find((candidate) => candidate.id.toLowerCase() === requestedSourceId);
    return source ? [sourceCase(site, source)] : [];
  }
  if (requestedSourceProvider) {
    return sources
      .filter((source) => source.providerId.toLowerCase() === requestedSourceProvider)
      .map((source) => sourceCase(site, source));
  }
  if (scope === "sources") return sources.map((source) => sourceCase(site, source));

  const logicalCase = {
    caseId: site.id,
    testKind: "logical-failover",
    site,
    sourceId: null,
    sourceRole: "automatic",
  };
  if (scope === "logical") return [logicalCase];
  return [logicalCase, ...sources.filter((source) => source.role === "fallback").map((source) => sourceCase(site, source))];
}

function sourceCase(site, source) {
  return {
    caseId: `${site.id}@${source.id}`,
    testKind: "source-binding",
    site,
    sourceId: source.id,
    sourceRole: source.role,
  };
}

function describeLogicalSources(site) {
  return [...site.sources]
    .sort((left, right) => sourcePriority(left) - sourcePriority(right) || left.id.localeCompare(right.id))
    .map((source, index) => ({
      rank: index + 1,
      role: index === 0 ? "primary" : "fallback",
      id: source.id,
      providerId: source.providerId,
      providerSiteId: source.providerSiteId,
      priority: source.priority,
      access: source.access,
      planner: source.planner || source.source || null,
      maxAgeMinutes: finiteNumberOrNull(source.maxAgeMinutes),
      availability: source.metadata?.availability || null,
      typicalDelayDays: finiteNumberOrNull(source.metadata?.typicalDelayDays),
    }));
}

function describeChosenSource(source, logicalSources, attempts, selectionWasPinned) {
  if (!source) return null;
  const logical = logicalSources.find((candidate) => candidate.id === source.id) || null;
  const selectedAttemptIndex = attempts.findIndex((attempt) => attempt.status === "selected");
  return {
    id: source.id,
    providerId: source.providerId,
    providerSiteId: source.providerSiteId,
    rank: logical?.rank ?? null,
    role: logical?.role || "unknown",
    selectionWasPinned,
    logicalFallbackUsed: logical?.role === "fallback",
    transportFallbackUsed: selectedAttemptIndex > 0,
    maxAgeMinutes: finiteNumberOrNull(source.maxAgeMinutes),
    availability: source.metadata?.availability || null,
    typicalDelayDays: finiteNumberOrNull(source.metadata?.typicalDelayDays),
  };
}

function normalizeAttempts(rawAttempts, logicalSources) {
  return (Array.isArray(rawAttempts) ? rawAttempts : []).map((attempt, index) => {
    const logical = logicalSources.find((source) => source.id === attempt.sourceId) || null;
    const failed = attempt.status !== "selected";
    return {
      index: index + 1,
      sourceId: attempt.sourceId || null,
      sourceRank: logical?.rank ?? null,
      sourceRole: logical?.role || null,
      transport: attempt.transport || null,
      status: attempt.status || (failed ? "failed" : null),
      durationMs: Number.isFinite(Number(attempt.durationMs)) ? Number(attempt.durationMs) : null,
      failureClass: failed ? classifyMessage(attempt.error, "download-decode") : null,
      error: failed ? String(attempt.error || "unknown source failure") : null,
      reportedStaleAgeMinutes: failed ? staleAgeFromMessage(attempt.error) : null,
    };
  });
}

function classifyFailure(error, phase, attempts = []) {
  if (FAILURE_CLASS_SET.has(error?.failureClass)) return error.failureClass;
  const failedAttempts = attempts.filter((attempt) => attempt.status !== "selected" && attempt.failureClass);
  if (failedAttempts.length) return failedAttempts[failedAttempts.length - 1].failureClass;
  return classifyMessage(`${error?.name || "Error"}: ${errorMessage(error)}`, phase);
}

function classifyMessage(value, phase = "") {
  const message = String(value?.message || value || "").trim().toLowerCase();
  if (/\bstale\b|\btoo old\b|\bexceeds? (?:the )?max(?:imum)? age\b/.test(message)) return "stale";
  if (/(?:strict|requested|complete|available|select(?:ed|ion)).{0,30}\bref\b|\bref\b.{0,30}(?:cycle|moment|product|scan)/.test(message)) return "planner";
  if (/\bno (?:archive )?frames?\b|\bno (?:current|recent|available) (?:radar )?(?:files?|volumes?|data)\b|\bempty radar loop\b|\bincomplete radar volume\b|\bno displayable cuts\b|\bno eligible source\b|\brequires? a configured relay\b/.test(message)) return "unavailable";
  if (/\brgba\b|\bcanvas\b|\bimagedata\b|\bpixel\b|\brender(?:ed|ing)?\b|\btexture\b/.test(message)) return "render";
  if (/\bdecode\b|\bwasm\b|\binvalid message\b|\bunsupported (?:object|header|format|layout)\b|\bobject header version\b|\bhdf5\b|\bodim\b|\bbufr\b|\bgzip\b|\bbzip\b|\bmalformed\b|\bcorrupt\b/.test(message)) return "decode";
  if (/\bfailed to fetch\b|\bfetch failed\b|\bnetworkerror\b|\bcors\b|\btimeout\b|\btimed out\b|\babort(?:ed|error)?\b|\bhttp\b|\b[45]\d\d\s+(?:bad|forbidden|not found|server|service|gateway)\b|\brelay\b/.test(message)) return "download";
  if (/\bplan(?:ner|ning)?\b|\bresolution\b|\binventory\b|\bmanifest\b|\bcatalog\b|\blisting\b|\bunknown logical radar site\b|\bobject key\b/.test(message)) return "planner";
  if (phase === "planner" || phase === "selection") return "planner";
  if (phase === "render-validation" || phase === "draw") return "render";
  return "download";
}

function runClassifierSelfChecks() {
  const cases = [
    ["no frames for radar TEST", "download-decode", "unavailable"],
    ["source latest volume is stale by 91 minutes", "download-decode", "stale"],
    ["no complete REF cycle could be selected", "download-decode", "planner"],
    ["Failed to fetch", "download-decode", "download"],
    ["invalid message at offset 42: unsupported object header", "download-decode", "decode"],
    ["canvas checksum does not match RGBA checksum", "render-validation", "render"],
  ].map(([message, phase, expected]) => {
    const actual = classifyMessage(message, phase);
    return { message, expected, actual, passed: actual === expected };
  });
  const delayedArchivePolicy = describeFreshnessPolicy({
    maxAgeMinutes: 14 * 24 * 60,
    metadata: { availability: "archive-delayed", typicalDelayDays: 3 },
  }, 60, 3 * 24 * 60);
  const policyCheck = {
    message: "binding-specific archive delay overrides the generic live-age gate",
    expected: { effectiveMaxAgeMinutes: 14 * 24 * 60, withinPolicy: true },
    actual: {
      effectiveMaxAgeMinutes: delayedArchivePolicy.effectiveMaxAgeMinutes,
      withinPolicy: delayedArchivePolicy.withinPolicy,
    },
    passed: delayedArchivePolicy.effectiveMaxAgeMinutes === 14 * 24 * 60
      && delayedArchivePolicy.withinPolicy === true,
  };
  const checks = [...cases, policyCheck];
  return {
    passed: checks.every((test) => test.passed),
    total: checks.length,
    failures: checks.filter((test) => !test.passed),
  };
}

function recordResult(result) {
  report.results.push(result);
  report.completed += 1;
  if (result.status === "passed") {
    report.passed += 1;
  } else {
    report.failed += 1;
    report.failureCounts[result.failureClass] += 1;
  }
  for (const attempt of result.attempts || []) {
    if (attempt.failureClass) report.attemptFailureCounts[attempt.failureClass] += 1;
  }
}

function renderReport(force = false) {
  if (!force && report.completed < report.total) {
    const classified = FAILURE_CLASSES
      .filter((failureClass) => report.failureCounts[failureClass])
      .map((failureClass) => `${failureClass}=${report.failureCounts[failureClass]}`)
      .join(", ");
    summary.textContent = `${report.completed}/${report.total}: ${report.passed} passed, ${report.failed} failed${classified ? ` (${classified})` : ""}`;
  }
  resultsElement.textContent = JSON.stringify(report, null, 2);
  document.body.dataset.completed = String(report.completed);
  document.body.dataset.failed = String(report.failed);
}

function finalSummary() {
  const classified = FAILURE_CLASSES
    .filter((failureClass) => report.failureCounts[failureClass])
    .map((failureClass) => `${failureClass}=${report.failureCounts[failureClass]}`)
    .join(", ");
  const selectionSuffix = report.selection.selectionErrors.length
    ? `; ${report.selection.selectionErrors.length} selection error(s)`
    : "";
  return `Complete: ${report.passed} passed, ${report.failed} failed, ${report.total} total${classified ? ` (${classified})` : ""}${selectionSuffix}`;
}

async function finishFatally(error) {
  report.finishedAt = new Date().toISOString();
  report.fatal = {
    failureClass: classifyFailure(error, "selection"),
    errorName: String(error?.name || "Error"),
    error: errorMessage(error),
  };
  report.ok = false;
  summary.textContent = `Fatal harness failure: ${report.fatal.error}`;
  document.body.dataset.complete = "true";
  document.body.dataset.ok = "false";
  renderReport(true);
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    copyButton.textContent = "Copied";
  } catch (error) {
    copyButton.textContent = `Copy failed: ${errorMessage(error)}`;
  }
  setTimeout(() => { copyButton.textContent = "Copy JSON"; }, 2_000);
}

async function safelyReadCacheStats() {
  try {
    return await client.toolbox.stats();
  } catch (error) {
    report?.warnings?.push(`cache stats failed: ${errorMessage(error)}`);
    return { error: errorMessage(error) };
  }
}

function parseStringSet(value, normalize = (item) => item) {
  return new Set(String(value || "").split(",").map((item) => normalize(item.trim())).filter(Boolean));
}

function parseFallbackProducts(value) {
  const normalized = String(value || "").trim();
  if (!normalized || /^(?:0|false|off|none)$/i.test(normalized)) return [];
  if (/^(?:1|true|on)$/i.test(normalized)) return ["VEL", "CC"];
  return [...new Set(normalized.split(",").map(normalizeProduct).filter((product) => product && product !== "REF"))];
}

function parseMaximumAge(value) {
  const normalized = String(value ?? "60").trim();
  if (/^(?:0|false|off|none)$/i.test(normalized)) return null;
  return boundedNumber(normalized, 60, 1, 24 * 60);
}

function queryBoolean(name, fallback) {
  if (!params.has(name)) return fallback;
  return !/^(?:0|false|off|no)$/i.test(String(params.get(name) || "").trim());
}

function boundedNumber(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Math.floor(boundedNumber(value, fallback, minimum, maximum));
}

function normalizeProduct(value) {
  return String(value || "").trim().toUpperCase();
}

function sourcePriority(source) {
  return Number.isFinite(Number(source.priority)) ? Number(source.priority) : 1_000_000;
}

function describeFreshnessPolicy(source, requestedMaxAgeMinutes, actualAgeMinutes) {
  const sourceMaxAgeMinutes = finiteNumberOrNull(source?.maxAgeMinutes);
  const requested = finiteNumberOrNull(requestedMaxAgeMinutes);
  const effectiveMaxAgeMinutes = sourceMaxAgeMinutes !== null && requested !== null
    ? Math.max(sourceMaxAgeMinutes, requested)
    : sourceMaxAgeMinutes ?? requested;
  return {
    requestedMaxAgeMinutes: requested,
    sourceMaxAgeMinutes,
    effectiveMaxAgeMinutes,
    availability: source?.metadata?.availability || "live",
    typicalDelayDays: finiteNumberOrNull(source?.metadata?.typicalDelayDays),
    withinPolicy: Number.isFinite(actualAgeMinutes) && effectiveMaxAgeMinutes !== null
      ? actualAgeMinutes <= effectiveMaxAgeMinutes
      : null,
  };
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function emptyFailureCounts() {
  return Object.fromEntries(FAILURE_CLASSES.map((failureClass) => [failureClass, 0]));
}

function byteView(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function checksum(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash = Math.imul(hash ^ bytes[index], 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function countNonTransparentPixels(bytes) {
  let count = 0;
  for (let index = 3; index < bytes.length; index += 4) {
    if (bytes[index] !== 0) count += 1;
  }
  return count;
}

function ageMinutes(volumeTime, now) {
  const volumeMillis = Date.parse(String(volumeTime || ""));
  return Number.isFinite(volumeMillis) ? (now.getTime() - volumeMillis) / 60_000 : NaN;
}

function staleAgeFromMessage(value) {
  const match = String(value || "").match(/stale(?:\s+by)?\s+(-?\d+(?:\.\d+)?)\s+minutes?/i);
  return match ? Number(match[1]) : null;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}

class HarnessFailure extends Error {
  constructor(failureClass, message) {
    super(message);
    this.name = "LiveMatrixHarnessFailure";
    this.failureClass = failureClass;
  }
}

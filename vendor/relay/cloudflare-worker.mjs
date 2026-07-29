// Minimal byte-preserving CORS relay for BowEcho radar sources.
// Deploy behind a route such as https://radar-relay.example/radar?url=...

const DEFAULT_ALLOWED_HOSTS = new Set([
  "avaandmed.keskkonnaportaal.ee",
  "fmi-opendata-radar-volume-hdf5.s3.amazonaws.com",
  "level2.swc.nd.gov",
  "mesonet-nexrad.agron.iastate.edu",
  "opendata-download-radar.smhi.se",
  "opendata.chmi.cz",
  "opendata.dwd.de",
  "opendata.meteoromania.ro",
  "opendata.shmu.sk",
  "opendataapi.dmi.dk",
  "pawr.nict.go.jp",
  "public.hub.geosphere.at",
  "radarlive.arpalombardia.it",
  "s3.waw3-1.cloudferro.com",
  "thredds.nci.org.au",
  "unidata-nexrad-level2-chunks.s3.amazonaws.com",
  "unidata-nexrad-level2.s3.amazonaws.com",
  "www.arpa.piemonte.it",
]);

const POST_ALLOWED_HOSTS = new Set(["avaandmed.keskkonnaportaal.ee"]);
const MAX_POST_BODY_BYTES = 64 * 1024;
const EDGE_CACHE_CONTROL = "public, max-age=60";
const EDGE_CACHE_VERSION = "2";

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "range",
];

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

function configuredHosts(env) {
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  for (const host of String(env?.ADDITIONAL_ALLOWED_HOSTS || "").split(",")) {
    const normalized = host.trim().toLowerCase();
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin") || "*";
  const configured = String(env?.ALLOWED_ORIGINS || "*").split(",").map((value) => value.trim()).filter(Boolean);
  if (configured.includes("*")) return "*";
  return configured.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "Accept, Content-Type, If-Match, If-Modified-Since, If-None-Match, Range",
    "access-control-expose-headers": "Accept-Ranges, Cache-Control, Content-Length, Content-Range, Content-Type, ETag, Last-Modified, X-BowEcho-Upstream",
    "access-control-max-age": "86400",
    vary: origin === "*" ? "Accept-Encoding" : "Origin, Accept-Encoding",
  };
}

function textResponse(message, status, origin = "*") {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders(origin) },
  });
}

function validateUpstreamUrl(value, env, base = undefined) {
  let upstream;
  try {
    upstream = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new Error("Invalid upstream URL");
  }
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.port) {
    throw new Error("Only credential-free HTTPS upstream URLs are allowed");
  }
  if (!configuredHosts(env).has(upstream.hostname.toLowerCase())) {
    throw new Error("Upstream host is not allowlisted");
  }
  return upstream;
}

async function fetchAllowedUpstream(upstream, init, env) {
  let current = upstream;
  let currentInit = init;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetch(new Request(current, { ...currentInit, redirect: "manual" }));
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectCount === 5) throw new Error("Upstream redirect limit exceeded");
    const location = response.headers.get("location");
    if (!location) throw new Error("Upstream redirect has no Location header");
    current = validateUpstreamUrl(location, env, current);
    if (currentInit.method === "POST" && !POST_ALLOWED_HOSTS.has(current.hostname.toLowerCase())) {
      throw new Error("POST redirect target is not allowlisted for POST");
    }
    if ((response.status === 303 && !["GET", "HEAD"].includes(currentInit.method))
        || ([301, 302].includes(response.status) && currentInit.method === "POST")) {
      const headers = new Headers(currentInit.headers);
      headers.delete("content-type");
      currentInit = { ...currentInit, method: "GET", headers, body: undefined };
    }
  }
  throw new Error("Upstream redirect limit exceeded");
}

async function readBodyLimited(request, maxBytes) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body too large");
      throw new RangeError("POST body is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export default {
  async fetch(request, env, context) {
    const origin = allowedOrigin(request, env);
    if (!origin) return textResponse("Origin is not allowed", 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (!["GET", "HEAD", "POST"].includes(request.method)) return textResponse("Method not allowed", 405, origin);

    const requestUrl = new URL(request.url);
    const rawUpstream = requestUrl.searchParams.get("url");
    if (!rawUpstream) return textResponse("Missing ?url= upstream URL", 400, origin);

    let upstream;
    try {
      upstream = validateUpstreamUrl(rawUpstream, env);
    } catch (error) {
      const status = String(error.message).includes("allowlisted") ? 403 : 400;
      return textResponse(error.message, status, origin);
    }

    const isRangeRequest = request.headers.has("range");
    let requestBody;
    if (request.method === "POST") {
      if (!POST_ALLOWED_HOSTS.has(upstream.hostname.toLowerCase())) {
        return textResponse("POST is not allowed for this upstream host", 405, origin);
      }
      const contentType = request.headers.get("content-type") || "";
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        return textResponse("POST requires application/json", 415, origin);
      }
      const declaredLength = Number(request.headers.get("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_POST_BODY_BYTES) {
        return textResponse("POST body is too large", 413, origin);
      }
      try {
        requestBody = await readBodyLimited(request, MAX_POST_BODY_BYTES);
      } catch (error) {
        if (error instanceof RangeError) return textResponse(error.message, 413, origin);
        throw error;
      }
      if (requestBody.byteLength > MAX_POST_BODY_BYTES) {
        return textResponse("POST body is too large", 413, origin);
      }
      try {
        JSON.parse(new TextDecoder().decode(requestBody));
      } catch {
        return textResponse("POST body must be valid JSON", 400, origin);
      }
    }

    const requestHeaders = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) requestHeaders.set(name, value);
    }
    const upstreamRequest = new Request(upstream, {
      method: request.method,
      headers: requestHeaders,
      body: requestBody,
      redirect: "follow",
      cache: isRangeRequest ? "no-store" : undefined,
    });

    const cache = caches.default;
    const canUseCache = request.method === "GET" && !isRangeRequest;
    const cacheKeyUrl = new URL(request.url);
    cacheKeyUrl.searchParams.set("__bowecho_cache", EDGE_CACHE_VERSION);
    const cacheKey = new Request(cacheKeyUrl, { method: request.method, headers: requestHeaders });
    let response = canUseCache ? await cache.match(cacheKey) : null;
    if (!response) {
      try {
        response = await fetchAllowedUpstream(upstream, {
          method: upstreamRequest.method,
          headers: upstreamRequest.headers,
          body: requestBody,
          cache: isRangeRequest ? "no-store" : undefined,
        }, env);
      } catch (error) {
        return textResponse(`Upstream fetch rejected: ${error.message || error}`, 502, origin);
      }
      if (canUseCache && response.ok) {
        const cacheResponse = response.clone();
        const cacheHeaders = new Headers(cacheResponse.headers);
        cacheHeaders.set("cache-control", EDGE_CACHE_CONTROL);
        context.waitUntil(cache.put(cacheKey, new Response(cacheResponse.body, {
          status: cacheResponse.status,
          statusText: cacheResponse.statusText,
          headers: cacheHeaders,
        })));
      }
    }

    const headers = new Headers(corsHeaders(origin));
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("cache-control", request.method === "GET" && !isRangeRequest ? EDGE_CACHE_CONTROL : "no-store");
    headers.set("x-bowecho-upstream", upstream.hostname);
    headers.set("x-content-type-options", "nosniff");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

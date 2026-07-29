// Minimal byte-preserving CORS relay for BowEcho radar sources.
// Deploy behind a route such as https://radar-relay.example/radar?url=...

const DEFAULT_ALLOWED_HOSTS = new Set([
  "fmi-opendata-radar-volume-hdf5.s3.amazonaws.com",
  "opendata-download-radar.smhi.se",
  "opendata.chmi.cz",
  "opendata.dwd.de",
  "opendata.shmu.sk",
  "opendataapi.dmi.dk",
  "pawr.nict.go.jp",
  "public.hub.geosphere.at",
  "s3.waw3-1.cloudferro.com",
  "unidata-nexrad-level2-chunks.s3.amazonaws.com",
  "unidata-nexrad-level2.s3.amazonaws.com",
]);

const FORWARDED_REQUEST_HEADERS = [
  "accept",
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
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Accept, If-Match, If-Modified-Since, If-None-Match, Range",
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
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetch(new Request(current, { ...init, redirect: "manual" }));
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectCount === 5) throw new Error("Upstream redirect limit exceeded");
    const location = response.headers.get("location");
    if (!location) throw new Error("Upstream redirect has no Location header");
    current = validateUpstreamUrl(location, env, current);
  }
  throw new Error("Upstream redirect limit exceeded");
}

export default {
  async fetch(request, env, context) {
    const origin = allowedOrigin(request, env);
    if (!origin) return textResponse("Origin is not allowed", 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "GET" && request.method !== "HEAD") return textResponse("Method not allowed", 405, origin);

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

    const requestHeaders = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) requestHeaders.set(name, value);
    }
    const upstreamRequest = new Request(upstream, {
      method: request.method,
      headers: requestHeaders,
      redirect: "follow",
    });

    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: request.method, headers: requestHeaders });
    let response = request.method === "GET" ? await cache.match(cacheKey) : null;
    if (!response) {
      try {
        response = await fetchAllowedUpstream(upstream, {
          method: upstreamRequest.method,
          headers: upstreamRequest.headers,
        }, env);
      } catch (error) {
        return textResponse(`Upstream fetch rejected: ${error.message || error}`, 502, origin);
      }
      if (request.method === "GET" && response.ok && !request.headers.has("range")) {
        context.waitUntil(cache.put(cacheKey, response.clone()));
      }
    }

    const headers = new Headers(corsHeaders(origin));
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=60");
    headers.set("x-bowecho-upstream", upstream.hostname);
    headers.set("x-content-type-options", "nosniff");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

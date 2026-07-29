import assert from "node:assert/strict";
import worker from "../relay/cloudflare-worker.mjs";

const stored = new Map();
let cacheMatchCalls = 0;
let cachePutCalls = 0;
globalThis.caches = {
  default: {
    async match(request) {
      cacheMatchCalls += 1;
      return stored.get(request.url)?.clone() || null;
    },
    async put(request, response) {
      cachePutCalls += 1;
      stored.set(request.url, response.clone());
    },
  },
};

let fetchCalls = [];
globalThis.fetch = async (request) => {
  fetchCalls.push(request.clone());
  if (request.url.endsWith("/redirect-bad")) {
    return new Response(null, { status: 302, headers: { location: "https://example.com/private" } });
  }
  if (request.url.endsWith("/redirect-post")) {
    return new Response(null, { status: 307, headers: { location: "https://opendata.dwd.de/not-a-post-endpoint" } });
  }
  if (request.headers.has("range")) {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-2/3",
        "content-length": "3",
      },
    });
  }
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=7200", etag: '"fixture"' },
  });
};

const context = { waitUntil(promise) { return promise; } };
const relayRequest = (upstream) => new Request(`https://relay.test/radar?url=${encodeURIComponent(upstream)}`, {
  headers: { origin: "https://app.example" },
});

let response = await worker.fetch(relayRequest("https://opendata.dwd.de/radar.bin"), {
  ALLOWED_ORIGINS: "https://app.example",
}, context);
assert.equal(response.status, 200);
assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example");
assert.equal(response.headers.get("x-bowecho-upstream"), "opendata.dwd.de");
assert.equal(response.headers.get("cache-control"), "public, max-age=60");

const cacheMatchesBeforeRange = cacheMatchCalls;
const cachePutsBeforeRange = cachePutCalls;
fetchCalls = [];
response = await worker.fetch(new Request(
  `https://relay.test/radar?url=${encodeURIComponent("https://opendata.dwd.de/radar.bin")}`,
  { headers: { origin: "https://app.example", range: "bytes=0-2" } },
), { ALLOWED_ORIGINS: "https://app.example" }, context);
assert.equal(response.status, 206);
assert.equal(response.headers.get("content-range"), "bytes 0-2/3");
assert.equal(response.headers.get("content-length"), "3");
assert.equal(response.headers.get("cache-control"), "no-store");
assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].headers.get("range"), "bytes=0-2");
assert.equal(fetchCalls[0].cache, "no-store");
assert.equal(cacheMatchCalls, cacheMatchesBeforeRange, "Range requests must bypass Cache API reads");
assert.equal(cachePutCalls, cachePutsBeforeRange, "Range requests must bypass Cache API writes");

fetchCalls = [];
response = await worker.fetch(relayRequest("https://example.com/private"), {}, context);
assert.equal(response.status, 403);
assert.equal(fetchCalls.length, 0);

fetchCalls = [];
response = await worker.fetch(relayRequest("https://opendata.dwd.de/redirect-bad"), {}, context);
assert.equal(response.status, 502);
assert.equal(fetchCalls.length, 1);
assert.match(await response.text(), /not allowlisted/i);

fetchCalls = [];
response = await worker.fetch(new Request(
  `https://relay.test/radar?url=${encodeURIComponent("https://avaandmed.keskkonnaportaal.ee/api/radar")}`,
  {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify({ station: "surgavere" }),
  },
), { ALLOWED_ORIGINS: "https://app.example" }, context);
assert.equal(response.status, 200);
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].method, "POST");
assert.equal(fetchCalls[0].headers.get("content-type"), "application/json");
assert.deepEqual(await fetchCalls[0].json(), { station: "surgavere" });
assert.equal(response.headers.get("cache-control"), "no-store");

fetchCalls = [];
response = await worker.fetch(new Request(
  `https://relay.test/radar?url=${encodeURIComponent("https://opendata.dwd.de/radar")}`,
  {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: "{}",
  },
), {}, context);
assert.equal(response.status, 405);
assert.equal(fetchCalls.length, 0);

fetchCalls = [];
response = await worker.fetch(new Request(
  `https://relay.test/radar?url=${encodeURIComponent("https://avaandmed.keskkonnaportaal.ee/api/radar")}`,
  {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "text/plain" },
    body: "{}",
  },
), {}, context);
assert.equal(response.status, 415);
assert.equal(fetchCalls.length, 0);

for (const host of [
  "thredds.nci.org.au",
  "www.arpa.piemonte.it",
  "radarlive.arpalombardia.it",
  "avaandmed.keskkonnaportaal.ee",
  "opendata.meteoromania.ro",
  "level2.swc.nd.gov",
  "mesonet-nexrad.agron.iastate.edu",
]) {
  fetchCalls = [];
  response = await worker.fetch(relayRequest(`https://${host}/radar-fixture`), {}, context);
  assert.equal(response.status, 200, `${host} must be allowlisted`);
  assert.equal(fetchCalls.length, 1);
}

fetchCalls = [];
response = await worker.fetch(new Request(
  `https://relay.test/radar?url=${encodeURIComponent("https://avaandmed.keskkonnaportaal.ee/api/radar")}`,
  {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: "{not-json}",
  },
), {}, context);
assert.equal(response.status, 400);
assert.equal(fetchCalls.length, 0);

fetchCalls = [];
response = await worker.fetch(new Request(
  `https://relay.test/radar?url=${encodeURIComponent("https://avaandmed.keskkonnaportaal.ee/api/radar")}`,
  {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify({ payload: "x".repeat(64 * 1024) }),
  },
), {}, context);
assert.equal(response.status, 413);
assert.equal(fetchCalls.length, 0);

fetchCalls = [];
response = await worker.fetch(new Request(
  `https://relay.test/radar?url=${encodeURIComponent("https://avaandmed.keskkonnaportaal.ee/redirect-post")}`,
  {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: "{}",
  },
), {}, context);
assert.equal(response.status, 502);
assert.equal(fetchCalls.length, 1);
assert.match(await response.text(), /not allowlisted for POST/i);

response = await worker.fetch(new Request("https://relay.test/radar", {
  method: "OPTIONS",
  headers: { origin: "https://app.example" },
}), { ALLOWED_ORIGINS: "https://app.example" }, context);
assert.equal(response.status, 204);
assert.match(response.headers.get("access-control-allow-methods"), /POST/);
assert.match(response.headers.get("access-control-allow-headers"), /Content-Type/i);

console.log("relay-contract ok");

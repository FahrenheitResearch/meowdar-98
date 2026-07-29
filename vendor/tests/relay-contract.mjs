import assert from "node:assert/strict";
import worker from "../relay/cloudflare-worker.mjs";

const stored = new Map();
globalThis.caches = {
  default: {
    async match(request) { return stored.get(request.url)?.clone() || null; },
    async put(request, response) { stored.set(request.url, response.clone()); },
  },
};

let fetchCalls = [];
globalThis.fetch = async (request) => {
  fetchCalls.push(request.url);
  if (request.url.endsWith("/redirect-bad")) {
    return new Response(null, { status: 302, headers: { location: "https://example.com/private" } });
  }
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "application/octet-stream", etag: '"fixture"' },
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

fetchCalls = [];
response = await worker.fetch(relayRequest("https://example.com/private"), {}, context);
assert.equal(response.status, 403);
assert.equal(fetchCalls.length, 0);

fetchCalls = [];
response = await worker.fetch(relayRequest("https://opendata.dwd.de/redirect-bad"), {}, context);
assert.equal(response.status, 502);
assert.equal(fetchCalls.length, 1);
assert.match(await response.text(), /not allowlisted/i);

console.log("relay-contract ok");

# BowEcho optional CORS relay

`cloudflare-worker.mjs` is a byte-preserving relay for upstreams that cannot be fetched directly by browsers. It does not decode, merge, render, or persist radar volumes.

Deploy the module as a Cloudflare Worker, then configure the SDK:

```js
const radar = createRadarClient({
  relayUrl: "https://radar-relay.example/radar",
});
```

The worker accepts `GET`, `HEAD`, and CORS preflight requests at
`?url=<encoded HTTPS URL>`. A bounded JSON `POST` is accepted only for the
allowlisted KAIA Estonia catalog endpoint; arbitrary POST proxying is not
enabled. The worker rejects credentials, non-HTTPS URLs, explicit ports, and
hosts outside its allowlist.

From a project containing the Worker and a `wrangler.jsonc`, deployment is one
command:

```bash
npx wrangler deploy
```

Set `ALLOWED_ORIGINS` to the comma-separated origins of the applications that
may use the relay, then put the returned Worker URL in `createRadarClient`.
Provider planning, downloads, WASM decoding, products, cuts, and rendering stay
inside the visitor's browser; the relay only supplies byte-preserving CORS.

Environment variables:

- `ALLOWED_ORIGINS`: comma-separated application origins; defaults to `*`.
- `ADDITIONAL_ALLOWED_HOSTS`: comma-separated HTTPS hostnames to add to the built-in radar-source allowlist.

Keep the allowlist narrow. Do not turn this into an arbitrary URL proxy. If an upstream requires credentials, implement that provider as an explicit server-side binding rather than exposing credentials through the generic relay.

Cloudflare's Cache API does not provide functional edge reuse on a bare
`workers.dev` hostname. Attach a custom route/domain if edge caching is wanted;
correctness does not depend on it, and browser responses are bounded to a
60-second cache lifetime.


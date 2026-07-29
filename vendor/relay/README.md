# BowEcho optional CORS relay

`cloudflare-worker.mjs` is a byte-preserving relay for upstreams that cannot be fetched directly by browsers. It does not decode, merge, render, or persist radar volumes.

Deploy the module as a Cloudflare Worker, then configure the SDK:

```js
const radar = createRadarClient({
  relayUrl: "https://radar-relay.example/radar",
});
```

The worker accepts `GET`, `HEAD`, and CORS preflight requests at `?url=<encoded HTTPS URL>`. It rejects credentials, non-HTTPS URLs, explicit ports, and hosts outside its allowlist.

Environment variables:

- `ALLOWED_ORIGINS`: comma-separated application origins; defaults to `*`.
- `ADDITIONAL_ALLOWED_HOSTS`: comma-separated HTTPS hostnames to add to the built-in radar-source allowlist.

Keep the allowlist narrow. Do not turn this into an arbitrary URL proxy. If an upstream requires credentials, implement that provider as an explicit server-side binding rather than exposing credentials through the generic relay.


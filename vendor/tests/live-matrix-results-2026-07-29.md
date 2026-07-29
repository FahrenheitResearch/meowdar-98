# Meowdar 98 live provider matrix — 2026-07-29

Tested the browser SDK end to end with strict `REF`, one frame, 256x256 render,
230 km range, cache clear between cases, required volume time, and the normal
60-minute freshness gate unless a row says otherwise. Every passing checksum
below is both the decoded RGBA checksum and the canvas readback checksum.

The main matrix used the current local `vendor/relay/cloudflare-worker.mjs`
because this agent's Chrome test surface blocked the temporary deployed worker
hostname (`ERR_BLOCKED_BY_CLIENT`). That was specific to this Chrome surface,
not a general browser failure: a separate in-app Browser successfully loaded,
decoded, and rendered `RO:ROBUC`, `IT:BRIC`, `IT:DES`, and `AU:2` through the
actual temporary deployment. Separate HTTP probes against that deployment also
confirmed CORS and source access for NCI, Piemonte, Lombardia, KAIA,
MeteoRomania, ORD, and NEXRAD, including a 32-byte NCI ZIP range response.

## Result

- Default-age suite: 53 cases, 51 passed, 2 expected availability rejections.
- The two rejections were `ES:ESAHR` (no current files) and `SK:SKJAV`
  (latest volume 74 minutes old).
- `ES:ESPDG` passed as the live Spain representative.
- The same SHMU volume passed strict REF decode/render with `maxAge=120`, proving
  the provider path; the normal 60-minute gate correctly hid stale data.
- All 16 catalog provider families and every catalog country have at least one
  successful strict REF download, WASM decode, render, and canvas verification.
- Automatic resolution selected native KAIA and MeteoRomania sources; pinned
  ORD bindings for Estonia and all seven Romanian radars also passed.

## Newly added providers

| Case | Status | Volume UTC | Age min | Transport | RGBA = canvas |
|---|---:|---|---:|---|---|
| `AU:114@australia-nci:114` | pass | 2026-07-23 23:55 | 8356.1 | relay | `b2baa7cb` |
| `AU:2@australia-nci:2` | pass | 2026-07-24 23:55 | 6916.6 | relay | `0e4a5d5e` |
| `AU:71@australia-nci:71` | pass | 2026-07-23 23:55 | 8357.3 | relay | `d01e9610` |
| `IT:BRIC@arpa-piemonte:bric` | pass | 2026-07-29 19:05:02 | 8.4 | relay | `c5645498` |
| `IT:SETT@arpa-piemonte:sett` | pass | 2026-07-29 19:05:02 | 8.5 | relay | `7e95aea2` |
| `IT:DES@arpa-lombardia:des` | pass | 2026-07-29 19:05 | 8.5 | relay | `ed2be22d` |
| `IT:FLE@arpa-lombardia:fle` | pass | 2026-07-29 19:05 | 8.5 | relay | `48187949` |
| `EE:EEHAR@kaia:eehar` | pass | 2026-07-29 18:55 | 16.1 | direct | `87d618b8` |
| `EE:EESUR@kaia:eesur` | pass | 2026-07-29 19:00 | 11.3 | direct | `16130685` |
| `EE:EESUR@ord:eesur` | pass | 2026-07-29 19:10 | 1.3 | relay | `a2f76eaa` |
| `RO:ROBAR@meteoromania:BAR` | pass | 2026-07-29 19:00:02 | 11.1 | relay | `d166fcc7` |
| `RO:ROBAR@ord:robar` | pass | 2026-07-29 19:05 | 6.3 | relay | `c13b78d2` |
| `RO:ROBOB@meteoromania:BOB` | pass | 2026-07-29 19:00:02 | 11.3 | relay | `06632bb6` |
| `RO:ROBOB@ord:robob` | pass | 2026-07-29 19:05 | 6.4 | relay | `426d2695` |
| `RO:ROBUC@meteoromania:BUC` | pass | 2026-07-29 19:00:02 | 11.4 | relay | `ade18feb` |
| `RO:ROBUC@ord:robuc` | pass | 2026-07-29 19:05 | 6.5 | relay | `6cd703f3` |
| `RO:ROCRA@meteoromania:CRA` | pass | 2026-07-29 19:00:02 | 11.5 | relay | `7a5fa743` |
| `RO:ROCRA@ord:rocra` | pass | 2026-07-29 19:05 | 6.6 | relay | `31e32952` |
| `RO:ROMED@meteoromania:MED` | pass | 2026-07-29 19:00:02 | 11.6 | relay | `1a73f0b7` |
| `RO:ROMED@ord:romed` | pass | 2026-07-29 19:05 | 6.7 | relay | `0fedffcd` |
| `RO:ROORA@meteoromania:ORA` | pass | 2026-07-29 19:00:02 | 11.7 | relay | `d8e51612` |
| `RO:ROORA@ord:roora` | pass | 2026-07-29 19:05 | 6.7 | relay | `ce1db2c8` |
| `RO:ROTIM@meteoromania:TIM` | pass | 2026-07-29 19:00:02 | 11.7 | relay | `7a95296a` |
| `RO:ROTIM@ord:rotim` | pass | 2026-07-29 19:05 | 6.8 | relay | `1acdef4e` |

Australia NCI is intentionally archive-delayed. Its binding-specific maximum
age is 20,160 minutes (14 days), so all three representative volumes were
inside policy despite being several days old.

## Existing providers and NEXRAD

| Case | Status | Volume UTC | Age min | Transport | RGBA = canvas |
|---|---:|---|---:|---|---|
| `AT:HOCHFICHT@geosphere:hochficht` | pass | 2026-07-29 19:05 | 7.2 | relay | `cdb96a53` |
| `CZ:BRD@chmi:brd` | pass | 2026-07-29 19:10:27 | 1.7 | relay | `37e36a54` |
| `DE:ASB@dwd:asb` | pass | 2026-07-29 19:09:03 | 3.4 | relay | `39e8d7b6` |
| `DK:06036@dmi:06036` | pass | 2026-07-29 18:55 | 17.5 | relay | `52b428a3` |
| `FI:FIANJ@fmi:fianj` | pass | 2026-07-29 19:05 | 7.6 | direct | `f5ec9dc5` |
| `JP:AKIT@jma:AKIT` | pass | 2026-07-29 19:00 | 12.6 | relay | `3219a8d7` |
| `SE:ANGELHOLM@smhi:angelholm` | pass | 2026-07-29 18:55 | 17.8 | direct | `c8b9227d` |
| `SK:SKJAV@shmu:skjav` | stale | 2026-07-29 18:05 | 74.0 | relay | rejected by 60-minute gate |
| `SK:SKJAV@shmu:skjav` (`maxAge=120`) | pass | 2026-07-29 18:05 | 74.0 | relay | `907b0ebe` |
| `US:KAMX@nexrad-public:KAMX` | pass | 2026-07-29 19:07:01 | 6.4 | direct | `6940acee` |
| `US:KTLX@nexrad-public:KTLX` | pass | 2026-07-29 19:07:50 | 5.7 | direct | `65c6069e` |
| `US:FWLX@community-gr2a:FWLX` | pass | 2026-07-29 19:15:03 | 4.8 | relay | `81d8e169` |

The FMI sample contained zero non-transparent echo pixels at this moment, but
the decoded 262,144-byte RGBA buffer and the canvas readback matched exactly.

## ORD country representatives

| Case | Status | Volume UTC | Age min | RGBA = canvas / reason |
|---|---:|---|---:|---|
| `BE:BEHEL@ord:behel` | pass | 2026-07-29 19:05 | 7.2 | `b0c0f9a5` |
| `CH:CHALB@ord:chalb` | pass | 2026-07-29 19:08 | 4.2 | `098aea5d` |
| `EE:EESUR@ord:eesur` | pass | 2026-07-29 19:10 | 2.3 | `a2f76eaa` |
| `ES:ESAHR@ord:esahr` | unavailable | — | — | no files in requested hour window |
| `ES:ESPDG@ord:espdg` | pass | 2026-07-29 19:10 | 9.3 | `0b35e9f0` |
| `FR:FRABB@ord:frabb` | pass | 2026-07-29 19:09 | 3.2 | `85225e34` |
| `HR:HRBIL@ord:hrbil` | pass | 2026-07-29 19:05 | 7.3 | `b910dc73` |
| `IE:IEDUB@ord:iedub` | pass | 2026-07-29 19:05 | 7.2 | `d40c00b2` |
| `IS:ISBJO@ord:isbjo` | pass | 2026-07-29 19:05 | 7.2 | `8634f5f6` |
| `LT:LTLAU@ord:ltlau` | pass | 2026-07-29 19:10 | 2.2 | `9a430d49` |
| `MT:MTGUD@ord:mtgud` | pass | 2026-07-29 19:08 | 4.3 | `b1684373` |
| `NL:NLDHL@ord:nldhl` | pass | 2026-07-29 19:05 | 7.3 | `083238a7` |
| `NO:NOAND@ord:noand` | pass | 2026-07-29 19:06 | 6.2 | `759665ff` |
| `PL:PLBRZ@ord:plbrz` | pass | 2026-07-29 19:06 | 6.3 | `b3be3f18` |
| `RO:ROBAR@ord:robar` | pass | 2026-07-29 19:05 | 7.3 | `c13b78d2` |
| `SI:SILIS@ord:silis` | pass | 2026-07-29 19:05 | 7.3 | `3b997454` |

## Automatic logical-source selection

| Logical case | Chosen source | Role | Volume UTC | Age min | RGBA = canvas |
|---|---|---|---|---:|---|
| `EE:EESUR` | `kaia:eesur` | primary | 2026-07-29 19:05 | 15.2 | `cc3c81dd` |
| `RO:ROBUC` | `meteoromania:BUC` | primary | 2026-07-29 19:10:02 | 10.3 | `03db46c8` |

## Relay HTTP probes

Remote browser spot checks through the temporary deployed relay passed for
MeteoRomania `RO:ROBUC`, Piemonte `IT:BRIC`, Lombardia `IT:DES`, and Australia
NCI `AU:2`. The selected `AU:2` volume was 2026-07-24 23:55 UTC.

The temporary deployment returned `Access-Control-Allow-Origin:
http://127.0.0.1:8766` and the correct `X-BowEcho-Upstream` for:

- Piemonte listing: 200, 18,995 bytes.
- Lombardia listing: 200, 358,141 bytes.
- MeteoRomania listing: 200, 710,192 bytes.
- ORD listing: 200, 2,012 bytes.
- NEXRAD listing: 200, 2,018 bytes.
- KAIA POST query: 200, 1,985,965 bytes.
- NCI daily ZIP: HEAD 200, 727,563,500 bytes; `Range: bytes=0-31`
  returned 206 with exactly 32 bytes and the correct `Content-Range`.

Static contracts also passed:

```text
sdk-contract ok
universal-contract ok
relay-contract ok
```

Harness entry points:

- `vendor/tests/live-matrix.html`
- `vendor/tests/live-matrix.mjs`

## Universal-facade dogfood

- The dependency-free universal example opened `FI:FIANJ` as a three-frame
  direct loop, exposed 21 products and 11 displayable cuts, and rerendered
  dealiased velocity from the decoded cache.
- Meowdar opened remote-relayed `IT:BRIC`, then rerendered REF to VEL without a
  second provider download; the volume time remained `2026-07-29T19:30:02Z`.
- That test caught and fixed a pre-release context bug where an international
  provider-native ID could be mistaken for a NEXRAD site after rerender. The
  SDK contract now requires georeferencing/provider context to survive every
  cached product or cut rerender.

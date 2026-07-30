import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("../global.js", import.meta.url), "utf8");

function functionSource(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const bodyStart = script.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === "{") depth += 1;
    if (script[index] === "}") depth -= 1;
    if (depth === 0) return script.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const context = {};
vm.createContext(context);
vm.runInContext([
  functionSource("buildAzimuthLookup"),
  functionSource("nextPowerOfTwo"),
  functionSource("nearestAzimuthSample"),
  functionSource("normalizeAzimuth"),
  functionSource("circularAzimuthDistance"),
  "globalThis.buildAzimuthLookupForTest = buildAzimuthLookup;",
].join("\n"), context);

const buildAzimuthLookup = context.buildAzimuthLookupForTest;
const decode = (lookup, angle) => {
  const bin = Math.min(lookup.size - 1, Math.floor(((angle % 360) + 360) % 360 / 360 * lookup.size));
  const offset = bin * 4;
  return {
    valid: lookup.bytes[offset + 3] === 255,
    row: lookup.bytes[offset] + 256 * lookup.bytes[offset + 1],
  };
};

const regular = buildAzimuthLookup(Float32Array.from({ length: 360 }, (_, index) => index), 360, 3600);
assert.deepEqual(decode(regular, 0), { valid: true, row: 0 });
assert.deepEqual(decode(regular, 90), { valid: true, row: 90 });
assert.deepEqual(decode(regular, 359), { valid: true, row: 359 });

const reversed = buildAzimuthLookup(Float32Array.from({ length: 360 }, (_, index) => 359 - index), 360, 3600);
assert.deepEqual(decode(reversed, 0), { valid: true, row: 359 }, "azimuth lookup preserves native row order");
assert.deepEqual(decode(reversed, 359), { valid: true, row: 0 }, "wrapped reversed scans remain oriented correctly");

const missing = Float32Array.from({ length: 350 }, (_, index) => index < 100 ? index : index + 10);
const withGap = buildAzimuthLookup(missing, missing.length, 3600);
assert.equal(decode(withGap, 105).valid, false, "missing radial sectors stay transparent");
assert.equal(decode(withGap, 99).valid, true, "real radials next to a gap remain visible");

const sector = buildAzimuthLookup(Float32Array.from({ length: 91 }, (_, index) => index), 91, 3600);
assert.equal(decode(sector, 45).valid, true, "sector scan data renders inside its covered azimuths");
assert.equal(decode(sector, 180).valid, false, "sector gaps are not painted with a stretched edge radial");

assert.throws(() => buildAzimuthLookup(null, 360), /azimuth count/, "missing azimuth metadata fails closed");
assert.throws(
  () => buildAzimuthLookup(Float32Array.from([0, 1, Number.NaN, 3]), 4),
  /non-finite/,
  "corrupt azimuth metadata fails closed",
);
assert.throws(
  () => buildAzimuthLookup(Float32Array.from([0, 1, 2]), 4),
  /does not match/,
  "azimuth/radial length mismatches fail closed",
);
const highResolution = buildAzimuthLookup(Float32Array.from({ length: 3000 }, (_, index) => index * 0.12), 3000);
assert.equal(highResolution.size, 16384, "high-radial scans receive a non-aliasing lookup texture");
assert.throws(
  () => buildAzimuthLookup(Float32Array.from({ length: 5000 }, (_, index) => index * 0.072), 5000),
  /too many radials/,
  "scans beyond the exact lookup capacity fail closed",
);

assert.match(
  script,
  /floor\(\(range_km - u_first_gate_km\) \/ u_gate_spacing_km \+ 0\.5\)/,
  "shader uses center-based native gate indexing",
);
assert.doesNotMatch(
  script,
  /u_firstAzimuth|u_radialStep|u_radial_step/,
  "shader must not assume uniformly spaced international radials",
);

const gateIndex = (rangeKm, firstGateKm, gateSpacingKm) =>
  Math.floor((rangeKm - firstGateKm) / gateSpacingKm + 0.5);
assert.equal(gateIndex(2.0, 2.0, 0.25), 0, "the first nonzero gate center selects row zero");
assert.equal(gateIndex(2.124, 2.0, 0.25), 0, "the inner half of gate zero remains gate zero");
assert.equal(gateIndex(2.126, 2.0, 0.25), 1, "the nearest-center boundary advances to gate one");

console.log("native gate renderer geometry ok");

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toSatrec, positionAt, groundPoint, speedAt, lookFrom, passes, sunDirection, inShadow, fleetOf, fleetNames, bandOf, meanHeight, periodMinutes, pack, unpack, EARTH_RADIUS } from "../src/orbit.js";

const all = JSON.parse(readFileSync(new URL("../data/active.json", import.meta.url)));
const find = (pattern) => all.find((r) => pattern.test(r.OBJECT_NAME));
const iss = find(/^ISS \(ZARYA\)/);
const epoch = new Date(iss.EPOCH + "Z");
const sat = toSatrec(iss);

test("the ISS is where it should be", () => {
  const g = groundPoint(sat, epoch);
  assert.ok(g.height > 370 && g.height < 460, `height ${g.height}`);
  assert.ok(Math.abs(g.lat) <= 52, `latitude ${g.lat}`); // its orbit is inclined 51.6 degrees
  const v = speedAt(sat, epoch);
  assert.ok(v > 7.5 && v < 7.8, `speed ${v}`);
});

test("the ISS stays within its inclination for a whole day", () => {
  for (let m = 0; m < 1440; m += 7) assert.ok(Math.abs(groundPoint(sat, new Date(+epoch + m * 60000)).lat) < 52.2);
});

test("packing a record loses nothing the orbit needs", () => {
  const [row] = pack([iss]);
  const back = unpack([row])[0];
  const a = positionAt(toSatrec(back), epoch), b = positionAt(sat, epoch);
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6);
});

test("a geostationary satellite barely moves over the ground", () => {
  const geo = all.find((r) => Math.abs(r.MEAN_MOTION - 1.0027) < 0.0005 && r.INCLINATION < 0.1 && r.ECCENTRICITY < 0.001);
  assert.ok(geo, "catalogue has one");
  const s = toSatrec(geo), t = new Date(geo.EPOCH + "Z");
  const a = groundPoint(s, t), b = groundPoint(s, new Date(+t + 6 * 3600000));
  assert.ok(Math.abs(a.lat) < 0.3);
  assert.ok(Math.abs(a.lon - b.lon) < 0.3, `drift ${a.lon} to ${b.lon}`);
  assert.ok(Math.abs(a.height - 35786) < 60, `height ${a.height}`);
});

test("height and period from mean motion", () => {
  assert.ok(Math.abs(meanHeight(1.00274) - 35786) < 20);
  assert.ok(Math.abs(periodMinutes(15.5) - 92.9) < 0.1);
});

test("a spot directly under a satellite sees it straight overhead", () => {
  const g = groundPoint(sat, epoch);
  const look = lookFrom({ lat: g.lat, lon: g.lon }, sat, epoch);
  assert.ok(look.elevation > 88, `elevation ${look.elevation}`);
  assert.ok(Math.abs(look.range - g.height) < 5);
});

test("the far side of the Earth cannot see it", () => {
  const g = groundPoint(sat, epoch);
  assert.ok(lookFrom({ lat: -g.lat, lon: g.lon + 180 }, sat, epoch).elevation < -50);
});

test("passes are real: above the horizon inside, below just outside", () => {
  const place = { lat: 51.5, lon: -0.12 };
  const found = passes(place, sat, epoch, { hours: 72 });
  assert.ok(found.length > 0);
  for (const p of found) {
    const minutes = (p.set - p.rise) / 60000;
    assert.ok(minutes > 1 && minutes < 12, `lasted ${minutes}`);
    assert.ok(p.rise < p.peak && p.peak < p.set);
    assert.ok(Math.abs(lookFrom(place, sat, p.rise).elevation) < 0.5);
    assert.ok(Math.abs(lookFrom(place, sat, p.set).elevation) < 0.5);
    assert.ok(Math.abs(lookFrom(place, sat, p.peak).elevation - p.elevation) < 0.5);
    assert.ok(p.elevation >= 10);
    assert.equal(p.track.length, 25);
  }
});

test("a place the ISS never reaches gets no passes", () => {
  assert.equal(passes({ lat: 89, lon: 0 }, sat, epoch, { hours: 48 }).length, 0);
});

test("a pass already under way is reported from its true start", () => {
  const place = { lat: 51.5, lon: -0.12 };
  const [first] = passes(place, sat, epoch, { hours: 72 });
  const during = new Date((+first.rise + +first.peak) / 2);
  const [again] = passes(place, sat, during, { hours: 3 });
  assert.ok(Math.abs(again.rise - first.rise) < 2000, `differs by ${again.rise - first.rise} ms`);
});

test("the Sun: solstices and the equinox", () => {
  const dec = (d) => Math.asin(sunDirection(new Date(d)).z) * 180 / Math.PI;
  assert.ok(Math.abs(dec("2026-06-21T08:25Z") - 23.44) < 0.05);
  assert.ok(Math.abs(dec("2026-12-21T20:50Z") + 23.44) < 0.05);
  assert.ok(Math.abs(dec("2026-03-20T14:46Z")) < 0.05);
});

test("shadow: behind the Earth only", () => {
  const sun = { x: 1, y: 0, z: 0 };
  assert.equal(inShadow({ x: -7000, y: 0, z: 0 }, sun), true);
  assert.equal(inShadow({ x: 7000, y: 0, z: 0 }, sun), false);
  assert.equal(inShadow({ x: -7000, y: EARTH_RADIUS + 10, z: 0 }, sun), false);
});

test("fleets and bands", () => {
  assert.equal(fleetNames[fleetOf("STARLINK-1007")], "Starlink");
  assert.equal(fleetNames[fleetOf("ISS (ZARYA)")], "Crewed stations");
  assert.equal(fleetNames[fleetOf("CALSPHERE 1")], "Everything else");
  assert.equal(bandOf(550), "Low");
  assert.equal(bandOf(20200), "Medium");
  assert.equal(bandOf(35786), "Geostationary");
  assert.equal(bandOf(50000), "High");
});

test("every object in today's catalogue either computes or is safely refused", () => {
  let ok = 0;
  for (const r of all) {
    const p = positionAt(toSatrec(r), epoch);
    if (p) { assert.ok(Number.isFinite(p.x + p.y + p.z)); ok++; }
  }
  assert.ok(ok / all.length > 0.99, `only ${ok} of ${all.length}`);
});

test("sun elevation: noon is high, midnight is low", async () => {
  const { sunElevation, skyIsDark } = await import("../src/orbit.js");
  const quito = { lat: 0, lon: -78.5 };
  // Quito is close to UTC-5:14 by the Sun, so solar noon is near 17:14 UTC.
  assert.ok(sunElevation(quito, new Date("2026-03-20T17:14Z")) > 85);
  assert.ok(sunElevation(quito, new Date("2026-03-20T05:14Z")) < -85);
  assert.equal(skyIsDark(quito, new Date("2026-03-20T05:14Z")), true);
  assert.equal(skyIsDark(quito, new Date("2026-03-20T17:14Z")), false);
});

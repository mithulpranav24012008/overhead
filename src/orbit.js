// The arithmetic of orbits, with no drawing in it. Everything here is checked by the tests in test/orbit.test.mjs.
import { json2satrec, propagate, gstime, eciToGeodetic, ecfToLookAngles, eciToEcf } from "satellite.js";

export const EARTH_RADIUS = 6378.137; // km
const DEG = Math.PI / 180;
const MINUTE = 60_000;

// The catalogue is stored as rows to keep the download small. These are the columns, in order.
const COLUMNS = ["OBJECT_NAME", "OBJECT_ID", "NORAD_CAT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT", "REV_AT_EPOCH", "ELEMENT_SET_NO"];
export const pack = (records) => records.map((r) => COLUMNS.map((c) => r[c]));
export function unpack(rows) {
  return rows.map((row) => {
    const r = { EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U" };
    COLUMNS.forEach((c, i) => { r[c] = row[i]; });
    return r;
  });
}

export const toSatrec = (record) => json2satrec(record);

// Position in km, inertial frame, or null if the orbit has no valid answer at this time (a decayed object, for instance).
export function positionAt(satrec, date) {
  const { position } = propagate(satrec, date) ?? {};
  if (!position || !Number.isFinite(position.x)) return null;
  return position;
}

// Latitude and longitude in degrees, and height in km, under a satellite at a moment.
export function groundPoint(satrec, date) {
  const p = positionAt(satrec, date);
  if (!p) return null;
  const g = eciToGeodetic(p, gstime(date));
  return { lat: g.latitude / DEG, lon: ((g.longitude / DEG + 540) % 360) - 180, height: g.height };
}

// How fast it's moving, in km/s.
export function speedAt(satrec, date) {
  const { velocity } = propagate(satrec, date) ?? {};
  return velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : null;
}

// Where it appears from a spot on the ground. Elevation 0 is the horizon and 90 straight overhead. Azimuth runs clockwise from north.
export function lookFrom(place, satrec, date) {
  const p = positionAt(satrec, date);
  if (!p) return null;
  const gmst = gstime(date);
  const look = ecfToLookAngles({ longitude: place.lon * DEG, latitude: place.lat * DEG, height: (place.height ?? 0) / 1000 }, eciToEcf(p, gmst));
  return { azimuth: look.azimuth / DEG, elevation: look.elevation / DEG, range: look.rangeSat };
}

// The rising, highest point and setting of each pass over a place. Steps along by the minute, then narrows each crossing to the second.
export function passes(place, satrec, from, { hours = 48, minElevation = 10, limit = 8 } = {}) {
  const elevationAt = (t) => lookFrom(place, satrec, new Date(t))?.elevation ?? -90;
  const narrow = (a, b, rising) => {
    for (let i = 0; i < 16; i++) {
      const mid = (a + b) / 2;
      if ((elevationAt(mid) > 0) === rising) b = mid; else a = mid;
    }
    return b;
  };
  const out = [];
  const end = from.getTime() + hours * 3_600_000;
  let t = from.getTime();
  let previous = elevationAt(t);
  // Already overhead: go back to find where this pass began.
  let rise = previous > 0 ? t : null;
  if (rise) {
    let back = t;
    while (elevationAt(back) > 0 && t - back < 3 * 3_600_000) back -= MINUTE;
    rise = narrow(back, back + MINUTE, true);
  }
  while (t < end && out.length < limit) {
    t += MINUTE;
    const here = elevationAt(t);
    if (!rise && previous <= 0 && here > 0) rise = narrow(t - MINUTE, t, true);
    if (rise && here <= 0) {
      const set = narrow(t - MINUTE, t, false);
      let peak = -90, peakTime = rise;
      const step = Math.max(5_000, (set - rise) / 120);
      for (let s = rise; s <= set; s += step) {
        const e = elevationAt(s);
        if (e > peak) { peak = e; peakTime = s; }
      }
      if (peak >= minElevation) out.push({ rise: new Date(rise), peak: new Date(peakTime), set: new Date(set), elevation: peak, track: track(place, satrec, rise, set) });
      rise = null;
    }
    previous = here;
  }
  return out;
}

function track(place, satrec, rise, set) {
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const look = lookFrom(place, satrec, new Date(rise + ((set - rise) * i) / 24));
    if (look) points.push({ azimuth: look.azimuth, elevation: Math.max(0, look.elevation) });
  }
  return points;
}

// The direction of the Sun from Earth's centre as a unit vector in the inertial frame. Low-precision formula from the Astronomical Almanac, good to about 0.01 degrees.
export function sunDirection(date) {
  const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const epsilon = (23.439 - 0.0000004 * n) * DEG;
  return { x: Math.cos(lambda), y: Math.cos(epsilon) * Math.sin(lambda), z: Math.sin(epsilon) * Math.sin(lambda) };
}

// Whether a satellite is in Earth's shadow, using a simple cylinder. Good enough to say whether it could catch the light.
export function inShadow(position, sun) {
  const along = position.x * sun.x + position.y * sun.y + position.z * sun.z;
  if (along > 0) return false;
  const off = Math.hypot(position.x - along * sun.x, position.y - along * sun.y, position.z - along * sun.z);
  return off < EARTH_RADIUS;
}

// The named fleets, by what their names start with. Anything else is "Everything else".
const FLEETS = [
  ["Starlink", /^STARLINK/],
  ["OneWeb", /^ONEWEB/],
  ["Amazon Kuiper", /^KUIPER/],
  ["Qianfan", /^QIANFAN/],
  ["Guowang", /^(HULIANWANG|GUOWANG)/],
  ["Planet", /^(FLOCK|SKYSAT|DOVE|PELICAN)/],
  ["Spire", /^LEMUR/],
  ["Iridium", /^IRIDIUM/],
  ["GPS and other navigation", /^(NAVSTAR|GPS|GALILEO|GLONASS|COSMOS 2[45]\d\d \(GLONASS|BEIDOU|QZS|IRNSS|NAVIC)/],
  ["Crewed stations", /^(ISS |CSS |TIANGONG|TIANHE|WENTIAN|MENGTIAN|SHENZHOU|SOYUZ|PROGRESS)/],
];
export const fleetNames = [...FLEETS.map(([name]) => name), "Everything else"];
export function fleetOf(name) {
  const i = FLEETS.findIndex(([, match]) => match.test(name));
  return i < 0 ? FLEETS.length : i;
}

// Which band of the sky an orbit belongs to, from its average height.
export function bandOf(heightKm) {
  if (heightKm < 2000) return "Low";
  if (heightKm < 35000) return "Medium";
  if (heightKm < 36500) return "Geostationary";
  return "High";
}

// Average height of an orbit in km, from how many times a day it goes round.
export function meanHeight(meanMotion) {
  const mu = 398600.4418;
  const n = (meanMotion * 2 * Math.PI) / 86400;
  return Math.cbrt(mu / (n * n)) - EARTH_RADIUS;
}

// The time an orbit takes in minutes.
export const periodMinutes = (meanMotion) => 1440 / meanMotion;

// Whether the sky over a place is dark enough to see a satellite: the Sun at least 6 degrees below the horizon.
export function sunElevation(place, date) {
  const s = sunDirection(date);
  const gmst = gstime(date);
  const lat = place.lat * DEG, lon = place.lon * DEG + gmst;
  const sinEl = Math.sin(lat) * s.z + Math.cos(lat) * (Math.cos(lon) * s.x + Math.sin(lon) * s.y);
  return Math.asin(sinEl) / DEG;
}
export const skyIsDark = (place, date) => sunElevation(place, date) < -6;

// A pass you could really see: the satellite is in sunlight at its highest point while the ground below is dark.
export function canSee(place, satrec, pass) {
  const p = positionAt(satrec, pass.peak);
  return !!p && skyIsDark(place, pass.peak) && !inShadow(p, sunDirection(pass.peak));
}

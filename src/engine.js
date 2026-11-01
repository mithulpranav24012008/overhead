// Turns the catalogue into positions. Used by the worker, or on the page itself if workers aren't allowed.
import { propagate } from "satellite.js";
import { toSatrec, unpack } from "./orbit.js";

export const ER = 6378.137;
export const buildSatrecs = (rows) => unpack(rows).map(toSatrec);

// Fills `out` with x, y, z per object, in Earth radii and the scene's axes: y through the north pole. An object with no valid answer gets 0, 0, 0 and is hidden.
export function fill(satrecs, date, out) {
  for (let i = 0; i < satrecs.length; i++) {
    const p = propagate(satrecs[i], date)?.position;
    const j = i * 3;
    if (p && Number.isFinite(p.x)) {
      out[j] = p.x / ER;
      out[j + 1] = p.z / ER;
      out[j + 2] = -p.y / ER;
    } else out[j] = out[j + 1] = out[j + 2] = 0;
  }
  return out;
}

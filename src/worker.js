import { buildSatrecs, fill } from "./engine.js";
let satrecs = [];
self.onmessage = ({ data }) => {
  if (data.rows) {
    satrecs = buildSatrecs(data.rows);
    self.postMessage({ ready: true });
    return;
  }
  const out = new Float32Array(data.buffer);
  fill(satrecs, new Date(data.time), out);
  self.postMessage({ id: data.id, time: data.time, buffer: out.buffer }, [out.buffer]);
};

import { gstime } from "satellite.js";
import { toSatrec, unpack, pack, positionAt, groundPoint, speedAt, passes, canSee, sunDirection, inShadow, fleetOf, fleetNames, bandOf, meanHeight, periodMinutes } from "./orbit.js";
import { buildSatrecs, fill } from "./engine.js";
import { CITIES, guessCity } from "./cities.js";
import { createGlobe } from "./globe.js";

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const still = matchMedia("(prefers-reduced-motion: reduce)");
const wideQuery = matchMedia("(min-width: 900px)");
const nf = new Intl.NumberFormat("en");
document.documentElement.classList.add("js");

function spring(s, to, dt, response = 0.3) {
  const w = (Math.PI * 2) / response;
  const steps = Math.ceil(dt * 240);
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (w * w * (to - s.x) - 2 * w * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}

// ---- state ----
const state = {
  records: [], heights: null, fleets: null, count: 0,
  city: guessCity(), chosen: null, follow: true, fleet: -1,
  speed: 1, simBase: Date.now(), realBase: performance.now(),
  ceiling: Infinity, heightActive: false,
};
const simNow = () => state.simBase + (performance.now() - state.realBase) * state.speed;
function setSpeed(speed) {
  const t = simNow();
  state.speed = speed;
  state.simBase = t;
  state.realBase = performance.now();
  document.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.speed === speed)));
  showClockButton();
  wake();
}
function backToNow() {
  state.speed = 1;
  state.simBase = Date.now();
  state.realBase = performance.now();
  document.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.speed === 1)));
  showClockButton();
  restartKeys();
}
const isLive = () => state.speed === 1 && Math.abs(simNow() - Date.now()) < 5000;
function showClockButton() { $("#now").hidden = isLive() && state.speed === 1; }

// ---- positions: a worker works out two moments, and the graphics card draws everything between them ----
let worker = null, satrecsHere = null, requestId = 0, waiting = false;
let spare = null;
// Two moments are held, one in each slot on the graphics card. Each new one replaces the older, so only one upload is ever needed.
const keys = { times: [0, 0], older: 0, has: 0, latest: null };
const SPAN = () => clamp(state.speed * 0.5, 15, 150) * 1000; // simulated ms between moments: short enough that a straight line matches the curve
function startEngine(rows) {
  return new Promise((resolve) => {
    const onMain = () => {
      worker = null;
      satrecsHere = buildSatrecs(rows);
      resolve();
    };
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        if (data.ready) { resolve(); return; }
        receiveKey(data.time, data.id, new Float32Array(data.buffer));
      };
      worker.onerror = () => { if (worker) onMain(); };
      worker.postMessage({ rows });
    } catch { onMain(); }
  });
}
function requestKey(time) {
  waiting = true;
  const id = ++requestId;
  const buffer = spare ?? new Float32Array(state.count * 3);
  spare = null;
  if (worker) worker.postMessage({ time, id, buffer: buffer.buffer }, [buffer.buffer]);
  else {
    fill(satrecsHere, new Date(time), buffer);
    setTimeout(() => receiveKey(time, id, buffer), 0);
  }
}
let globe = null;
function receiveKey(time, id, array) {
  waiting = false;
  spare = array;
  // An answer to a question from before a jump in time is no use.
  if (id !== requestId) { needKeys(); return; }
  const slot = keys.older;
  keys.times[slot] = time;
  keys.older = slot ? 0 : 1;
  keys.has = Math.min(2, keys.has + 1);
  keys.slot = slot;
  globe?.setKey(slot, array);
  keys.latest = keys.latest ?? new Float32Array(array.length);
  keys.latest.set(array);
  onNewKey();
  needKeys();
  wake();
}
// The one place that decides what to work out next.
function needKeys() {
  if (waiting || !state.count) return;
  const t = simNow();
  if (keys.has === 0) { requestKey(t); return; }
  const newest = keys.has === 1 ? keys.times[0] : Math.max(...keys.times);
  if (keys.has === 1) { requestKey(newest + SPAN()); return; }
  // Keep one moment ahead. If time has run past it, skip ahead instead of trying to catch up.
  if (t > newest - SPAN() * 0.5) requestKey(t > newest ? t + SPAN() * 0.5 : newest + SPAN());
}
function restartKeys() {
  keys.has = 0;
  keys.older = 0;
  requestId++; // whatever is on its way is now out of date
  waiting = false;
  needKeys();
  wake();
}
function drawBlend(t) {
  if (keys.has === 1) { globe.setBlend(0); return; }
  if (keys.has !== 2) return;
  const [a, b] = keys.times;
  const u = clamp((t - Math.min(a, b)) / Math.max(1, Math.abs(b - a)), 0, 1);
  globe.setBlend(a <= b ? u : 1 - u);
}

// ---- catalogue ----
async function loadCatalogue() {
  const res = await fetch(new URL("catalogue.json", document.baseURI));
  if (!res.ok) throw new Error(`catalogue ${res.status}`);
  return res.json();
}
// CelesTrak allows this request but asks for restraint, so a fresher copy is only fetched when ours is over a day old, at most once a day per browser, and it's kept for the next visit.
const FRESH_KEY = "overhead-orbits";
const DAY = 86_400_000;
async function freshest(bundled) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(FRESH_KEY)); } catch {}
  const best = saved && Date.parse(saved.fetched) > Date.parse(bundled.fetched) ? saved : bundled;
  if (Date.now() - Date.parse(best.fetched) < DAY) return best;
  try {
    if (Date.now() - (+localStorage.getItem(`${FRESH_KEY}-tried`) || 0) < DAY) return best;
    localStorage.setItem(`${FRESH_KEY}-tried`, String(Date.now()));
  } catch {}
  try {
    const res = await fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json", { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return best;
    const fresh = { fetched: new Date().toISOString(), rows: pack(await res.json()) };
    try { localStorage.setItem(FRESH_KEY, JSON.stringify(fresh)); } catch {}
    return fresh;
  } catch { return best; } // blocked or offline: the copy we have still works
}

function adopt(rows, fetched) {
  state.records = unpack(rows);
  state.count = rows.length;
  state.fetched = fetched;
  state.heights = new Float32Array(state.count);
  state.fleets = new Float32Array(state.count);
  state.names = state.records.map((r) => r.OBJECT_NAME);
  state.upper = state.names.map((n) => n.toUpperCase());
  state.fleetCounts = new Array(fleetNames.length).fill(0);
  state.records.forEach((r, i) => {
    state.heights[i] = meanHeight(r.MEAN_MOTION);
    const f = fleetOf(r.OBJECT_NAME);
    state.fleets[i] = f;
    state.fleetCounts[f]++;
  });
  state.sorted = Float32Array.from(state.heights).sort();
  $("#count-big").textContent = nf.format(state.count);
  const age = Date.now() - Date.parse(fetched);
  const h = Math.round(age / 3_600_000);
  $("#faq-age").textContent = h < 1 ? "this copy was fetched from CelesTrak less than an hour ago" : h < 48 ? `this copy was fetched from CelesTrak ${h} hours ago` : `this copy was fetched from CelesTrak ${Math.round(h / 24)} days ago`;
  buildFleets();
  updateHeight();
}

// ---- clock ----
function zoneTime(ms, withDate) {
  const options = { timeZone: state.city.zone, hour: "2-digit", minute: "2-digit", second: withDate ? undefined : "2-digit", hourCycle: "h23" };
  if (withDate) { options.weekday = "short"; options.day = "numeric"; options.month = "short"; }
  return new Intl.DateTimeFormat("en-GB", options).format(ms);
}
let lastClock = 0;
function drawClock(t) {
  if (performance.now() - lastClock < 240) return;
  lastClock = performance.now();
  const live = isLive();
  $("#clock").textContent = `${live ? "Live" : "Showing"} · ${zoneTime(t, !live)} in ${state.city.name}`;
  showClockButton();
}

// ---- city ----
function fillCities() {
  const list = $("#city-list");
  for (const c of CITIES) list.append(new Option(c.name));
  $("#city-input").value = state.city.name;
}
function setCity(city, { announce = true, travel = true } = {}) {
  state.city = city;
  document.querySelectorAll("[data-city-name]").forEach((n) => { n.textContent = city.name; });
  globe?.setHome(city.lat, city.lon);
  $("#city-status").textContent = announce ? `Showing the sky over ${city.name}.` : "";
  $("#city-input").value = city.name;
  if (travel) lookAtCity();
  workOutPasses();
  drawSky();
  refreshCard(true);
  wake();
}
$("#city-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const typed = $("#city-input").value.trim().toLowerCase();
  const city = CITIES.find((c) => c.name.toLowerCase() === typed) ?? CITIES.find((c) => c.name.toLowerCase().startsWith(typed));
  if (!typed || !city) {
    $("#city-status").textContent = "I don't have that city. Try a large city near you, or use your location.";
    return;
  }
  setCity(city);
  $("#sky").scrollIntoView({ behavior: still.matches ? "auto" : "smooth" });
});
$("#locate").addEventListener("click", () => {
  const status = $("#city-status");
  if (!navigator.geolocation) { status.textContent = "This browser can't share a location. Type a city instead."; return; }
  status.textContent = "Asking your browser";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setCity({ name: "your location", lat: coords.latitude, lon: coords.longitude, zone }, { announce: false });
      $("#city-input").value = "";
      status.textContent = "Showing the sky over your location. It isn't sent anywhere.";
    },
    () => { status.textContent = "No location was shared. Type a city instead."; },
    { maximumAge: 600000, timeout: 10000 },
  );
});

// ---- passes ----
function namedSatrec(name) {
  const r = state.records.find((x) => x.OBJECT_NAME === name);
  return r ? { name, satrec: toSatrec(r) } : null;
}
function workOutPasses() {
  if (!state.count) return;
  const list = $("#passes");
  const from = new Date(simNow());
  const place = state.city;
  const watch = [["ISS (ZARYA)", "International Space Station"], ["HST", "Hubble Space Telescope"], ["CSS (TIANHE)", "Tiangong space station"]];
  const rows = [];
  for (const [name, label] of watch) {
    const found = namedSatrec(name);
    if (!found) continue;
    for (const p of passes(place, found.satrec, from, { hours: 48, limit: 5 })) rows.push({ ...p, name, label, visible: canSee(place, found.satrec, p) });
  }
  rows.sort((a, b) => (b.visible - a.visible) || a.rise - b.rise);
  const next = rows[0];
  const line = $("#next-pass");
  line.hidden = !next;
  if (next) line.textContent = `Next over ${place.name}: ${next.label}, ${zoneTime(next.rise, true)}${next.visible ? ", you could see it" : ""}.`;
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = `Nothing with a name passes high over ${place.name} in the next two days.`;
    list.append(li);
    return;
  }
  for (const p of rows.slice(0, 6)) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    if (p.visible) b.className = "visible";
    const minutes = Math.round((p.set - p.rise) / 60000);
    const cells = [["who", p.label], ["see", p.visible ? "You could see it" : "Passes unseen"], ["when", zoneTime(p.rise, true)], ["how", `${Math.round(p.elevation)}° high, ${minutes} min`]];
    for (const [cls, text] of cells) { const s = document.createElement("span"); s.className = cls; s.textContent = text; b.append(s); }
    b.addEventListener("click", () => choose(state.records.findIndex((r) => r.OBJECT_NAME === p.name)));
    li.append(b);
    list.append(li);
  }
}

// ---- the sky chart: the circle with you in the middle ----
const sky = $("#sky-chart");
const skyCtx = sky.getContext("2d");
let skyVisible = false;
function drawSky() {
  const pos = keys.latest;
  if (!pos) return;
  const t = simNow();
  const gmst = gstime(new Date(t));
  const lat = (state.city.lat * Math.PI) / 180, lon = (state.city.lon * Math.PI) / 180 + gmst;
  // Up, east and north at the place, in the scene's axes.
  const up = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
  const east = [-Math.sin(lon), 0, -Math.cos(lon)];
  const north = [-Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
  const s = sunDirection(new Date(t));
  const sun = [s.x, s.z, -s.y];
  const size = sky.width, c = size / 2, R = c - 4;
  const g = skyCtx;
  const ink = "#ff99d3";
  g.clearRect(0, 0, size, size);
  g.fillStyle = "#4d0519";
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(255,153,211,.28)";
  g.lineWidth = 1.5;
  for (const f of [1 / 3, 2 / 3]) { g.beginPath(); g.arc(c, c, R * f, 0, Math.PI * 2); g.stroke(); }
  let above = 0, lit = 0;
  const ring = [];
  g.fillStyle = ink;
  for (let i = 0; i < state.count; i++) {
    const j = i * 3;
    const x = pos[j], y = pos[j + 1], z = pos[j + 2];
    if (x === 0 && y === 0 && z === 0) continue;
    const dx = x - up[0], dy = y - up[1], dz = z - up[2];
    const along = dx * up[0] + dy * up[1] + dz * up[2];
    if (along <= 0) continue;
    above++;
    const len = Math.hypot(dx, dy, dz);
    const elevation = Math.asin(along / len);
    const e = dx * east[0] + dy * east[1] + dz * east[2], n = dx * north[0] + dy * north[1] + dz * north[2];
    const az = Math.atan2(e, n);
    const r = R * (1 - elevation / (Math.PI / 2));
    const px = c + Math.sin(az) * r, py = c - Math.cos(az) * r;
    const sd = x * sun[0] + y * sun[1] + z * sun[2];
    const shadow = sd < 0 && Math.hypot(x - sd * sun[0], y - sd * sun[1], z - sd * sun[2]) < 1;
    if (shadow) ring.push(px, py);
    else { lit++; g.beginPath(); g.arc(px, py, 4, 0, Math.PI * 2); g.fill(); }
  }
  g.strokeStyle = ink;
  g.lineWidth = 1.5;
  for (let i = 0; i < ring.length; i += 2) { g.beginPath(); g.arc(ring[i], ring[i + 1], 3.5, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = "#fff0f7";
  g.beginPath(); g.arc(c, c, 7, 0, Math.PI * 2); g.fill();
  // The compass goes on last, each letter on its own small disc, so the dots can't bury it.
  g.font = "500 22px 'Stack Sans Text', sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  for (const [letter, x, y] of [["N", c, 26], ["S", c, size - 26], ["E", size - 26, c], ["W", 26, c]]) {
    g.fillStyle = "#3d0012";
    g.beginPath(); g.arc(x, y, 20, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff0f7";
    g.fillText(letter, x, y + 1);
  }
  $("#sky-count").textContent = nf.format(above);
  $("#sky-lit").textContent = lit === above ? "all" : nf.format(lit);
}
new IntersectionObserver(([e]) => { skyVisible = e.isIntersecting; if (skyVisible) drawSky(); }).observe(sky);

// ---- fleets ----
function buildFleets() {
  const host = $("#fleet-list");
  host.replaceChildren();
  const star = state.fleetCounts[0] / state.count;
  const words = [[0.75, "Three in every four"], [0.66, "Two in every three"], [0.6, "Three in every five"], [0.5, "Half of them"]];
  const said = words.find(([share]) => star >= share)?.[1];
  $("#fleet-head").textContent = said ? `${said} ${said.startsWith("Half") ? "are" : "are"} Starlink` : `${Math.round(star * 100)}% of them are Starlink`;
  const order = fleetNames.map((name, i) => ({ name, i, n: state.fleetCounts[i] })).sort((a, b) => b.n - a.n);
  const biggest = order[0].n;
  for (const { name, i, n } of order) {
    if (!n) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.dataset.fleet = i;
    const dot = document.createElement("span");
    dot.className = "bullet";
    const size = 8 + 18 * Math.sqrt(n / biggest);
    dot.style.width = dot.style.height = `${size}px`;
    const label = document.createElement("span"); label.className = "label"; label.textContent = name;
    const num = document.createElement("span"); num.className = "num"; num.textContent = nf.format(n);
    b.append(dot, label, num);
    b.addEventListener("click", () => {
      const on = state.fleet !== i;
      setFleet(on ? i : -1);
      // On a phone the Earth is at the top of the page, so go to it.
      if (on && !wideQuery.matches) canvas.scrollIntoView({ behavior: still.matches ? "auto" : "smooth", block: "center" });
    });
    host.append(b);
  }
}
function setFleet(i) {
  state.fleet = i;
  globe?.highlightFleet(i);
  document.querySelectorAll("[data-fleet]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.fleet === i)));
  $("#live").textContent = i < 0 ? "Showing every fleet." : `${fleetNames[i]} lit up on the globe.`;
  wake();
}

// ---- how high ----
const slider = $("#height-slider");
const ceilingKm = () => Math.round(200 * Math.pow(45000 / 200, +slider.value / 1000));
function countBelow(km) {
  let lo = 0, hi = state.sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (state.sorted[m] < km) lo = m + 1; else hi = m; }
  return lo;
}
function updateHeight() {
  if (!state.count) return;
  const km = ceilingKm();
  $("#height-km").textContent = `${nf.format(km)} km`;
  $("#height-count").textContent = nf.format(countBelow(km));
  state.ceiling = km;
  if (state.heightActive) globe?.setCeiling(km);
  const bands = { Low: 0, Medium: 0, Geostationary: 0, High: 0 };
  for (const h of state.heights) bands[bandOf(h)]++;
  const host = $("#bands");
  if (!host.childElementCount) {
    for (const [name, n] of Object.entries(bands)) {
      const d = document.createElement("div");
      d.innerHTML = `<dt></dt><dd></dd>`;
      d.firstChild.textContent = name === "High" ? "Beyond" : name;
      d.lastChild.textContent = nf.format(n);
      host.append(d);
    }
  }
  wake();
}
slider.addEventListener("input", updateHeight);

// ---- search ----
const findInput = $("#find-input"), findList = $("#find-list");
function search(text) {
  const q = text.trim().toUpperCase();
  if (q.length < 2) return [];
  const alias = { HUBBLE: "HST", ISS: "ISS (ZARYA)", TIANGONG: "CSS (TIANHE)", "SPACE STATION": "ISS (ZARYA)" }[q];
  const out = [];
  if (alias) { const i = state.names.indexOf(alias); if (i >= 0) out.push(i); }
  for (let i = 0; i < state.count && out.length < 8; i++) if (state.upper[i].startsWith(q) && !out.includes(i)) out.push(i);
  for (let i = 0; i < state.count && out.length < 8; i++) if (state.upper[i].includes(q) && !out.includes(i)) out.push(i);
  return out;
}
let findIndex = -1;
function renderResults() {
  const results = search(findInput.value);
  findList.replaceChildren();
  findList.hidden = !results.length;
  findInput.setAttribute("aria-expanded", String(!!results.length));
  findIndex = -1;
  for (const i of results) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "option");
    b.dataset.index = i;
    const name = document.createElement("span"); name.textContent = state.names[i];
    const fleet = document.createElement("small"); fleet.textContent = `${nf.format(Math.round(state.heights[i]))} km`;
    b.append(name, fleet);
    b.addEventListener("click", () => { choose(i); closeResults(); });
    li.append(b);
    findList.append(li);
  }
}
const closeResults = () => { findList.hidden = true; findInput.setAttribute("aria-expanded", "false"); };
findInput.addEventListener("input", renderResults);
findInput.addEventListener("keydown", (e) => {
  const options = [...findList.querySelectorAll("button")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!options.length) return;
    e.preventDefault();
    findIndex = (findIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options.forEach((b, i) => b.setAttribute("aria-selected", String(i === findIndex)));
    options[findIndex].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    (options[Math.max(0, findIndex)])?.click();
  } else if (e.key === "Escape") closeResults();
});
document.addEventListener("click", (e) => { if (!e.target.closest(".find")) closeResults(); });
document.querySelectorAll("[data-find]").forEach((b) => b.addEventListener("click", () => {
  choose(state.names.indexOf(b.dataset.find));
  $("#top").scrollIntoView({ behavior: still.matches ? "auto" : "smooth" });
}));
document.querySelectorAll("[data-find-fleet]").forEach((b) => b.addEventListener("click", () => {
  setFleet(fleetNames.indexOf(b.dataset.findFleet));
  $("#top").scrollIntoView({ behavior: still.matches ? "auto" : "smooth" });
}));

// ---- the chosen satellite ----
const card = $("#card");
let chosenRec = null;
function choose(i) {
  if (i == null || i < 0) { state.chosen = null; chosenRec = null; card.hidden = true; globe?.setChosen(null); globe?.setPath(null); wake(); return; }
  state.chosen = i;
  chosenRec = toSatrec(state.records[i]);
  card.hidden = false;
  const r = state.records[i];
  $("#card-fleet").textContent = fleetNames[state.fleets[i]];
  $("#card-name").textContent = r.OBJECT_NAME;
  $("#f-period").textContent = periodMinutes(r.MEAN_MOTION) < 200 ? `${periodMinutes(r.MEAN_MOTION).toFixed(1)} min` : `${(periodMinutes(r.MEAN_MOTION) / 60).toFixed(1)} hours`;
  $("#f-launch").textContent = String(r.OBJECT_ID).slice(0, 4);
  $("#follow").checked = state.follow = true;
  refreshCard(true);
  drawPath();
  aimAtChosen();
  $("#live").textContent = `${r.OBJECT_NAME}, ${fleetNames[state.fleets[i]]}.`;
  wake();
}
let nextKey = "";
function refreshCard(force) {
  if (state.chosen == null) return;
  const date = new Date(simNow());
  const g = groundPoint(chosenRec, date);
  const p = positionAt(chosenRec, date);
  if (!g || !p) { $("#f-height").textContent = "No longer valid"; return; }
  $("#f-height").textContent = `${nf.format(Math.round(g.height))} km`;
  $("#f-speed").textContent = `${speedAt(chosenRec, date).toFixed(2)} km/s`;
  $("#f-over").textContent = `${Math.abs(g.lat).toFixed(1)}°${g.lat >= 0 ? "N" : "S"}, ${Math.abs(g.lon).toFixed(1)}°${g.lon >= 0 ? "E" : "W"}`;
  $("#f-light").textContent = inShadow(p, sunDirection(date)) ? "Earth's shadow" : "Sunlight";
  // Finding the next pass is the slow part, so it only runs on a new choice, a new city or a jump in time.
  const key = `${state.chosen}|${state.city.name}`;
  if (force || key !== nextKey) {
    nextKey = key;
    const [next] = passes(state.city, chosenRec, date, { hours: 72, limit: 1, minElevation: 5 });
    $("#f-next").textContent = next ? zoneTime(next.rise, true) : "Not within 3 days";
  }
}
function drawPath() {
  if (state.chosen == null || !globe) return;
  const period = periodMinutes(state.records[state.chosen].MEAN_MOTION) * 60000;
  const t = simNow();
  const out = [];
  for (let i = 0; i <= 180; i++) {
    const p = positionAt(chosenRec, new Date(t - period / 2 + (period * i) / 180));
    if (p) out.push({ x: p.x / 6378.137, y: p.z / 6378.137, z: -p.y / 6378.137 });
  }
  globe.setPath(out);
}
function chosenScene(t) {
  const p = positionAt(chosenRec, new Date(t));
  return p ? { x: p.x / 6378.137, y: p.z / 6378.137, z: -p.y / 6378.137 } : null;
}
$("#card-close").addEventListener("click", () => choose(null));
$("#follow").addEventListener("change", (e) => { state.follow = e.target.checked; if (state.follow) aimAtChosen(); });

addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, select, textarea")) return;
  if (e.key === "Escape" && state.chosen != null) { choose(null); return; }
  if (state.chosen != null && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    choose((state.chosen + (e.key === "ArrowRight" ? 1 : -1) + state.count) % state.count);
  }
});

// ---- 3D ----
const canvas = $("#globe");
const view = { az: { x: 0.4, v: 0 }, el: { x: 0.2, v: 0 }, azTo: 0.4, elTo: 0.2, zoom: { x: 1, v: 0 }, zoomTo: 1, dist: { x: 3.3, v: 0 }, shift: { x: 0.26, v: 0 } };
const TURN = Math.PI * 2;
const nearest = (angle, from) => angle + Math.round((from - angle) / TURN) * TURN;
function aim(az, el) {
  view.azTo = nearest(az, view.azTo);
  view.elTo = nearest(el, view.elTo);
  if (still.matches) { view.az.x = view.azTo; view.el.x = view.elTo; }
  wake();
}
function aimAt(x, y, z) { aim(Math.atan2(x, z), Math.atan2(y, Math.hypot(x, z))); }
function aimAtChosen() {
  if (state.chosen == null) return;
  const p = chosenScene(simNow());
  if (p) aimAt(p.x, p.y, p.z);
}
function lookAtCity() {
  const gmst = gstime(new Date(simNow()));
  const la = (state.city.lat * Math.PI) / 180, lo = (state.city.lon * Math.PI) / 180 + gmst;
  aimAt(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}

let scheduled = false, timer = 0, last = 0, visible = true;
let wake = () => {};
let drag = null;
const fingers = new Map();
const projected = { x: 0, y: 0, front: true, hidden: false };
function pointAt(e) {
  const box = canvas.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  const pos = keys.latest;
  if (!pos || !globe) return -1;
  let best = -1, bestD = (e.pointerType === "mouse" ? 11 : 22) ** 2;
  const ceiling = state.ceiling, limited = state.heightActive, pick = state.fleet;
  for (let i = 0; i < state.count; i++) {
    const j = i * 3;
    const x = pos[j], y = pos[j + 1], z = pos[j + 2];
    if (x === 0 && y === 0 && z === 0) continue;
    if (limited && state.heights[i] > ceiling) continue;
    if (pick >= 0 && state.fleets[i] !== pick) continue;
    globe.project(x, y, z, projected);
    if (!projected.front || projected.hidden) continue;
    const dx = projected.x - px, dy = projected.y - py, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function setupGlobe() {
  globe = createGlobe(canvas, state.count);
  globe.setFleets(state.fleets);
  globe.setHeights(state.heights);
  globe.setHome(state.city.lat, state.city.lon);
  const resize = () => {
    const box = canvas.parentElement.getBoundingClientRect();
    globe.resize(box.width, box.height);
    wake();
  };
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  const tip = $("#tip");
  const span = () => { const [a, b] = [...fingers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  canvas.addEventListener("pointerdown", (e) => {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2) { drag = { type: "pinch", from: span(), zoom: view.zoomTo }; canvas.setPointerCapture?.(e.pointerId); return; }
    if (!e.isPrimary) return;
    drag = { type: "turn", x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, still: true, flip: Math.cos(view.el.x) < 0 ? -1 : 1, vx: 0, vy: 0, t: e.timeStamp };
    if (e.pointerType !== "touch") canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag?.type === "pinch") {
      if (fingers.size === 2) { view.zoomTo = clamp(drag.zoom * (drag.from / Math.max(1, span())), 0.3, 6); wake(); }
      return;
    }
    if (drag?.type === "turn" && e.isPrimary) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) drag.still = false;
      // A globe close up should turn slower, so it stays under the finger.
      const rate = 0.0052 * clamp(view.dist.x * view.zoom.x / 4.5, 0.5, 1.6);
      view.azTo -= dx * rate * drag.flip;
      view.elTo += dy * rate;
      const dt = Math.max(1, e.timeStamp - drag.t) / 1000;
      drag.t = e.timeStamp;
      drag.vx = drag.vx * 0.6 + (dx / dt) * rate * 0.4;
      drag.vy = drag.vy * 0.6 + (dy / dt) * rate * 0.4;
      if (!drag.still) { state.follow = false; if (state.chosen != null) $("#follow").checked = false; }
      tip.hidden = true;
      wake();
      return;
    }
    if (e.pointerType === "mouse" && !drag) {
      const i = pointAt(e);
      canvas.style.cursor = i >= 0 ? "pointer" : "";
      tip.hidden = i < 0;
      if (i >= 0) {
        const box = canvas.getBoundingClientRect();
        tip.textContent = state.names[i];
        const x = Math.min(e.clientX - box.left + 14, box.width - tip.offsetWidth - 8);
        tip.style.transform = `translate(${x}px, ${e.clientY - box.top + 14}px)`;
      }
    }
  });
  const end = (e) => {
    fingers.delete(e.pointerId);
    if (drag?.type === "pinch") { drag = null; return; }
    if (drag?.type === "turn" && e.isPrimary) {
      if (drag.still && e.type === "pointerup") {
        const i = pointAt(e);
        if (i >= 0) choose(i);
      } else if (!still.matches && e.timeStamp - drag.t < 60) {
        view.azTo -= drag.vx * drag.flip * 0.16;
        view.elTo += drag.vy * 0.16;
      }
      drag = null;
      wake();
    }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { if (!drag) tip.hidden = true; });
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // a plain wheel still scrolls the page
    e.preventDefault();
    view.zoomTo = clamp(view.zoomTo * Math.exp(e.deltaY * 0.01), 0.3, 6);
    wake();
  }, { passive: false });
  document.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => { view.zoomTo = clamp(view.zoomTo * +b.dataset.zoom, 0.3, 6); wake(); }));
  document.querySelectorAll("[data-speed]").forEach((b) => b.addEventListener("click", () => setSpeed(+b.dataset.speed)));
  $("#now").addEventListener("click", backToNow);

  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake(); }, { threshold: 0 }).observe(canvas);

  // Pull back while the height section is being read, so the ceiling can be seen.
  new IntersectionObserver(([e]) => {
    state.heightActive = e.isIntersecting;
    globe.setCeiling(state.heightActive ? state.ceiling : 1e6);
    wake();
  }, { rootMargin: "-30% 0px -30% 0px" }).observe($("#height"));
  addEventListener("scroll", () => wake(), { passive: true });

  // There is only ever one frame waiting, so nothing can start a second loop running alongside the first.
  wake = () => {
    if (timer) { clearTimeout(timer); timer = 0; scheduled = false; }
    if (scheduled || !visible || document.hidden) return;
    scheduled = true;
    requestAnimationFrame(loop);
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) return; last = 0; backIfDrifted(); wake(); });
  globe.place(view.az.x, view.el.x, view.dist.x, view.shift.x);
  setCity(state.city, { announce: false, travel: true });
  view.az.x = view.azTo;
  view.el.x = view.elTo;
  window.__overhead = { state, view, globe, keys, choose, simNow, setFleet, pointAt, renderedFrames: 0 };
  requestAnimationFrame(() => wake());
  setTimeout(() => globe.renderer.compile(globe.scene, globe.camera), 0);
}
function backIfDrifted() {
  // A tab left in the background comes back to the present rather than a stale moment.
  if (keys.has < 2 || simNow() > Math.max(...keys.times) + 300000) restartKeys();
}

function onNewKey() {
  if (skyVisible && (performance.now() - (onNewKey.sky ?? 0) > 1000)) { onNewKey.sky = performance.now(); drawSky(); }
  if (state.chosen != null) refreshCard(false);
  if (state.count && !$("#clock").dataset.started) { $("#clock").dataset.started = "1"; workOutPasses(); drawSky(); }
}

function loop(now) {
  scheduled = false;
  const dt = last ? Math.min((now - last) / 1000, 1 / 8) : 1 / 60;
  last = now;
  let moving = false;
  const t = simNow();
  needKeys();
  drawBlend(t);
  const date = new Date(t);
  globe.setRotation(gstime(date));
  globe.setSun(sunDirection(date));
  drawClock(t);

  // ---- chosen ----
  if (state.chosen != null) {
    const p = chosenScene(t);
    globe.setChosen(p);
    if (p && state.follow && !drag) aimAt(p.x, p.y, p.z);
    if (now - (loop.card ?? 0) > 500) { loop.card = now; refreshCard(false); }
    if (state.speed > 1 && now - (loop.path ?? 0) > 1000) { loop.path = now; drawPath(); }
  }

  // ---- camera: big and cropped at the top of the page, then smaller as you read ----
  const wide = wideQuery.matches;
  const scrolled = wide ? clamp(scrollY / Math.max(1, innerHeight * 0.8), 0, 1) : 0;
  const ease = scrolled * scrolled * (3 - 2 * scrolled);
  let distTo = wide ? 3.15 + (6.2 - 3.15) * ease : 4.7;
  let shiftTo = wide ? 0.31 - 0.06 * ease : 0;
  if (state.heightActive && wide) {
    const r = 1 + state.ceiling / 6378;
    distTo = Math.max(distTo, Math.min(r * 4.2, 34));
  }
  const smooth = still.matches ? null : 1;
  if (smooth) { spring(view.dist, distTo, dt, 0.55); spring(view.shift, shiftTo, dt, 0.55); spring(view.zoom, view.zoomTo, dt, 0.3); spring(view.az, view.azTo, dt, 0.3); spring(view.el, view.elTo, dt, 0.3); }
  else { view.dist.x = distTo; view.shift.x = shiftTo; view.zoom.x = view.zoomTo; view.az.x = view.azTo; view.el.x = view.elTo; }
  if (Math.abs(view.dist.x - distTo) > 0.002 || Math.abs(view.shift.x - shiftTo) > 0.0005 || Math.abs(view.zoom.x - view.zoomTo) > 0.002 || Math.abs(view.az.x - view.azTo) > 0.0005 || Math.abs(view.el.x - view.elTo) > 0.0005) moving = true;
  globe.place(view.az.x, view.el.x, view.dist.x * view.zoom.x, view.shift.x);
  globe.render();
  if (window.__overhead) window.__overhead.renderedFrames++;

  // Satellites crawl at full speed, so with nobody touching anything a dozen frames a second is plenty, and the laptop stays cool.
  if (scheduled || !visible || document.hidden) return;
  scheduled = true;
  if (moving || drag || state.speed > 1) requestAnimationFrame(loop);
  else timer = setTimeout(() => { timer = 0; requestAnimationFrame(loop); }, 80);
}

// ---- entrances ----
function entrances() {
  if (still.matches) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -6% 0px" });
  document.querySelectorAll(".sec, .band, .foot").forEach((section) => {
    [...section.children].forEach((child, i) => {
      child.dataset.in = "";
      child.style.setProperty("--i", Math.min(i, 6));
      io.observe(child);
    });
  });
}

// ---- start ----
// The Earth may be off screen on a phone, or missing altogether, while the sky chart is in view, and that still needs fresh positions and a running clock.
setInterval(() => {
  if (document.hidden || !state.count || !(visible || skyVisible)) return;
  needKeys();
  drawClock(simNow());
}, 500);
fillCities();
entrances();
document.querySelectorAll("[data-city-name]").forEach((n) => { n.textContent = state.city.name; });
try {
  const { rows, fetched } = await freshest(await loadCatalogue());
  adopt(rows, fetched);
  await startEngine(rows);
  try {
    setupGlobe();
  } catch (error) {
    console.warn("3D stage unavailable", error);
    document.documentElement.classList.add("no-3d");
    setCity(state.city, { announce: false, travel: false });
  }
  restartKeys();
} catch (error) {
  console.warn(error);
  $("#clock").textContent = "The orbit data didn't load. Reload to try again.";
}


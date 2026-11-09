// Free, key-less public services. Each one is used gently (one request per action) per its usage policy.
//  - Routing + detour times: OSRM public server (router.project-osrm.org), OpenStreetMap data.
//  - Place search (autocomplete): Photon by Komoot (photon.komoot.io), OpenStreetMap data.
//  - Places along the route: Nominatim (nominatim.openstreetmap.org), at most 1 request per second.
import { buildRoute } from './geo.js';

const OSRM = 'https://router.project-osrm.org';
const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const extraHeaders = typeof window === 'undefined' ? { 'User-Agent': 'RoadTripStops/1.0 (github.com/tri8602-del/Road-Trip-Stops)' } : {};

async function getJSON(url, opts = {}, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, headers: { ...extraHeaders, ...(opts.headers || {}) }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const ll = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

/** Driving route from start to end ([lon,lat]). Returns a route object (see geo.buildRoute). */
export async function fetchRoute(start, end) {
  const url = `${OSRM}/route/v1/driving/${ll(start)};${ll(end)}?overview=full&geometries=geojson&annotations=duration&steps=false`;
  const j = await getJSON(url);
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || 'No driving route found');
  const r = j.routes[0];
  const route = buildRoute(r.geometry.coordinates, r.legs.flatMap((l) => l.annotation.duration));
  route.osrmDuration = r.duration;
  route.osrmDistance = r.distance;
  return route;
}

/** OSRM table between sources and destinations; each item {ll, heading?}. Heading pins the side of a divided highway. */
export async function osrmTable(sources, dests) {
  const all = [...sources, ...dests];
  const coords = all.map((p) => ll(p.ll)).join(';');
  const bearings = all.map((p) => (p.heading != null ? `${Math.round(p.heading) % 360},45` : '')).join(';');
  const src = sources.map((_, i) => i).join(';');
  const dst = dests.map((_, i) => i + sources.length).join(';');
  const url = `${OSRM}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration,distance&bearings=${bearings}`;
  const j = await getJSON(url, {}, 25000);
  if (j.code !== 'Ok') throw new Error(j.message || 'Detour lookup failed');
  return { durations: j.durations, distances: j.distances };
}

/** Address / place autocomplete, biased toward where she is. */
export async function suggestPlaces(q, near) {
  const bias = near ? `&lat=${near[1].toFixed(3)}&lon=${near[0].toFixed(3)}` : '';
  const j = await getJSON(`${PHOTON}?q=${encodeURIComponent(q)}&limit=6&lang=en${bias}`, {}, 10000);
  return (j.features || []).map((f) => {
    const p = f.properties;
    const line1 = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || '';
    const line2 = [p.name && p.street ? [p.housenumber, p.street].filter(Boolean).join(' ') : '', p.city !== line1 ? p.city : '', p.state].filter(Boolean).join(', ');
    return { label: line1, detail: line2, ll: f.geometry.coordinates };
  }).filter((s) => s.label);
}

/** Reverse lookup for a coordinate (used to name "My location"). */
export async function reverseName(p) {
  try {
    const j = await getJSON(`https://photon.komoot.io/reverse?lon=${p[0]}&lat=${p[1]}&limit=1`, {}, 8000);
    const q = j.features?.[0]?.properties;
    return q ? [q.city || q.name, q.state].filter(Boolean).join(', ') : '';
  } catch { return ''; }
}

// Nominatim's policy: no more than one request per second. Every call waits its turn here.
let lastNominatim = 0;
async function nominatimTurn() {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
}

/** Places matching `phrase` inside a box. */
export async function searchBox(phrase, box) {
  await nominatimTurn();
  const vb = [box.west, box.north, box.east, box.south].map((v) => v.toFixed(4)).join(',');
  const url = `${NOMINATIM}?format=jsonv2&limit=40&bounded=1&extratags=1&addressdetails=1&countrycodes=us,ca&viewbox=${vb}&q=${encodeURIComponent(phrase)}`;
  return getJSON(url, {}, 15000);
}

/** Turn-by-turn steps from a point on the route (heading pinned to our direction) to a place. */
export async function stepsToPlace(from, heading, to) {
  const url = `${OSRM}/route/v1/driving/${ll(from)};${ll(to)}?steps=true&overview=false&bearings=${Math.round(heading) % 360},45;`;
  const j = await getJSON(url, {}, 12000);
  return j.routes?.[0]?.legs?.[0]?.steps || [];
}

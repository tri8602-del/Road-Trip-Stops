// Small geometry helpers. Coordinates are [lon, lat] (GeoJSON order) unless named lat/lon.
const R = 6371008.8; // metres
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export const MI = 1609.344;

export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Build a route object from coordinates plus per-segment durations (seconds).
 * cumDist[i] / cumTime[i] = metres / seconds from the start to coords[i].
 */
export function buildRoute(coords, segDurations) {
  const n = coords.length;
  const cumDist = new Float64Array(n);
  const cumTime = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cumDist[i] = cumDist[i - 1] + haversine(coords[i - 1], coords[i]);
    const d = segDurations && segDurations[i - 1] != null ? segDurations[i - 1] : haversine(coords[i - 1], coords[i]) / 25;
    cumTime[i] = cumTime[i - 1] + d;
  }
  return { coords, cumDist, cumTime, length: cumDist[n - 1], duration: cumTime[n - 1] };
}

// Project point p onto segment a-b using a local equirectangular plane. Returns {t, dist}.
function projectOnSegment(p, a, b) {
  const kx = Math.cos(toRad((a[1] + b[1]) / 2)) * 111320;
  const ky = 110574;
  const ax = a[0] * kx, ay = a[1] * ky;
  const bx = b[0] * kx - ax, by = b[1] * ky - ay;
  const px = p[0] * kx - ax, py = p[1] * ky - ay;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return { t, dist: Math.sqrt(dx * dx + dy * dy) };
}

/**
 * Nearest point on the route to p, searching only indexes [from, to).
 * Returns { along (m), offset (m), index, time (s from start) }.
 */
export function projectOnRoute(route, p, from = 0, to = route.coords.length - 1) {
  const { coords, cumDist, cumTime } = route;
  let best = { offset: Infinity, along: 0, index: 0, time: 0 };
  const lo = Math.max(0, from), hi = Math.min(coords.length - 1, to);
  for (let i = lo; i < hi; i++) {
    const a = coords[i], b = coords[i + 1];
    // cheap reject: bounding check in degrees (~0.5 deg > 40 km)
    if (Math.abs(a[1] - p[1]) > 0.6 && Math.abs(b[1] - p[1]) > 0.6) continue;
    const r = projectOnSegment(p, a, b);
    if (r.dist < best.offset) {
      const segLen = cumDist[i + 1] - cumDist[i];
      best = {
        offset: r.dist,
        along: cumDist[i] + r.t * segLen,
        index: i,
        time: cumTime[i] + r.t * (cumTime[i + 1] - cumTime[i]),
      };
    }
  }
  return best;
}

// Index of the first coordinate at or after a given along-distance (binary search).
export function indexAtDistance(route, along) {
  const { cumDist } = route;
  let lo = 0, hi = cumDist.length - 1;
  if (along <= 0) return 0;
  if (along >= cumDist[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] < along) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Point, time and heading at a given along-distance.
export function pointAtDistance(route, along) {
  const { coords, cumDist, cumTime } = route;
  const n = coords.length;
  along = Math.max(0, Math.min(route.length, along));
  let i = indexAtDistance(route, along);
  if (i === 0) i = 1;
  const a = coords[i - 1], b = coords[i];
  const seg = cumDist[i] - cumDist[i - 1];
  const t = seg > 0 ? (along - cumDist[i - 1]) / seg : 0;
  const pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // heading: look a little ahead/behind for a stable bearing
  const j = Math.min(n - 1, indexAtDistance(route, along + 150));
  const k = Math.max(0, indexAtDistance(route, along - 150) - 1);
  const head = bearing(coords[k], coords[Math.max(j, k + 1)]);
  return { point: pt, time: cumTime[i - 1] + t * (cumTime[i] - cumTime[i - 1]), heading: head, along };
}

/** Sample the route between two along-distances, every `step` metres (for corridor queries). */
export function sampleRoute(route, fromAlong, toAlong, step) {
  const out = [];
  for (let d = fromAlong; d < toAlong; d += step) out.push(pointAtDistance(route, d).point);
  out.push(pointAtDistance(route, toAlong).point);
  return out;
}

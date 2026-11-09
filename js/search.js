// Search-along-route logic. Pure functions where possible so they can be unit tested in Node.
import { haversine, projectOnRoute, indexAtDistance, pointAtDistance, sampleRoute, MI } from './geo.js';

// Words that mean a kind of place rather than a name. Each maps to Nominatim search phrases
// (OpenStreetMap tags in [key=value] form). Anything else she types is searched as a name.
const CATEGORIES = [
  { words: ['gas', 'gas station', 'gas stations', 'fuel', 'petrol', 'diesel'], phrases: ['[amenity=fuel]'] },
  { words: ['food', 'eat', 'restaurant', 'restaurants', 'lunch', 'dinner', 'breakfast', 'meal'], phrases: ['[amenity=fast_food]', '[amenity=restaurant]'] },
  { words: ['fast food', 'drive thru', 'drive-thru', 'drive through'], phrases: ['[amenity=fast_food]'] },
  { words: ['coffee', 'cafe', 'café'], phrases: ['[amenity=cafe]'] },
  { words: ['restroom', 'restrooms', 'bathroom', 'bathrooms', 'toilet', 'toilets', 'potty'], phrases: ['[amenity=toilets]', '[highway=rest_area]'] },
  { words: ['rest area', 'rest areas', 'rest stop', 'welcome center'], phrases: ['[highway=rest_area]'] },
  { words: ['travel plaza', 'truck stop', 'service plaza'], phrases: ['[highway=services]', 'travel center'] },
  { words: ['hotel', 'motel', 'lodging', 'hotels', 'motels'], phrases: ['[tourism=hotel]', '[tourism=motel]'] },
  { words: ['grocery', 'groceries', 'supermarket', 'grocery store'], phrases: ['[shop=supermarket]'] },
  { words: ['pharmacy', 'drugstore', 'drug store'], phrases: ['[amenity=pharmacy]'] },
  { words: ['ev', 'charging', 'charger', 'ev charger', 'ev charging', 'supercharger'], phrases: ['[amenity=charging_station]'] },
  { words: ['atm', 'cash'], phrases: ['[amenity=atm]'] },
  { words: ['park', 'playground'], phrases: ['[leisure=playground]', '[leisure=park]'] },
  { words: ['ice cream'], phrases: ['[amenity=ice_cream]', 'ice cream'] },
];

export function matchCategory(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return CATEGORIES.find((c) => c.words.includes(t)) || null;
}

/** What to send to the place search for what she typed. */
export function searchPhrases(text) {
  const cat = matchCategory(text);
  if (cat) return cat.phrases;
  const t = text.trim().replace(/\s+/g, ' ');
  return t ? [t] : [];
}

/** Loose name key so "Chick-fil-A", "chick fil a" and "Chickfila" compare equal. */
export function nameKey(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Split the look-ahead part of the route into boxes (chunks of route plus the corridor on each side).
 * Searching small boxes keeps each search focused on places near the road.
 * Returns [{ west, south, east, north }]
 */
export function corridorBoxes(route, carAlong, lookAheadM, corridorM, chunkM = 20000) {
  const boxes = [];
  const end = Math.min(route.length, carAlong + lookAheadM);
  for (let a = carAlong; a < end; a += chunkM) {
    const pts = sampleRoute(route, a, Math.min(end, a + chunkM), 1000);
    let w = 180, s = 90, e = -180, n = -90;
    for (const [lon, lat] of pts) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
    const dLat = corridorM / 110574;
    const dLon = corridorM / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
    boxes.push({ west: w - dLon, south: s - dLat, east: e + dLon, north: n + dLat });
  }
  return boxes;
}

const BORING = new Set(['parking', 'parking_space', 'bench', 'waste_basket', 'vending_machine', 'road', 'residential', 'track', 'service']);

/** Nominatim jsonv2 results -> places. Drops roads, towns and other things that aren't stops. */
export function parseNominatim(results) {
  const places = [];
  for (const r of results || []) {
    const cls = r.category || r.class;
    if (['highway', 'place', 'boundary', 'landuse', 'natural', 'waterway', 'railway', 'route'].includes(cls) &&
      !(cls === 'highway' && (r.type === 'rest_area' || r.type === 'services'))) continue;
    if (BORING.has(r.type)) continue;
    const tags = { [cls]: r.type, ...(r.extratags || {}) };
    const name = r.name || r.extratags?.brand || kindLabel(tags);
    if (!name) continue;
    places.push({
      id: `${r.osm_type}/${r.osm_id}`,
      name,
      brand: r.extratags?.brand || '',
      kind: kindLabel(tags),
      ll: [Number(r.lon), Number(r.lat)],
      hours: r.extratags?.opening_hours || '',
      address: formatAddress(r.address || {}),
      phone: r.extratags?.phone || r.extratags?.['contact:phone'] || '',
      website: r.extratags?.website || r.extratags?.['contact:website'] || '',
    });
  }
  return places;
}

export function kindLabel(tags) {
  if (tags.highway === 'rest_area') return 'Rest area';
  if (tags.highway === 'services') return 'Travel plaza';
  const map = {
    fuel: 'Gas', fast_food: 'Fast food', restaurant: 'Restaurant', cafe: 'Coffee', toilets: 'Restroom',
    pharmacy: 'Pharmacy', charging_station: 'EV charging', atm: 'ATM', ice_cream: 'Ice cream', bank: 'Bank',
  };
  if (map[tags.amenity]) return map[tags.amenity];
  if (tags.tourism === 'hotel' || tags.tourism === 'motel') return 'Hotel';
  if (tags.shop) return tags.shop === 'supermarket' ? 'Grocery' : cap(tags.shop.replace(/_/g, ' '));
  if (tags.leisure) return cap(tags.leisure.replace(/_/g, ' '));
  if (tags.amenity) return cap(tags.amenity.replace(/_/g, ' '));
  if (tags.tourism) return cap(tags.tourism.replace(/_/g, ' '));
  return '';
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function formatAddress(a) {
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  return [street, a.city || a.town || a.village || a.hamlet, a.state].filter(Boolean).join(', ');
}

/** Same place found twice (a building and a point, or two overlapping boxes): keep one. */
export function dedupePlaces(places) {
  const out = [];
  const seen = new Set();
  for (const p of places) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const dup = out.find((q) => nameKey(q.name) === nameKey(p.name) && haversine(q.ll, p.ll) < 120);
    if (!dup) out.push(p);
    else if (!dup.hours && p.hours) dup.hours = p.hours;
  }
  return out;
}

/**
 * Keep only places that are AHEAD of the car on the route, inside the corridor and look-ahead window.
 * Adds: along (m from route start), offset (m straight-line from route), aheadM (m ahead of car).
 */
export function placesAhead(route, places, carAlong, { lookAheadM, corridorM, minAheadM = 400 }) {
  const from = Math.max(0, indexAtDistance(route, carAlong) - 1);
  const to = indexAtDistance(route, carAlong + lookAheadM + corridorM) + 1;
  const out = [];
  for (const p of places) {
    const pr = projectOnRoute(route, p.ll, Math.max(0, from - 200), to);
    // Was the nearest bit of road behind us? Then it's behind: skip it.
    if (pr.along < carAlong + minAheadM) continue;
    const aheadM = pr.along - carAlong;
    if (aheadM > lookAheadM) continue;
    if (pr.offset > corridorM) continue;
    out.push({ ...p, along: pr.along, offset: pr.offset, aheadM });
  }
  return out;
}

/**
 * Where you'd leave the route and rejoin it for a detour to the place.
 * A = a bit before the place, B = a bit after (but never behind the car).
 */
export function detourAnchors(route, place, carAlong, spanM = 4000) {
  const aAlong = Math.max(carAlong, place.along - spanM);
  const bAlong = Math.min(route.length, place.along + spanM);
  const A = pointAtDistance(route, aAlong);
  const B = pointAtDistance(route, bAlong);
  return { A, B, routeTimeAB: B.time - A.time, routeDistAB: B.along - A.along };
}

/**
 * Detour seconds = time(A->place) + time(place->B) - time on the route from A to B.
 * `table` is an async (sources[], destinations[]) -> { durations, distances } like OSRM's table service.
 */
export async function computeDetours(route, places, carAlong, table, batch = 25) {
  const out = [];
  for (let i = 0; i < places.length; i += batch) {
    const chunk = places.slice(i, i + batch);
    const anchors = chunk.map((p) => detourAnchors(route, p, carAlong));
    // sources: A1..An, P1..Pn ; destinations: P1..Pn, B1..Bn
    const sources = [...anchors.map((a) => ({ ll: a.A.point, heading: a.A.heading })), ...chunk.map((p) => ({ ll: p.ll }))];
    const dests = [...chunk.map((p) => ({ ll: p.ll })), ...anchors.map((a) => ({ ll: a.B.point, heading: a.B.heading }))];
    const res = await table(sources, dests);
    const n = chunk.length;
    chunk.forEach((p, k) => {
      const tAP = res.durations?.[k]?.[k];
      const tPB = res.durations?.[n + k]?.[n + k];
      const dAP = res.distances?.[k]?.[k];
      const dPB = res.distances?.[n + k]?.[n + k];
      if (tAP == null || tPB == null) return; // unreachable
      const a = anchors[k];
      const detourS = Math.max(0, tAP + tPB - a.routeTimeAB);
      const extraM = dAP != null && dPB != null ? Math.max(0, dAP + dPB - a.routeDistAB) : 2 * p.offset;
      out.push({ ...p, detourS, offRouteM: extraM / 2 });
    });
  }
  return out;
}

/**
 * Read the exit off OSRM turn-by-turn steps from the route (A) to the place:
 * the first "off ramp" gives the exit number and signs; the road after it is where the place is.
 */
export function exitFromSteps(steps) {
  if (!steps?.length) return null;
  const i = steps.findIndex((s) => s.maneuver?.type === 'off ramp');
  if (i === -1) {
    // no ramp: the place is right on the road we're on, or reached by a plain turn
    const turn = steps.find((s, k) => k > 0 && ['turn', 'end of road', 'fork'].includes(s.maneuver?.type));
    return turn ? { ref: '', signs: '', road: turn.ref || turn.name || '' } : null;
  }
  const ramp = steps[i];
  const after = steps.slice(i + 1).find((s) => s.ref || s.name);
  const offM = steps.slice(i).reduce((m, s) => m + (s.distance || 0), 0);
  return {
    ref: (ramp.exits || '').split(';')[0],
    signs: (ramp.destinations || '').split(',')[0].trim(),
    road: after ? (after.ref || after.name).split(';')[0] : '',
    offM,
  };
}

/**
 * The ranking she asked for: least added time first, then nearest ahead.
 * Score = detour minutes + 1 minute for every 20 miles ahead. So a place right off an exit 20 miles up
 * (1-2 min detour) beats one 2 miles up that sits 5 miles off the highway (10+ min), but two places that
 * are both right at the exit are ordered by which one comes first.
 * sort: 'best' (default) or 'soonest' (just distance ahead, still within the detour limit).
 */
export const MILES_PER_MINUTE = 20;
export function stopScore(p) {
  return p.detourS / 60 + p.aheadM / MI / MILES_PER_MINUTE;
}
export function rankStops(places, { maxDetourMin = 10, lookAheadMi = 100, sort = 'best' } = {}) {
  return places
    .filter((p) => p.detourS != null && p.detourS / 60 <= maxDetourMin && p.aheadM / MI <= lookAheadMi && p.aheadM > 0)
    .sort(sort === 'soonest' ? (a, b) => a.aheadM - b.aheadM : (a, b) => stopScore(a) - stopScore(b) || a.aheadM - b.aheadM);
}

/** How wide a corridor to search, from the detour limit (a detour of N min can't be more than ~N/2 min off route). */
export function corridorForDetour(maxDetourMin) {
  return Math.min(9000, 1200 + maxDetourMin * 450);
}


/** For a name search, keep only places whose name or brand actually contains what she typed. */
export function matchesName(place, text) {
  const q = nameKey(text);
  if (!q) return true;
  return nameKey(place.name).includes(q) || nameKey(place.brand).includes(q);
}

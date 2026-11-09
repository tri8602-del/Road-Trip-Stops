import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, projectOnRoute, pointAtDistance, haversine, MI } from '../js/geo.js';
import {
  placesAhead, computeDetours, rankStops, stopScore, searchPhrases, matchCategory, nameKey, matchesName,
  parseNominatim, dedupePlaces, exitFromSteps, corridorBoxes, corridorForDetour,
} from '../js/search.js';
import { findStops } from '../js/pipeline.js';
import { addStopUrl, directionsUrl, legacyDirectionsUrl, iosVersion, supportsStops, placeUrl } from '../js/apple.js';

// A straight highway heading north along lon -80 from lat 39.0 to 40.0 (~111 km) at 30 m/s (67 mph).
function straightRoute() {
  const coords = [];
  for (let i = 0; i <= 1000; i++) coords.push([-80, 39 + i / 1000]);
  const durs = [];
  for (let i = 1; i < coords.length; i++) durs.push(haversine(coords[i - 1], coords[i]) / 30);
  return buildRoute(coords, durs);
}
// A point `along` metres up the highway and `off` metres east of it.
function at(route, along, off = 0) {
  const p = pointAtDistance(route, along).point;
  return [p[0] + off / (111320 * Math.cos((p[1] * Math.PI) / 180)), p[1]];
}
// Fake road network: highway at 30 m/s, side roads at 12 m/s.
function fakeTable(route) {
  return async (sources, dests) => {
    const t = (x, y) => {
      const a = projectOnRoute(route, x.ll), b = projectOnRoute(route, y.ll);
      return Math.abs(a.along - b.along) / 30 + (a.offset + b.offset) / 12;
    };
    const d = (x, y) => {
      const a = projectOnRoute(route, x.ll), b = projectOnRoute(route, y.ll);
      return Math.abs(a.along - b.along) + a.offset + b.offset;
    };
    return { durations: sources.map((s) => dests.map((q) => t(s, q))), distances: sources.map((s) => dests.map((q) => d(s, q))) };
  };
}
const place = (id, ll, name = id) => ({ id, name, ll, brand: '', kind: '', hours: '' });

test('route geometry: length, projection and point lookup', () => {
  const r = straightRoute();
  assert.ok(Math.abs(r.length - 111195) < 300);
  const pr = projectOnRoute(r, at(r, 50000, 500));
  assert.ok(Math.abs(pr.along - 50000) < 20, `along ${pr.along}`);
  assert.ok(Math.abs(pr.offset - 500) < 5, `offset ${pr.offset}`);
  const h = pointAtDistance(r, 30000).heading;
  assert.ok(h < 1 || h > 359, `heading north, got ${h}`);
});

test('places behind the car are left out, even when they are right by the road', () => {
  const r = straightRoute();
  const car = 20000;
  const places = [
    place('behind-at-road', at(r, 10000, 50)),
    place('just-behind', at(r, 19800, 30)),
    place('ahead', at(r, 30000, 300)),
    place('too-far-ahead', at(r, 105000, 100)),
    place('too-far-off', at(r, 40000, 20000)),
  ];
  const got = placesAhead(r, places, car, { lookAheadM: 50 * MI, corridorM: 5000 }).map((p) => p.id);
  assert.deepEqual(got, ['ahead']);
});

test('a place right off an exit 20 miles ahead beats one 2 miles ahead that is far off the highway', async () => {
  const r = straightRoute();
  const car = 20000;
  const places = [
    place('close-but-far-off', at(r, car + 2 * MI, 4000)),   // 2 mi ahead, ~2.5 mi off the highway
    place('right-off-exit', at(r, car + 20 * MI, 200)),      // 20 mi ahead, at the exit
    place('behind', at(r, car - 2000, 100)),
  ];
  const ahead = placesAhead(r, places, car, { lookAheadM: 50 * MI, corridorM: 6000 });
  const timed = await computeDetours(r, ahead, car, fakeTable(r));
  const exit = timed.find((p) => p.id === 'right-off-exit');
  const far = timed.find((p) => p.id === 'close-but-far-off');
  assert.ok(exit.detourS < 90, `exit detour ${exit.detourS}s`);
  assert.ok(far.detourS > 9 * 60, `far detour ${far.detourS}s`);
  assert.ok(Math.abs(exit.offRouteM - 200) < 30, `off route ${exit.offRouteM}`);
  // arrival = drive 20 mi of highway at 30 m/s (minus the 4 km anchor) + the hop off the highway
  const expectArrive = (20 * MI - 4000) / 30 + (4000 / 30 + 200 / 12);
  assert.ok(Math.abs(exit.arriveS - expectArrive) < 20, `arrive ${exit.arriveS} vs ${expectArrive}`);
  const ranked = rankStops(timed, { maxDetourMin: 15, lookAheadMi: 50 });
  assert.deepEqual(ranked.map((p) => p.id), ['right-off-exit', 'close-but-far-off']);
  // with a 5 minute limit the far-off one disappears
  assert.deepEqual(rankStops(timed, { maxDetourMin: 5, lookAheadMi: 50 }).map((p) => p.id), ['right-off-exit']);
  // "Soonest" order puts the nearer one first
  assert.deepEqual(rankStops(timed, { maxDetourMin: 15, lookAheadMi: 50, sort: 'soonest' }).map((p) => p.id), ['close-but-far-off', 'right-off-exit']);
});

test('detour uses the side of the road we are driving on (headings are sent for route points)', async () => {
  const r = straightRoute();
  let seen;
  const table = async (s, d) => { seen = { s, d }; return { durations: s.map(() => d.map(() => 60)), distances: s.map(() => d.map(() => 1000)) }; };
  const ahead = placesAhead(r, [place('p', at(r, 40000, 100))], 20000, { lookAheadM: 50 * MI, corridorM: 5000 });
  await computeDetours(r, ahead, 20000, table);
  assert.equal(seen.s.length, 2); assert.equal(seen.d.length, 2);
  assert.ok(seen.s[0].heading != null && seen.d[1].heading != null, 'route anchors carry a heading');
  assert.equal(seen.s[1].heading, undefined, 'the place itself has no heading');
});

test('detour start point is never behind the car', async () => {
  const r = straightRoute();
  let src;
  const table = async (s, d) => { src = s; return { durations: s.map(() => d.map(() => 30)), distances: s.map(() => d.map(() => 500)) }; };
  const ahead = placesAhead(r, [place('soon', at(r, 21500, 100))], 20000, { lookAheadM: 50 * MI, corridorM: 5000 });
  await computeDetours(r, ahead, 20000, table);
  const a = projectOnRoute(r, src[0].ll);
  assert.ok(a.along >= 19990, `anchor along ${a.along}`);
});

test('unreachable places are dropped, ties go to the nearer place', async () => {
  const r = straightRoute();
  const table = async (s, d) => ({ durations: s.map((_, i) => d.map((_, j) => (i === 0 && j === 0 ? null : 100))), distances: s.map(() => d.map(() => 100)) });
  const ahead = placesAhead(r, [place('a', at(r, 30000, 50)), place('b', at(r, 50000, 50))], 20000, { lookAheadM: 50 * MI, corridorM: 5000 });
  const timed = await computeDetours(r, ahead, 20000, table);
  assert.deepEqual(timed.map((p) => p.id), ['b']);
  const same = [{ id: 'far', detourS: 60, aheadM: 30 * MI }, { id: 'near', detourS: 60, aheadM: 10 * MI }];
  assert.deepEqual(rankStops(same).map((p) => p.id), ['near', 'far']);
  assert.ok(stopScore({ detourS: 120, aheadM: 20 * MI }) === 3);
});

test('full search pipeline with fake services', async () => {
  const r = straightRoute();
  const car = 20000;
  const pts = {
    'Chick-fil-A exit': at(r, car + 20 * MI, 150),
    'Chick-fil-A far off': at(r, car + 2 * MI, 4500),
    'Chick-fil-A behind': at(r, car - 3000, 100),
  };
  const searchBox = async (phrase, box) => Object.entries(pts)
    .filter(([, [lon, lat]]) => lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north)
    .map(([name, [lon, lat]], i) => ({ osm_type: 'node', osm_id: name.length * 100 + i, name: 'Chick-fil-A', category: 'amenity', type: 'fast_food', lat: String(lat), lon: String(lon), extratags: { brand: 'Chick-fil-A' }, _n: name }))
    .map((x) => ({ ...x, osm_id: x._n }));
  const res = await findStops({ route: r, carAlong: car, text: 'chick fil a', maxDetourMin: 15, lookAheadMi: 50, services: { searchBox, table: fakeTable(r) } });
  assert.deepEqual(res.stops.map((s) => s.id), ['node/Chick-fil-A exit', 'node/Chick-fil-A far off']);
});

test('search words: categories vs names', () => {
  assert.deepEqual(searchPhrases('Gas'), ['[amenity=fuel]']);
  assert.deepEqual(searchPhrases(' restroom '), ['[amenity=toilets]', '[highway=rest_area]']);
  assert.deepEqual(searchPhrases('Chick-fil-A'), ['Chick-fil-A']);
  assert.equal(matchCategory('walmart'), null);
  assert.equal(nameKey("McDonald's"), nameKey('mcdonalds'));
  assert.ok(matchesName({ name: 'Chick-fil-A', brand: '' }, 'chick fil a'));
  assert.ok(matchesName({ name: 'Walmart Supercenter', brand: 'Walmart' }, 'Walmart'));
  assert.ok(!matchesName({ name: 'KFC', brand: 'KFC' }, 'Chick-fil-A'));
});

test('Nominatim results: keep stops, drop roads and towns, merge duplicates', () => {
  const raw = [
    { osm_type: 'node', osm_id: 1, name: 'Sheetz', category: 'amenity', type: 'fuel', lat: '38.1', lon: '-80.1', extratags: { opening_hours: '24/7', brand: 'Sheetz' }, address: { house_number: '5', road: 'Main St', town: 'Sutton', state: 'West Virginia' } },
    { osm_type: 'way', osm_id: 2, name: 'Sheetz', category: 'amenity', type: 'fuel', lat: '38.1003', lon: '-80.1002', extratags: {} },
    { osm_type: 'way', osm_id: 3, name: 'Gas Well Road', category: 'highway', type: 'track', lat: '38', lon: '-80' },
    { osm_type: 'relation', osm_id: 4, name: 'Gassaway', category: 'place', type: 'town', lat: '38', lon: '-80' },
    { osm_type: 'node', osm_id: 5, name: '', category: 'highway', type: 'rest_area', lat: '38.2', lon: '-80' },
  ];
  const places = dedupePlaces(parseNominatim(raw));
  assert.equal(places.length, 2);
  assert.equal(places[0].hours, '24/7');
  assert.equal(places[0].address, '5 Main St, Sutton, West Virginia');
  assert.equal(places[1].name, 'Rest area');
});

test('search boxes cover the road ahead only', () => {
  const r = straightRoute();
  const boxes = corridorBoxes(r, 20000, 50000, 3000);
  assert.equal(boxes.length, 3);
  assert.ok(boxes[0].south < pointAtDistance(r, 20000).point[1]);
  assert.ok(boxes[0].south > pointAtDistance(r, 15000).point[1], 'first box does not reach far behind');
  assert.ok(boxes[2].north < pointAtDistance(r, 75000).point[1]);
  assert.ok(corridorForDetour(5) < corridorForDetour(15));
});

test('exit numbers from turn-by-turn steps', () => {
  const steps = [
    { maneuver: { type: 'depart' }, name: 'I 79', ref: 'I 79', distance: 9000 },
    { maneuver: { type: 'off ramp' }, name: '', exits: '119', destinations: 'US 50: Clarksburg, Bridgeport', distance: 400 },
    { maneuver: { type: 'turn' }, name: 'Emily Drive', ref: '', distance: 300 },
    { maneuver: { type: 'arrive' }, name: 'Emily Drive', distance: 0 },
  ];
  assert.deepEqual(exitFromSteps(steps), { ref: '119', signs: 'US 50: Clarksburg', road: 'Emily Drive', offM: 700 });
  assert.equal(exitFromSteps([]), null);
  assert.deepEqual(exitFromSteps([{ maneuver: { type: 'depart' } }, { maneuver: { type: 'turn' }, ref: 'WV 41', name: 'Main' }]), { ref: '', signs: '', road: 'WV 41' });
});

test('Apple Maps links', () => {
  const stop = [-80.33, 39.28], dest = [-78.8867, 33.6891];
  assert.equal(addStopUrl(stop, dest), 'https://maps.apple.com/directions?destination=33.689100,-78.886700&waypoint=39.280000,-80.330000&mode=driving');
  assert.equal(directionsUrl(dest), 'https://maps.apple.com/directions?destination=33.689100,-78.886700&mode=driving');
  assert.equal(legacyDirectionsUrl(stop), 'https://maps.apple.com/?daddr=39.280000,-80.330000&dirflg=d');
  assert.ok(placeUrl(stop, 'Chick-fil-A').endsWith('&name=Chick-fil-A'));
  assert.equal(iosVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)'), 18.4);
  assert.equal(supportsStops('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'), false);
  assert.equal(supportsStops('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)'), true);
  assert.equal(supportsStops('Mozilla/5.0 (X11; Linux x86_64)'), true);
});

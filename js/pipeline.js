// One search, start to finish: boxes along the road ahead -> places -> ahead only -> detour times -> ranked list.
import { MI, pointAtDistance } from './geo.js';
import {
  searchPhrases, matchCategory, corridorBoxes, parseNominatim, dedupePlaces, placesAhead,
  computeDetours, rankStops, corridorForDetour, matchesName, exitFromSteps, detourAnchors,
} from './search.js';

const MAX_DETOUR_CHECKS = 50; // closest-to-the-road places we time; keeps the routing server happy

/**
 * services = { searchBox(phrase, box), table(sources, dests), stepsToPlace(from, heading, to) }
 * Returns { stops, checked, found }.
 */
export async function findStops({ route, carAlong, text, maxDetourMin, lookAheadMi, sort = 'best', services, onProgress = () => {} }) {
  const lookAheadM = lookAheadMi * MI;
  const corridorM = corridorForDetour(maxDetourMin);
  const phrases = searchPhrases(text);
  const boxes = corridorBoxes(route, carAlong, lookAheadM, corridorM);
  const isName = !matchCategory(text);

  let raw = [];
  let done = 0;
  const total = boxes.length * phrases.length;
  for (const box of boxes) {
    for (const phrase of phrases) {
      try {
        raw = raw.concat(parseNominatim(await services.searchBox(phrase, box)));
      } catch (e) {
        if (done === 0 && box === boxes[boxes.length - 1]) throw e;
      }
      done++;
      onProgress({ stage: 'search', done, total });
    }
  }
  let places = dedupePlaces(raw);
  if (isName) places = places.filter((p) => matchesName(p, text));
  const ahead = placesAhead(route, places, carAlong, { lookAheadM, corridorM });
  // Time the ones nearest the road first (a place 8 miles off the road can't beat one at the exit).
  const nearest = ahead.sort((a, b) => a.offset - b.offset).slice(0, MAX_DETOUR_CHECKS);
  onProgress({ stage: 'detour', done: 0, total: nearest.length });
  const timed = nearest.length ? await computeDetours(route, nearest, carAlong, services.table) : [];
  const stops = rankStops(timed, { maxDetourMin, lookAheadMi, sort });
  return { stops, timed, found: places.length, ahead: ahead.length, checked: timed.length };
}

/** Fill in "Exit 67 · US 19" for the first few results, one gentle request at a time. */
export async function addExits(route, stops, carAlong, services, count = 6, onEach = () => {}) {
  for (const s of stops.slice(0, count)) {
    try {
      const { A } = detourAnchors(route, s, carAlong);
      const steps = await services.stepsToPlace(A.point, A.heading, s.ll);
      s.exit = exitFromSteps(steps);
    } catch { s.exit = null; }
    onEach(s);
  }
}

export { pointAtDistance };

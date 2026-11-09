// "Will it be open when I get there?" using the opening_hours library (the reference parser for OpenStreetMap hours:
// holidays, 24/7, overnight hours, sunrise/sunset, comments…) and the place's own time zone.
import { OpeningHours, tzlookup } from '../vendor/hours-libs.mjs';

export const CLOSING_SOON_MIN = 60;

export function placeTimeZone(ll) {
  try { return tzlookup(ll[1], ll[0]); } catch { return null; }
}

/** A Date whose *local* fields show the wall-clock time at `ms` in time zone `tz` (what a sign on the door would say). */
export function wallClock(ms, tz) {
  if (!tz) return new Date(ms);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return new Date(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "9:00 PM"; adds the day when it's another day ("Wed 6:00 AM"). Closing times just past midnight stay short. */
export function fmtClock(d, ref, { closing = false } = {}) {
  const h = d.getHours(), m = d.getMinutes();
  const t = h === 0 && m === 0 ? 'midnight' : `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  if (!ref || d.toDateString() === ref.toDateString()) return t;
  if (closing && d - ref < 12 * 3600 * 1000) return t;
  return `${DAY[d.getDay()]} ${t}`;
}

/**
 * Status of a place at the moment she'd arrive.
 *  hours: OSM opening_hours text ('' if none)
 *  ll: [lon, lat]; state: e.g. "West Virginia" (for state holidays); arriveMs: arrival time (epoch ms)
 * Returns { status: 'open' | 'closing-soon' | 'closed' | 'unknown', text, closesAt?, opensAt?, minutesOpen? }
 */
export function statusAtArrival(hours, { ll, state = '', countryCode = 'us', arriveMs, soonMin = CLOSING_SOON_MIN, tz } = {}) {
  if (!hours || !hours.trim()) return { status: 'unknown', text: 'Hours not listed' };
  let oh;
  try {
    oh = new OpeningHours(hours, { lat: ll[1], lon: ll[0], address: { country_code: countryCode, state } }, { tag_key: 'opening_hours' });
  } catch {
    return { status: 'unknown', text: 'Hours listed but unclear' };
  }
  const zone = tz || placeTimeZone(ll);
  const at = wallClock(arriveMs, zone);
  try {
    if (oh.getUnknown(at)) return { status: 'unknown', text: 'Hours unclear at that time' };
    const open = oh.getState(at);
    const next = oh.getNextChange(at);
    if (open) {
      if (!next) return { status: 'open', text: 'Open 24 hours' };
      const mins = (next - at) / 60000;
      if (mins <= soonMin) return { status: 'closing-soon', text: `Closes soon — closes ${fmtClock(next, at, { closing: true })}`, closesAt: next, minutesOpen: Math.round(mins) };
      return { status: 'open', text: mins >= 24 * 60 ? 'Open' : `Open until ${fmtClock(next, at, { closing: true })}`, closesAt: next, minutesOpen: Math.round(mins) };
    }
    return { status: 'closed', text: next ? `Closed when you'd get there · opens ${fmtClock(next, at)}` : 'Closed when you\'d get there', opensAt: next || null };
  } catch {
    return { status: 'unknown', text: 'Hours listed but unclear' };
  }
}

/**
 * Split ranked stops into what to show, keeping each group's order:
 *  open (incl. closing soon) first, then hours unknown, then closed (only when she asks to see closed places).
 * Each stop gets `.hoursStatus` and `.section`.
 */
export function groupByHours(stops, { nowMs = Date.now(), showClosed = false, soonMin = CLOSING_SOON_MIN } = {}) {
  const open = [], unknown = [], closed = [];
  for (const s of stops) {
    const arriveMs = nowMs + (s.arriveS ?? 0) * 1000;
    const st = statusAtArrival(s.hours, { ll: s.ll, state: s.state, arriveMs, soonMin });
    s.hoursStatus = st; s.arriveMs = arriveMs; // kept on the stop so exits found later stay attached
    s.section = st.status === 'open' || st.status === 'closing-soon' ? 'open' : st.status;
    (s.section === 'open' ? open : s.section === 'unknown' ? unknown : closed).push(s);
  }
  return { shown: [...open, ...unknown, ...(showClosed ? closed : [])], open, unknown, closed };
}

// Hints for well-known chains when a place has no hours listed. Shown as a hint only ("usually"), never used to
// hide or confirm a place, because individual locations can differ.
const CHAIN_HINTS = [
  [/^(sheetz|wawa|pilot|flying ?j|love'?s|ta|travelcenters? of america|petro|quiktrip|qt|buc-?ee'?s|kwik ?trip|waffle house)\b/i, 'This chain is usually open 24 hours'],
  [/^chick-?fil-?a\b/i, 'Chick-fil-A is closed on Sundays'],
];
export function chainHint(place) {
  const names = [place.brand, place.name].filter(Boolean);
  for (const [rx, text] of CHAIN_HINTS) if (names.some((n) => rx.test(n.trim()))) return text;
  return '';
}

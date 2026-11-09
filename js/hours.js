// "Open now?" from OpenStreetMap opening_hours, for the common formats (e.g. "Mo-Sa 06:00-22:00; Su 08:00-20:00").
// Returns { open: true|false, text } or null when the hours are missing or too unusual to read safely.
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parseDays(spec) {
  const set = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
    if (!m) return null;
    const a = DAYS.indexOf(m[1]);
    const b = m[2] ? DAYS.indexOf(m[2]) : a;
    for (let d = a; ; d = (d + 1) % 7) { set.add(d); if (d === b) break; }
  }
  return set;
}

function parseTimes(spec) {
  if (/^(off|closed)$/i.test(spec)) return [];
  const spans = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/);
    if (!m) return null;
    const a = +m[1] * 60 + +m[2];
    let b = +m[3] * 60 + +m[4];
    if (b <= a) b += 24 * 60; // past midnight
    spans.push([a, b]);
  }
  return spans;
}

/** Map of day (0=Sun) -> list of [startMin, endMin] spans, or null if unreadable. */
export function parseHours(str) {
  if (!str) return null;
  const s = str.trim();
  if (s === '24/7') return Object.fromEntries(DAYS.map((_, d) => [d, [[0, 1440]]]));
  const week = {};
  for (let rule of s.split(';')) {
    rule = rule.trim();
    if (!rule) continue;
    if (/^PH\b/.test(rule)) continue; // holiday rules: ignore
    const m = rule.match(/^([A-Za-z,\- ]+?)\s+(.+)$/);
    let days, times;
    if (m && /^(Mo|Tu|We|Th|Fr|Sa|Su)/.test(m[1])) {
      days = parseDays(m[1].replace(/\s+/g, '').replace(/,PH|PH,/g, ''));
      times = m[2].trim() === '24/7' ? [[0, 1440]] : parseTimes(m[2].trim());
    } else {
      days = new Set([0, 1, 2, 3, 4, 5, 6]);
      times = parseTimes(rule);
    }
    if (!days || !times) return null;
    for (const d of days) week[d] = times; // later rules win for their days
  }
  return week;
}

const fmt = (min) => {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

export function openNow(str, now = new Date()) {
  const week = parseHours(str);
  if (!week) return null;
  if (str.trim() === '24/7') return { open: true, text: 'Open 24 hours' };
  if (!Object.keys(week).length) return null;
  const day = now.getDay();
  const min = now.getHours() * 60 + now.getMinutes();
  // today's spans, plus yesterday's that run past midnight
  const spans = [...(week[day] || []).map(([a, b]) => [a, b]), ...(week[(day + 6) % 7] || []).map(([a, b]) => [a - 1440, b - 1440])];
  for (const [a, b] of spans) {
    if (min >= a && min < b) return { open: true, text: b - a >= 1440 ? 'Open 24 hours' : `Open until ${fmt(b)}` };
  }
  const later = (week[day] || []).filter(([a]) => a > min).sort((x, y) => x[0] - y[0])[0];
  return { open: false, text: later ? `Closed · opens ${fmt(later[0])}` : 'Closed now' };
}

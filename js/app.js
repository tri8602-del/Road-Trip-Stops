import { buildRoute, projectOnRoute, indexAtDistance, MI } from './geo.js';
import { fetchRoute, osrmTable, suggestPlaces, reverseName, searchBox, stepsToPlace } from './services.js';
import { findStops, addExits } from './pipeline.js';
import { openNow } from './hours.js';
import { addStopUrl, directionsUrl, legacyDirectionsUrl, placeUrl, supportsStops } from './apple.js';

const $ = (id) => document.getElementById(id);
const KEY = 'rts.v1';
const services = { searchBox, table: osrmTable, stepsToPlace };
const ON_ROUTE_M = 1500; // closer than this to the route = "you're on it"

const state = {
  from: null,            // null = my location, else { label, ll }
  dest: null,            // { label, ll }
  route: null,
  gps: null,             // [lon, lat]
  lastAlong: 0,
  filters: { maxDetour: 10, lookAhead: 50, sort: 'best' },
  results: [],
  nextStop: null,        // { name, ll } after she adds a stop
  searchText: '',
};

// ---------- saving ----------
function save() {
  const r = state.route;
  const data = {
    from: state.from, dest: state.dest, filters: state.filters, nextStop: state.nextStop,
    route: r ? { coords: r.coords.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]), durs: Array.from(r.cumTime.slice(1), (t, i) => +(t - r.cumTime[i]).toFixed(1)), startLabel: r.startLabel } : null,
  };
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage full: fine, just not saved */ }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!d) return;
    Object.assign(state, { from: d.from || null, dest: d.dest || null, nextStop: d.nextStop || null });
    if (d.filters) Object.assign(state.filters, d.filters);
    if (d.route?.coords?.length > 1) {
      state.route = buildRoute(d.route.coords, d.route.durs);
      state.route.startLabel = d.route.startLabel;
    }
  } catch { /* ignore broken save */ }
}

// ---------- map ----------
let map, routeLine, carMarker, destMarker, resultLayer;
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([39.5, -80], 6);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap',
  }).addTo(map);
  resultLayer = L.layerGroup().addTo(map);
}
function drawRoute() {
  if (routeLine) routeLine.remove();
  if (destMarker) destMarker.remove();
  if (!state.route) return;
  const latlngs = state.route.coords.map(([lon, lat]) => [lat, lon]);
  routeLine = L.polyline(latlngs, { color: '#2f6f73', weight: 6, opacity: 0.85 }).addTo(map);
  const end = latlngs[latlngs.length - 1];
  destMarker = L.marker(end, { icon: L.divIcon({ className: '', html: '<div class="flag">🏁</div>', iconSize: [24, 24], iconAnchor: [4, 22] }) }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [24, 24] });
}
function drawCar() {
  if (!state.gps) return;
  const ll = [state.gps[1], state.gps[0]];
  if (!carMarker) carMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="car"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000 }).addTo(map);
  else carMarker.setLatLng(ll);
}

// ---------- location ----------
function getPosition(timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share location'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.longitude, p.coords.latitude]),
      (e) => reject(new Error(e.code === 1 ? 'Location is turned off for this app. You can type a starting place instead.' : 'Could not find your location yet.')),
      { enableHighAccuracy: true, timeout, maximumAge: 15000 },
    );
  });
}
function watchPosition() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition((p) => {
    state.gps = [p.coords.longitude, p.coords.latitude];
    drawCar();
    updateWhere();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}

/** Where the car is along the route. Off the route (or no location) = the start of the route (planning). */
function carPosition() {
  const r = state.route;
  if (!r || !state.gps) return { along: 0, onRoute: false };
  // look near where we last were first, so a route that doubles back doesn't confuse us
  const i = indexAtDistance(r, state.lastAlong);
  let pr = projectOnRoute(r, state.gps, Math.max(0, i - 400), Math.min(r.coords.length - 1, i + 4000));
  if (pr.offset > ON_ROUTE_M) pr = projectOnRoute(r, state.gps);
  if (pr.offset > ON_ROUTE_M) return { along: 0, onRoute: false, offset: pr.offset };
  state.lastAlong = pr.along;
  return { along: pr.along, onRoute: true, offset: pr.offset };
}

// ---------- trip ----------
const fmtMi = (m) => { const mi = m / MI; return mi < 10 ? mi.toFixed(1) : Math.round(mi).toString(); };
const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} hr ${m} min` : `${m} min`; };

function updateWhere() {
  const r = state.route;
  if (!r) return;
  const pos = carPosition();
  const left = r.length - pos.along;
  $('sumDist').textContent = `${fmtMi(left)} mi`;
  $('sumTime').textContent = `about ${fmtDur(r.duration - (pos.onRoute ? timeAt(pos.along) : 0))} of driving`;
  $('sumWhere').textContent = pos.onRoute
    ? `You're on the route. Searches look ahead of you.`
    : state.gps ? `You're not on this route right now, so searches start from ${r.startLabel || 'the start'}.` : `Searches start from ${r.startLabel || 'the start of the route'}.`;
  $('tripSummary').hidden = false;
}
function timeAt(along) {
  const r = state.route; const i = indexAtDistance(r, along); return r.cumTime[i];
}

async function makeRoute({ fromHere = false } = {}) {
  const msg = $('tripMsg');
  msg.className = 'msg';
  if (!state.dest) { msg.textContent = 'Type where you are headed and pick it from the list.'; $('destInput').focus(); return; }
  $('routeBtn').disabled = true; $('rerouteBtn').disabled = true;
  try {
    let start, startLabel;
    if (state.from && !fromHere) { start = state.from.ll; startLabel = state.from.label; }
    else {
      msg.textContent = 'Finding your location…';
      state.gps = await getPosition();
      drawCar();
      start = state.gps; startLabel = 'your location';
      if (fromHere) { state.from = null; $('fromInput').value = ''; }
    }
    msg.textContent = 'Working out the driving route…';
    const route = await fetchRoute(start, state.dest.ll);
    route.startLabel = startLabel;
    state.route = route; state.lastAlong = 0; state.results = [];
    renderResults();
    drawRoute(); drawCar(); updateWhere(); save();
    msg.textContent = '';
  } catch (e) {
    msg.className = 'msg warn';
    msg.textContent = e.message || 'Could not get a route. Check your signal and try again.';
  } finally {
    $('routeBtn').disabled = false; $('rerouteBtn').disabled = false;
  }
}

// ---------- autocomplete ----------
function autocomplete(input, list, onPick) {
  let timer, items = [], seq = 0;
  const close = () => { list.hidden = true; list.innerHTML = ''; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        items = await suggestPlaces(q, state.gps || (state.route && state.route.coords[0]));
      } catch { items = []; }
      if (my !== seq) return;
      list.innerHTML = '';
      for (const it of items) {
        const li = document.createElement('li');
        li.innerHTML = `<span></span><span class="detail"></span>`;
        li.firstChild.textContent = it.label; li.lastChild.textContent = it.detail;
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => { close(); onPick(it); });
        list.appendChild(li);
      }
      list.hidden = !items.length;
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && items.length && !list.hidden) { e.preventDefault(); close(); onPick(items[0]); }
    if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

// ---------- search ----------
let searchSeq = 0;
async function runSearch(text) {
  const msg = $('searchMsg');
  msg.className = 'msg';
  text = (text || '').trim();
  if (!text) { msg.textContent = 'Type what you are looking for.'; return; }
  if (!state.route) { msg.textContent = 'Set your destination first so I know which way you are going.'; return; }
  state.searchText = text;
  const my = ++searchSeq;
  $('searchBtn').disabled = true;
  state.results = []; renderResults();
  const pos = carPosition();
  const f = state.filters;
  try {
    msg.textContent = `Looking ${f.lookAhead} miles ahead…`;
    const res = await findStops({
      route: state.route, carAlong: pos.along, text, maxDetourMin: f.maxDetour, lookAheadMi: f.lookAhead, sort: f.sort, services,
      onProgress: (p) => { if (my === searchSeq) msg.textContent = p.stage === 'search' ? `Looking ${f.lookAhead} miles ahead… (${p.done} of ${p.total})` : 'Working out how much time each one adds…'; },
    });
    if (my !== searchSeq) return;
    state.results = res.stops;
    state.searchAlong = pos.along;
    renderResults();
    if (!res.stops.length) {
      msg.textContent = res.ahead
        ? `Nothing ahead adds less than ${f.maxDetour} minutes. Try a longer limit in Options.`
        : `No "${text}" found in the next ${f.lookAhead} miles. Try looking farther ahead.`;
    } else {
      msg.textContent = `${res.stops.length} ahead of you, least extra time first${f.sort === 'soonest' ? ' (sorted by soonest)' : ''}.`;
      addExits(state.route, res.stops, pos.along, services, 6, (s) => { if (my === searchSeq) updateCard(s); });
    }
  } catch (e) {
    if (my !== searchSeq) return;
    msg.className = 'msg warn';
    msg.textContent = 'The search service is busy or the signal is weak. Try again in a moment.';
  } finally {
    if (my === searchSeq) $('searchBtn').disabled = false;
  }
}

function exitText(s) {
  const x = s.exit;
  if (!x) return '';
  if (x.ref) return `Exit ${x.ref}${x.signs ? ' · ' + x.signs : x.road ? ' · ' + x.road : ''}`;
  if (x.signs) return `Exit toward ${x.signs}`;
  if (x.road) return `On ${x.road}`;
  return '';
}

function cardHTML(s, i) {
  const hours = openNow(s.hours);
  const off = s.offRouteM / MI;
  const offText = off < 0.1 ? 'right by the road' : `${off.toFixed(1)} mi off the road`;
  return `
    <div class="num">${i + 1}</div>
    <div><h3></h3><span class="kind"></span></div>
    <div class="facts"><span><b>${fmtMi(s.aheadM)} mi</b> ahead</span><span class="detour"><b>+${Math.max(1, Math.round(s.detourS / 60))} min</b> extra</span><span>${offText}</span></div>
    <div class="exit">${escapeHTML(exitText(s))}</div>
    ${hours ? `<div class="hours ${hours.open ? 'open' : 'closed'}">${escapeHTML(hours.text)}</div>` : ''}
    <button class="btn primary" type="button" data-act="stop">Add this stop</button>`;
}
const escapeHTML = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderResults() {
  const ol = $('results');
  ol.innerHTML = '';
  resultLayer.clearLayers();
  state.results.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'result';
    li.dataset.id = s.id;
    li.innerHTML = cardHTML(s, i);
    li.querySelector('h3').textContent = s.name;
    li.querySelector('.kind').textContent = [s.kind !== s.name ? s.kind : '', s.address].filter(Boolean).join(' · ');
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-act=stop]')) openSheet(s);
      else selectResult(s, true);
    });
    ol.appendChild(li);
    s.marker = L.marker([s.ll[1], s.ll[0]], { icon: L.divIcon({ className: '', html: `<div class="pin">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .on('click', () => selectResult(s, false, true)).addTo(resultLayer);
  });
  if (state.results.length) {
    const pts = state.results.slice(0, 10).map((s) => [s.ll[1], s.ll[0]]);
    if (state.gps && carPosition().onRoute) pts.push([state.gps[1], state.gps[0]]);
    map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 13 });
  }
}
function updateCard(s) {
  const li = document.querySelector(`.result[data-id="${CSS.escape(s.id)}"] .exit`);
  if (li) li.textContent = exitText(s);
}
function selectResult(s, pan, scroll) {
  document.querySelectorAll('.result.sel').forEach((e) => e.classList.remove('sel'));
  document.querySelectorAll('.pin.sel').forEach((e) => e.classList.remove('sel'));
  const li = document.querySelector(`.result[data-id="${CSS.escape(s.id)}"]`);
  li?.classList.add('sel');
  s.marker?.getElement()?.querySelector('.pin')?.classList.add('sel');
  if (pan) map.setView([s.ll[1], s.ll[0]], Math.max(map.getZoom(), 13));
  if (scroll) li?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- stop sheet ----------
function openSheet(s) {
  const dest = state.dest;
  $('sheetTitle').textContent = s.name;
  $('sheetFacts').textContent = `${fmtMi(s.aheadM)} mi ahead · about ${Math.max(1, Math.round(s.detourS / 60))} min extra${exitText(s) ? ' · ' + exitText(s) : ''}`;
  document.querySelectorAll('.destName').forEach((e) => { e.textContent = dest.label; });
  const multi = supportsStops(navigator.userAgent);
  const add = $('addStopBtn');
  add.href = multi ? addStopUrl(s.ll, dest.ll) : legacyDirectionsUrl(s.ll);
  add.textContent = multi ? 'Add stop in Apple Maps' : 'Go to this stop in Apple Maps';
  $('addStopNote').innerHTML = multi
    ? `Apple Maps opens with this stop first, then <span class="destName"></span>.`
    : `This iPhone needs iOS 18.4 or newer for multi-stop links, so Apple Maps will go to the stop. Come back here after and tap Continue.`;
  document.querySelectorAll('.destName').forEach((e) => { e.textContent = dest.label; });
  $('stopOnlyBtn').href = multi ? directionsUrl(s.ll) : legacyDirectionsUrl(s.ll);
  $('stopOnlyBtn').hidden = !multi;
  $('placeBtn').href = placeUrl(s.ll, s.name);
  const remember = () => { state.nextStop = { name: s.name, ll: s.ll }; save(); showBanner(); setTimeout(() => { $('sheet').hidden = true; }, 300); };
  add.onclick = remember;
  $('stopOnlyBtn').onclick = remember;
  $('sheet').hidden = false;
  selectResult(s, false);
}
function showBanner() {
  const b = $('nextBanner');
  if (!state.nextStop || !state.dest) { b.hidden = true; return; }
  $('nextStopName').textContent = state.nextStop.name;
  $('continueDest').textContent = `Continue to ${state.dest.label}`;
  const multi = supportsStops(navigator.userAgent);
  $('continueBtn').href = multi ? directionsUrl(state.dest.ll) : legacyDirectionsUrl(state.dest.ll);
  b.hidden = false;
}

// ---------- filters ----------
function initFilters() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const name = seg.dataset.name;
    const paint = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(state.filters[name]) === b.dataset.v));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.filters[name] = name === 'sort' ? b.dataset.v : Number(b.dataset.v);
      paint(); paintSummary(); save();
      if (state.searchText && state.route) runSearch(state.searchText);
    });
    paint();
  });
  paintSummary();
}
function paintSummary() {
  const f = state.filters;
  $('filterSummary').textContent = `up to ${f.maxDetour} min extra · next ${f.lookAhead} mi${f.sort === 'soonest' ? ' · soonest first' : ''}`;
}

// ---------- start ----------
function init() {
  load();
  initMap();
  initFilters();
  if (state.dest) $('destInput').value = state.dest.label;
  if (state.from) $('fromInput').value = state.from.label;
  if (state.route) { drawRoute(); updateWhere(); }
  showBanner();

  autocomplete($('destInput'), $('destSuggest'), (it) => { state.dest = { label: it.label, ll: it.ll }; $('destInput').value = it.label; save(); makeRoute(); });
  autocomplete($('fromInput'), $('fromSuggest'), (it) => { state.from = { label: it.label, ll: it.ll }; $('fromInput').value = it.label; save(); if (state.dest) makeRoute(); });
  $('fromInput').addEventListener('change', () => { if (!$('fromInput').value.trim()) { state.from = null; save(); } });
  $('useMyLocation').addEventListener('click', () => { state.from = null; $('fromInput').value = ''; save(); if (state.dest) makeRoute({ fromHere: true }); else getPosition().then((p) => { state.gps = p; drawCar(); map.setView([p[1], p[0]], 11); }).catch((e) => { $('tripMsg').textContent = e.message; }); });
  $('clearDest').addEventListener('click', () => { $('destInput').value = ''; $('destInput').focus(); });
  $('routeBtn').addEventListener('click', () => makeRoute());
  $('rerouteBtn').addEventListener('click', () => makeRoute({ fromHere: true }));
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('searchInput').blur(); runSearch($('searchInput').value); });
  $('quickChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; $('searchInput').value = c.dataset.q; runSearch(c.dataset.q); });
  $('sheetClose').addEventListener('click', () => { $('sheet').hidden = true; });
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; });
  $('clearStop').addEventListener('click', () => { state.nextStop = null; save(); showBanner(); });

  watchPosition();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // reverse-name "my location" quietly, just for the From placeholder
  getPosition(8000).then(async (p) => {
    state.gps = p; drawCar(); updateWhere();
    const name = await reverseName(p);
    if (name) $('fromInput').placeholder = `My location (${name})`;
    if (!state.route) map.setView([p[1], p[0]], 10);
  }).catch(() => {});
}
window.__rts = state; // read-only peek for tests
init();

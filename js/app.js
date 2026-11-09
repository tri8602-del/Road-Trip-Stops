import { buildRoute, projectOnRoute, indexAtDistance, MI } from './geo.js';
import { fetchRoute, osrmTable, suggestPlaces, reverseName, searchBox, stepsToPlace } from './services.js';
import { findStops, addExits } from './pipeline.js';
import { openNow } from './hours.js';
import { addStopUrl, directionsUrl, legacyDirectionsUrl, placeUrl, supportsStops } from './apple.js';
import { loadSaved, storeSaved, addSaved, renameSaved, removeSaved, findSavedAt, matchSaved } from './saved.js';

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
  editingTrip: false,
  saved: [],
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
  showTripMode();
}

/** Once a route is set, the trip card shrinks to one line so Search sits near the top of the screen. */
function showTripMode() {
  const compact = !!state.route && !!state.dest && !state.editingTrip;
  $('tripCompact').hidden = !compact;
  $('tripEdit').hidden = compact;
  if (state.dest) $('compactDest').textContent = state.dest.label;
  paintStars();
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
    state.editingTrip = false;
    drawRoute(); drawCar(); updateWhere(); save();
    msg.textContent = '';
  } catch (e) {
    msg.className = 'msg warn';
    msg.textContent = e.message || 'Could not get a route. Check your signal and try again.';
  } finally {
    $('routeBtn').disabled = false; $('rerouteBtn').disabled = false;
  }
}

// ---------- autocomplete (saved places first, then address search) ----------
function autocomplete(input, list, onPick, { star = true } = {}) {
  let timer, items = [], seq = 0;
  const close = () => { list.hidden = true; list.innerHTML = ''; };
  const show = (savedHits, found) => {
    items = [...savedHits.map((p) => ({ label: p.name, detail: p.address, ll: p.ll, saved: p })), ...found];
    list.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.className = it.saved ? 'is-saved' : '';
      li.innerHTML = `<span class="sg-text"><span class="sg-label"></span><span class="detail"></span></span>`;
      li.querySelector('.sg-label').textContent = (it.saved ? '★ ' : '') + it.label;
      li.querySelector('.detail').textContent = it.detail;
      if (!it.saved && star) {
        const starBtn = document.createElement('button');
        starBtn.type = 'button'; starBtn.className = 'sg-star'; starBtn.textContent = findSavedAt(state.saved, it.ll) ? '★' : '☆';
        starBtn.setAttribute('aria-label', `Save ${it.label}`);
        starBtn.addEventListener('mousedown', (e) => e.preventDefault());
        starBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); openSaveSheet({ name: it.label, address: [it.label, it.detail].filter(Boolean).join(', '), ll: it.ll }); });
        li.appendChild(starBtn);
      }
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => { close(); onPick(it); });
      list.appendChild(li);
    }
    list.hidden = !items.length;
  };
  const lookup = async (q) => {
    const my = ++seq;
    let found = [];
    try { found = await suggestPlaces(q, state.gps || (state.route && state.route.coords[0])); } catch { found = []; }
    if (my !== seq) return null;
    show(matchSaved(state.saved, q), found);
    return items;
  };
  input.addEventListener('focus', () => { if (!input.value.trim() && state.saved.length) show(state.saved, []); });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { seq++; return q ? show(matchSaved(state.saved, q), []) : state.saved.length ? show(state.saved, []) : close(); }
    show(matchSaved(state.saved, q), []);
    timer = setTimeout(() => lookup(q), 300);
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') return close();
    if (e.key !== 'Enter') return;
    // keyboard Go / Search key: take the first match, looking it up now if the list isn't ready
    e.preventDefault();
    const q = input.value.trim();
    if (items.length && !list.hidden) { const it = items[0]; close(); return onPick(it); }
    if (q.length >= 3) { clearTimeout(timer); const got = await lookup(q); if (got?.length) { close(); onPick(got[0]); } }
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
  $('saveStopBtn').textContent = findSavedAt(state.saved, s.ll) ? '★ Saved (tap to rename)' : '☆ Save this place';
  $('saveStopBtn').onclick = () => { $('sheet').hidden = true; openSaveSheet({ name: s.name, address: s.address ? `${s.name}, ${s.address}` : s.name, ll: s.ll }); };
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

// ---------- saved places ----------
function setSaved(list) {
  state.saved = list;
  storeSaved(localStorage, list);
  renderSavedChips();
  renderSavedList();
  paintStars();
}
function useAsDestination(p) {
  state.dest = { label: p.name, ll: p.ll };
  $('destInput').value = p.name;
  save();
  makeRoute();
}
function useAsStart(p) {
  state.from = { label: p.name, ll: p.ll };
  $('fromInput').value = p.name;
  save();
  if (state.dest) makeRoute();
}
function renderSavedChips() {
  const box = $('savedChips');
  box.innerHTML = '';
  for (const p of state.saved.slice(0, 6)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip saved-chip'; b.textContent = `★ ${p.name}`;
    b.title = `Go to ${p.address || p.name}`;
    b.addEventListener('click', () => useAsDestination(p));
    box.appendChild(b);
  }
  box.hidden = !state.saved.length;
}
function renderSavedList() {
  const ul = $('savedList');
  ul.innerHTML = '';
  $('savedEmpty').hidden = state.saved.length > 0;
  for (const p of state.saved) {
    const li = document.createElement('li');
    li.className = 'saved-item';
    li.dataset.id = p.id;
    li.innerHTML = `<div class="saved-name"></div><div class="small saved-addr"></div>
      <div class="saved-actions">
        <button type="button" class="btn primary" data-act="go">Go here</button>
        <button type="button" class="btn soft-inline" data-act="start">Start here</button>
        <button type="button" class="btn soft-inline" data-act="rename">Rename</button>
        <button type="button" class="btn soft-inline danger" data-act="delete">Delete</button>
      </div>`;
    li.querySelector('.saved-name').textContent = `★ ${p.name}`;
    li.querySelector('.saved-addr').textContent = p.address;
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'go') { $('savedSheet').hidden = true; useAsDestination(p); }
      if (act === 'start') { $('savedSheet').hidden = true; useAsStart(p); }
      if (act === 'rename') openSaveSheet({ id: p.id, name: p.name, address: p.address, ll: p.ll });
      if (act === 'delete') {
        const btn = e.target.closest('[data-act]');
        if (btn.dataset.confirm) setSaved(removeSaved(state.saved, p.id));
        else { btn.dataset.confirm = '1'; btn.textContent = 'Tap again to delete'; }
      }
    });
    ul.appendChild(li);
  }
}
function paintStars() {
  const on = state.dest && findSavedAt(state.saved, state.dest.ll);
  for (const id of ['starDest', 'starDestCompact']) {
    $(id).textContent = on ? '★' : '☆';
    $(id).classList.toggle('on', !!on);
  }
}

// One sheet for: saving a known place (ll given), renaming (id given), or adding by typing an address (nothing given).
let saveTarget = null;
function openSaveSheet(t = {}) {
  saveTarget = { ...t };
  const existing = t.ll && !t.id ? findSavedAt(state.saved, t.ll) : null;
  if (existing) saveTarget.id = existing.id;
  const known = !!t.ll;
  $('saveTitle').textContent = saveTarget.id ? 'Rename saved place' : known ? 'Save place' : 'Add a place';
  $('saveName').value = existing ? existing.name : t.name || '';
  $('saveAddrField').hidden = known;
  $('saveAddr').value = '';
  $('saveWhere').textContent = known ? t.address || '' : '';
  $('saveSheet').hidden = false;
  $('saveName').focus(); // same tap, so iPhone shows the keyboard
}
function confirmSave() {
  const t = saveTarget;
  if (!t) return;
  const name = $('saveName').value.trim();
  if (!t.ll) { $('saveWhere').textContent = 'Pick the address from the list first.'; $('saveAddr').focus(); return; }
  if (!name) { $('saveWhere').textContent = 'Give it a name, like Home.'; $('saveName').focus(); return; }
  setSaved(t.id ? renameSaved(state.saved, t.id, name) : addSaved(state.saved, { name, address: t.address, ll: t.ll }));
  $('saveSheet').hidden = true;
  saveTarget = null;
}
function starDestination() {
  if (!state.dest) { $('tripMsg').textContent = 'Pick a destination first, then tap ☆ to save it.'; return; }
  openSaveSheet({ name: state.dest.label, address: state.dest.label, ll: state.dest.ll });
}

// ---------- bottom bars & keyboard ----------
// Safari's bottom toolbar and the iPhone home bar can sit over the page (viewport-fit=cover).
// We pad the page and sheets by the safe area, plus room for Safari's toolbar when not opened from the Home Screen,
// and lift sheets above the on-screen keyboard using visualViewport.
function initViewport() {
  const root = document.documentElement;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  root.classList.toggle('standalone', !!standalone);
  root.classList.toggle('in-browser', !standalone);
  const vv = window.visualViewport;
  const update = () => {
    if (!vv) return;
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--kb', `${Math.round(covered)}px`);
    root.classList.toggle('kb-open', covered > 120);
  };
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  update();
  // keep whatever she's typing in visible above the keyboard
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el.matches?.('input')) return;
    setTimeout(() => {
      if (el.id === 'searchInput') $('searchCard').scrollIntoView({ block: 'start', behavior: 'smooth' });
      else if (!el.closest('.sheet')) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 250);
  });
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
  state.saved = loadSaved(localStorage);
  initViewport();
  initMap();
  initFilters();
  if (state.dest) $('destInput').value = state.dest.label;
  if (state.from) $('fromInput').value = state.from.label;
  if (state.route) { drawRoute(); updateWhere(); }
  showTripMode();
  renderSavedChips(); renderSavedList();
  showBanner();

  autocomplete($('destInput'), $('destSuggest'), (it) => { state.dest = { label: it.label, ll: it.ll }; $('destInput').value = it.label; save(); makeRoute(); });
  autocomplete($('fromInput'), $('fromSuggest'), (it) => { state.from = { label: it.label, ll: it.ll }; $('fromInput').value = it.label; save(); if (state.dest) makeRoute(); });
  $('fromInput').addEventListener('change', () => { if (!$('fromInput').value.trim()) { state.from = null; save(); } });
  $('useMyLocation').addEventListener('click', () => { state.from = null; $('fromInput').value = ''; save(); if (state.dest) makeRoute({ fromHere: true }); else getPosition().then((p) => { state.gps = p; drawCar(); map.setView([p[1], p[0]], 11); }).catch((e) => { $('tripMsg').textContent = e.message; }); });
  $('starDest').addEventListener('click', starDestination);
  $('starDestCompact').addEventListener('click', starDestination);
  $('changeTrip').addEventListener('click', () => { state.editingTrip = true; showTripMode(); $('destInput').focus(); });
  $('manageSaved').addEventListener('click', () => { renderSavedList(); $('savedSheet').hidden = false; });
  $('savedClose').addEventListener('click', () => { $('savedSheet').hidden = true; });
  $('addSavedBtn').addEventListener('click', () => openSaveSheet({}));
  $('saveForm').addEventListener('submit', (e) => { e.preventDefault(); confirmSave(); });
  $('saveCancel').addEventListener('click', () => { $('saveSheet').hidden = true; saveTarget = null; });
  autocomplete($('saveAddr'), $('saveSuggest'), (it) => {
    if (it.saved) { $('saveWhere').textContent = `${it.label} is already saved.`; return; }
    saveTarget = { ...saveTarget, ll: it.ll, address: [it.label, it.detail].filter(Boolean).join(', ') };
    $('saveAddr').value = it.label;
    $('saveWhere').textContent = saveTarget.address;
    if (!$('saveName').value.trim()) $('saveName').focus();
  }, { star: false });
  for (const id of ['sheet', 'saveSheet', 'savedSheet']) $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).hidden = true; });
  $('routeBtn').addEventListener('click', () => makeRoute());
  $('rerouteBtn').addEventListener('click', () => makeRoute({ fromHere: true }));
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('searchInput').blur(); runSearch($('searchInput').value); });
  $('quickChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; $('searchInput').value = c.dataset.q; runSearch(c.dataset.q); });
  $('sheetClose').addEventListener('click', () => { $('sheet').hidden = true; });
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
window.__rtsHooks = { renderResults: () => renderResults(), openSheet: (s) => openSheet(s) }; // used by layout tests
init();

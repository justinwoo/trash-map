// Classic script (no modules, no build) so the page works from GitHub Pages and
// file:// alike. Globals come from earlier <script> tags: maplibregl (unpkg),
// TRASH_DATA (data/stops.js), and the helpers in schedule.js.
const { Marker, NavigationControl, Popup } = maplibregl;

const MIN_T = 840; // 14:00
const MAX_T = 1470; // 24:30
const LIST_LIMIT = 150;
const NEAR_RADIUS_M = 500;
const CITY_VIEW = { center: [121.54, 25.06], zoom: 11.3 };
// Home lives only in this browser's localStorage; nothing is hardcoded.
const HOME_KEY = 'trash-map:home';

function loadHome() {
  try {
    const h = JSON.parse(localStorage.getItem(HOME_KEY));
    return Number.isFinite(h?.lng) && Number.isFinite(h?.lat) ? { lng: h.lng, lat: h.lat, label: 'home' } : null;
  } catch {
    return null;
  }
}

const $ = (id) => document.getElementById(id);
const els = {
  today: $('today'),
  from: $('from'),
  to: $('to'),
  rangeLabel: $('range-label'),
  count: $('count'),
  listTitle: $('list-title'),
  list: $('list'),
  legend: $('legend'),
  source: $('source'),
  homeHint: $('home-hint'),
  nowBtn: $('now-btn'),
};

const state = {
  stops: [],
  routes: new Map(), // routeKey -> stops sorted by arrival
  selectedRoute: null,
  home: loadHome(),
  refPos: null,
  nextHour: false, // point the "nearby" list is measured from: home or GPS
};

const routeKey = (s) => `${s.route}|${s.trip}`;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  ...(loadHome() ? { center: [loadHome().lng, loadHome().lat], zoom: 15.5 } : CITY_VIEW),
});
map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
let refMarker = null;
const popup = new Popup({ closeButton: true, maxWidth: '280px' });

// Arrival-time bands: discrete, clearly distinct hues instead of a gradient.
const BANDS = [
  { from: 840, color: '#e67700', label: '14–17' },
  { from: 1020, color: '#2b8a3e', label: '17–19' },
  { from: 1140, color: '#1864ab', label: '19–21' },
  { from: 1260, color: '#c2255c', label: '21–23' },
  { from: 1380, color: '#343a40', label: '23+' },
];
const bandColor = (min) => BANDS.findLast((b) => min >= b.from).color;
const bandExpr = (prop) => [
  'step', typeof prop === 'string' ? ['get', prop] : prop, BANDS[0].color,
  ...BANDS.slice(1).flatMap((b) => [b.from, b.color]),
];

// Up to 6 stops share one point in the data. Each label line is its own
// format section so every time gets its own band color.
const MAX_LABEL_LINES = 6;
const labelExpr = [
  'format',
  ...Array.from({ length: MAX_LABEL_LINES }, (_, i) => [
    ['coalesce', ['get', `t${i}`], ''],
    { 'text-color': bandExpr(['coalesce', ['get', `m${i}`], 0]) },
  ]).flat(),
];

async function init() {
  const data = window.TRASH_DATA;
  if (!data) throw new Error('data/stops.js missing');
  await new Promise((resolve) => map.on('load', resolve));

  state.stops = data.stops.map((s) => ({
    ...s,
    arriveMin: toMinutes(s.arrive),
    leaveMin: toMinutes(s.leave),
  }));
  for (const s of state.stops) {
    const k = routeKey(s);
    if (!state.routes.has(k)) state.routes.set(k, []);
    state.routes.get(k).push(s);
  }
  for (const list of state.routes.values()) list.sort((a, b) => a.arriveMin - b.arriveMin);


  els.source.innerHTML =
    `Data: <a href="https://data.gov.tw/dataset/136515" target="_blank" rel="noopener">臺北市垃圾車點位路線資訊</a>` +
    ` (imported ${data.importedAt?.slice(0, 10) ?? '?'})`;
  els.legend.innerHTML =
    `<div class="bands">${BANDS.map((b) => `<span style="--c:${b.color}">${b.label}</span>`).join('')}</div>` +
    `<div class="legend-due"><span class="dot here"></span>Truck there now <span class="dot soon"></span>Within 30 min <span class="dot off"></span>Not served today</div>`;

  addLayers();
  bindEvents();
  renderToday();
  renderHomeControls();
  if (state.home) setRefPos(state.home);
  else update();
  setInterval(() => {
    renderToday();
    if (state.nextHour) setNextHour(true);
    update();
  }, 60_000);
}

function addLayers() {
  map.addSource('stops', { type: 'geojson', data: emptyFC() });
  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addSource('labels', { type: 'geojson', data: emptyFC() });
  map.addSource('radius', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'radius',
    type: 'line',
    source: 'radius',
    paint: { 'line-color': '#495057', 'line-width': 1.5, 'line-dasharray': [2, 2] },
  });

  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    paint: { 'line-color': '#d6336c', 'line-width': 3, 'line-opacity': 0.8 },
    layout: { 'line-join': 'round', 'line-cap': 'round' },
  });
  map.addLayer({
    id: 'stops-due',
    type: 'circle',
    source: 'stops',
    filter: ['!=', ['get', 'due'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 14],
      'circle-color': ['match', ['get', 'due'], 'here', '#e03131', '#fd7e14'],
      'circle-opacity': 0.35,
    },
  });
  map.addLayer({
    id: 'stops',
    type: 'circle',
    source: 'stops',
    layout: { 'circle-sort-key': ['-', 0, ['get', 'arriveMin']] },
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        11, ['case', ['get', 'onRoute'], 4.5, 3],
        16, ['case', ['get', 'onRoute'], 9, 7],
      ],
      'circle-color': [
        'case', ['all', ['get', 'offToday'], ['!', ['get', 'onRoute']]], '#ffffff',
        bandExpr('arriveMin'),
      ],
      'circle-stroke-color': [
        'case', ['get', 'onRoute'], '#d6336c',
        ['get', 'offToday'], bandExpr('arriveMin'),
        '#ffffff',
      ],
      'circle-stroke-width': ['case', ['get', 'onRoute'], 2, ['get', 'offToday'], 1.5, 0.8],
      'circle-opacity': ['case', ['any', ['get', 'onRoute'], ['!', ['get', 'dim']]], 1, 0.25],
    },
  });

  map.addLayer({
    id: 'labels',
    type: 'symbol',
    source: 'labels',
    minzoom: 14,
    layout: {
      'text-field': labelExpr,
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 17, 14],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.8,
      'text-justify': 'auto',
      'text-line-height': 1.1,
    },
    paint: {
      'text-halo-color': '#ffffff',
      'text-halo-width': 2,
    },
  });

  for (const layer of ['stops', 'labels']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('contextmenu', (e) => showHomeMenu(e.lngLat));
  map.on('click', (e) => {
    const group = stopsAtPoint(e.point);
    if (!group.length) {
      // Empty tap: first clears a highlighted route, then toggles the home menu
      // (the only way to set home on touch devices).
      if (state.selectedRoute) return clearRoute();
      if (homeMenu.isOpen()) return homeMenu.remove();
      return showHomeMenu(e.lngLat);
    }
    homeMenu.remove();
    if (group.length === 1) return selectStop(group[0]);
    // Several stops overlap: keep the current route if it is one of them,
    // otherwise show the picker with nothing selected.
    const current = group.find((s) => routeKey(s) === state.selectedRoute);
    if (current) return selectStop(current, { group });
    clearRoute();
    showStopPopup(null, group);
  });
}

function bindEvents() {
  for (const input of [els.from, els.to]) {
    input.addEventListener('input', () => {
      if (Number(els.from.value) > Number(els.to.value)) {
        if (input === els.from) els.to.value = els.from.value;
        else els.from.value = els.to.value;
      }
      if (state.nextHour) setNextHour(false, { keepRange: true });
      update();
    });
  }
  els.nowBtn.addEventListener('click', () => {
    setNextHour(!state.nextHour);
    update();
  });
  $('reset-btn').addEventListener('click', () => {
    setNextHour(false);
    clearRoute();
    if (state.home) setRefPos(state.home);
    else {
      clearRefPos();
      map.flyTo(CITY_VIEW);
    }
  });
}

// "Next hour" toggles between a window around now and all times. While on,
// the window follows the clock (refreshed by the minute timer).
function setNextHour(on, { keepRange = false } = {}) {
  state.nextHour = on;
  els.nowBtn.textContent = on ? 'Show all' : 'Next hour';
  els.nowBtn.classList.toggle('active', on);
  if (keepRange) return;
  if (on) {
    const { minutes } = taipeiNow();
    // Before 03:00 counts as the tail of the previous evening's 24:xx runs.
    const now = minutes < 180 ? minutes + 1440 : minutes;
    els.from.value = Math.max(MIN_T, now - 15);
    els.to.value = Math.min(MAX_T, now + 60);
  } else {
    els.from.value = MIN_T;
    els.to.value = MAX_T;
  }
}

function filtered() {
  const from = Number(els.from.value);
  const to = Number(els.to.value);
  return state.stops.filter((s) => s.arriveMin >= from && s.arriveMin <= (to === MAX_T ? Infinity : to));
}

// When the day note was parsed into s.days, drop it from the displayed address;
// daysLabel shows the same information with Arabic numerals.
const addressText = (s) =>
  s.days ? s.address.replace(/[（(][^()（）]*(週|星期)[^()（）]*[)）]+/, '').trim() : s.address;
const daysLabel = (days) =>
  `僅週${days.map(dayNum).join('、')} · ${days.map((d) => DAY_EN[d].slice(0, 3)).join('/')} only`;

// Stops with day restrictions in their address are only served on those days.
const servedOn = (s, weekday) => (s.days ? s.days.includes(weekday) : dayInfo(weekday).collecting);

function dueStatus(s, nowMin, weekday) {
  if (!servedOn(s, weekday)) return '';
  for (const now of [nowMin, nowMin + 1440]) {
    if (now >= s.arriveMin && now <= s.leaveMin) return 'here';
    if (s.arriveMin > now && s.arriveMin - now <= 30) return 'soon';
  }
  return '';
}

function update() {
  const from = Number(els.from.value);
  const to = Number(els.to.value);
  els.rangeLabel.textContent = `${formatMinutes(from)} – ${to === MAX_T ? 'end' : formatMinutes(to)}`;

  const visible = filtered();
  const visibleIds = new Set(visible.map((s) => s.id));
  const routeStops = state.selectedRoute ? state.routes.get(state.selectedRoute) : [];
  const routeIds = new Set(routeStops.map((s) => s.id));
  const { weekday, minutes } = taipeiNow();

  // Route stops stay visible even when outside the current filter.
  const shown = state.stops.filter((s) => visibleIds.has(s.id) || routeIds.has(s.id));
  map.getSource('stops').setData({
    type: 'FeatureCollection',
    features: shown.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        id: s.id,
        arriveMin: s.arriveMin,
        onRoute: routeIds.has(s.id),
        dim: state.selectedRoute !== null && !routeIds.has(s.id),
        due: dueStatus(s, minutes, weekday),
        offToday: dayInfo(weekday).collecting && !servedOn(s, weekday),
      },
    })),
  });

  // One label per location; stops sharing a point stack their times.
  const byPoint = new Map();
  for (const s of shown) {
    if (state.selectedRoute && !routeIds.has(s.id)) continue;
    const k = `${s.lng},${s.lat}`;
    if (!byPoint.has(k)) byPoint.set(k, []);
    byPoint.get(k).push(s);
  }
  map.getSource('labels').setData({
    type: 'FeatureCollection',
    features: [...byPoint.values()].map((group) => {
      group.sort((a, b) => a.arriveMin - b.arriveMin);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [group[0].lng, group[0].lat] },
        properties: {
          ...Object.fromEntries(
            group.slice(0, MAX_LABEL_LINES).flatMap((s, i) => [
              [`t${i}`, i ? `\n${s.arrive}` : s.arrive],
              [`m${i}`, s.arriveMin],
            ]),
          ),
          ids: group.map((s) => s.id).join(','),
        },
      };
    }),
  });

  els.count.textContent = `${visible.length.toLocaleString()} of ${state.stops.length.toLocaleString()} stops`;
  renderList(visible);
}

function renderList(visible) {
  let items;
  let title;
  if (state.selectedRoute) {
    const stops = state.routes.get(state.selectedRoute);
    const s = stops[0];
    title = `Route ${s.route} · ${s.trip} · ${s.car} · ${stops.length} stops`;
    items = stops;
  } else if (state.refPos) {
    items = visible
      .map((s) => ({ ...s, dist: distanceM(state.refPos, s) }))
      .filter((s) => s.dist <= NEAR_RADIUS_M)
      .sort((a, b) => a.arriveMin - b.arriveMin);
    title = `${items.length} stops within ${NEAR_RADIUS_M} m of ${state.refPos.label}`;
  } else {
    items = [...visible].sort((a, b) => a.arriveMin - b.arriveMin).slice(0, LIST_LIMIT);
    title = visible.length > LIST_LIMIT ? `First ${LIST_LIMIT} by time — narrow the filters` : 'Stops by time';
  }
  els.listTitle.textContent = title;

  const { weekday, minutes } = taipeiNow();
  els.list.replaceChildren(
    ...items.map((s) => {
      const li = document.createElement('li');
      const due = dueStatus(s, minutes, weekday);
      li.className = due;
      li.innerHTML =
        `<span class="time" style="color:${bandColor(s.arriveMin)}">${s.arrive}</span>` +
        `<span class="addr">${escapeHtml(addressText(s).replace(/^臺北市/, ''))}</span>` +
        `<span class="meta">${s.village} · ${s.route} ${s.trip}` +
        (s.days ? ` · <b>${daysLabel(s.days)}</b>` : '') +
        (s.dist !== undefined ? ` · ${formatDist(s.dist)}` : '') +
        `</span>`;
      li.addEventListener('click', () => selectStop(s, { fly: true }));
      return li;
    }),
  );
}

const stopById = (id) => state.stops.find((s) => s.id === id);
const sameSpot = (a, b) => a.lng === b.lng && a.lat === b.lat;

// Every stop under the click (dots or time labels, with a few px of slop),
// expanded to all stops sharing those exact coordinates.
function stopsAtPoint(point) {
  const pad = 6;
  const features = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers: ['stops', 'labels'] },
  );
  const ids = new Set();
  for (const f of features) {
    if (f.properties.ids) f.properties.ids.split(',').forEach((id) => ids.add(Number(id)));
    else ids.add(f.properties.id);
  }
  const hits = [...ids].map(stopById);
  const visible = new Set(filtered().map((s) => s.id));
  const group = state.stops.filter(
    (s) => (visible.has(s.id) || ids.has(s.id)) && hits.some((h) => sameSpot(h, s)),
  );
  return group.sort((a, b) => a.arriveMin - b.arriveMin);
}

function selectStop(s, { fly = false, group } = {}) {
  state.selectedRoute = routeKey(s);
  const stops = state.routes.get(state.selectedRoute);
  map.getSource('route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: stops.map((p) => [p.lng, p.lat]) },
    properties: {},
  });
  showStopPopup(s, group ?? state.stops.filter((o) => sameSpot(o, s)));
  if (fly) map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 15) });
  update();
}

// Popup for one or more stops at a spot. With several, each is a button that
// switches the highlighted route; the selected one shows full details.
function showStopPopup(selected, group) {
  const node = document.createElement('div');
  node.className = 'stop-popup';
  if (selected) {
    const s = selected;
    node.insertAdjacentHTML(
      'beforeend',
      `<strong>${s.arrive}–${s.leave}</strong><br>${escapeHtml(addressText(s))}<br>` +
        (s.days ? `<b>${daysLabel(s.days)}</b><br>` : '') +
        `<small>${s.district} ${s.village} · ${s.team}<br>Route ${s.route} ${s.trip} · ${s.car}</small>`,
    );
  }
  if (group.length > 1) {
    const head = document.createElement('div');
    head.className = 'picker-head';
    head.textContent = selected ? `${group.length} stops here` : `${group.length} stops here — pick a route`;
    const list = document.createElement('div');
    list.className = 'picker';
    // Overlapping dots at different addresses need the address to tell apart.
    const mixed = group.some((g) => !sameSpot(g, group[0]));
    for (const s of group) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = s === selected ? 'active' : '';
      btn.innerHTML =
        `<span class="t" style="color:${bandColor(s.arriveMin)}">${s.arrive}</span>` +
        `${escapeHtml(s.route)} ${s.trip}` +
        (mixed ? `<small>${escapeHtml(addressText(s).replace(/^臺北市..區/, ''))}</small>` : '');
      btn.addEventListener('click', () => selectStop(s, { group }));
      list.append(btn);
    }
    node.append(head, list);
  }
  const at = selected ?? group[0];
  popup.setLngLat([at.lng, at.lat]).setDOMContent(node).addTo(map);
}

function clearRoute() {
  if (!state.selectedRoute) return;
  state.selectedRoute = null;
  map.getSource('route').setData(emptyFC());
  popup.remove();
  update();
}

function setRefPos(pos) {
  state.refPos = pos;
  refMarker?.remove();
  refMarker = new Marker({ color: '#212529' })
    .setLngLat(pos)
    .addTo(map);
  map.getSource('radius').setData(circle(pos, NEAR_RADIUS_M));
  map.flyTo({ center: pos, zoom: Math.max(map.getZoom(), 15.5) });
  update();
}

function clearRefPos() {
  state.refPos = null;
  refMarker?.remove();
  refMarker = null;
  map.getSource('radius').setData(emptyFC());
  update();
}

function setHome(lngLat) {
  state.home = { lng: lngLat.lng, lat: lngLat.lat, label: 'home' };
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lng: lngLat.lng, lat: lngLat.lat }));
  } catch {}
  clearRoute();
  renderHomeControls();
  setRefPos(state.home);
}

function clearHome() {
  state.home = null;
  try {
    localStorage.removeItem(HOME_KEY);
  } catch {}
  renderHomeControls();
  clearRefPos();
}

function renderHomeControls() {
  els.homeHint.textContent = state.home
    ? 'Home saved in this browser. Tap an empty spot on the map to move or clear it.'
    : 'No home set. Tap an empty spot on the map to set one.';
}

// Home changes only happen through this right-click menu, so a stray click
// in the sidebar cannot move or clear it.
const homeMenu = new Popup({ closeButton: false, closeOnClick: false, className: 'home-menu' });

function showHomeMenu(lngLat) {
  const node = document.createElement('div');
  const item = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => {
      homeMenu.remove();
      onClick();
    });
    node.append(b);
  };
  item(state.home ? 'Move home here' : 'Set home here', () => setHome(lngLat));
  if (state.home) item('Clear home', clearHome);
  homeMenu.setLngLat(lngLat).setDOMContent(node).addTo(map);
}

function circle(center, radiusM, steps = 64) {
  const coords = [];
  const dLat = radiusM / 111320;
  const dLng = dLat / Math.cos((center.lat * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    coords.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

function renderToday() {
  const { weekday, minutes } = taipeiNow();
  const info = dayInfo(weekday);
  const item = (zh, en, cls = '') => `<li class="${cls}"><span>${zh}</span><span class="en">${en}</span></li>`;
  els.today.innerHTML =
    `<div class="day"><b>${info.label} ${info.labelEn}</b><span class="clock">${formatMinutes(minutes)}</span></div>` +
    `<ul class="items">` +
    (info.collecting
      ? item('一般垃圾 + 廚餘', 'General trash + food waste') + item(info.recycling.zh, info.recycling.en)
      : item('今日停收（週3、週7）', 'No collection today (Wed, Sun)', 'off')) +
    `</ul>`;
}

function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const formatDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

init().catch((err) => {
  console.error(err);
  els.count.textContent = `Failed to load data: ${err.message}. Run "npm run fetch-data".`;
});

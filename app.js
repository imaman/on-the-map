'use strict';

/* ============================================================
   On the Map — georeference a pasted image with 2+ points and
   show your live GPS position on it. No backend: state lives in
   localStorage (points, phase) and IndexedDB (the image blob).
   ============================================================ */

const LS_KEY = 'on-the-map/state/v1';
const DB_NAME = 'on-the-map';
const DB_STORE = 'files';
const IMG_KEY = 'map-image';
const METERS_PER_DEG = 111319.4908; // metres per degree of longitude at the equator

const $ = (sel) => document.querySelector(sel);

// ---------- DOM ----------
const viewport = $('#viewport');
const img = $('#map-img');
const overlay = $('#overlay');
const compass = $('#compass');
const recenterBtn = $('#recenter-btn');
const dropZone = $('#drop-zone');
const stepLabel = $('#step-label');
const panelCal = $('#panel-calibrate');
const panelNav = $('#panel-navigate');
const pointList = $('#point-list');
const calHint = $('#cal-hint');
const navStatus = $('#nav-status');
const navDetail = $('#nav-detail');
const coordDialog = $('#coord-dialog');
const coordInput = $('#coord-input');
const coordPreview = $('#coord-preview');
const menuDialog = $('#menu-dialog');

// ---------- persistence ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const state = {
  phase: 'upload',      // 'upload' | 'calibrate' | 'navigate'
  points: [],           // { id, px, py, lat, lon }  (px/py in image pixels)
  follow: true,
};

function saveState() {
  if (state.phase === 'upload') { localStorage.removeItem(LS_KEY); return; }
  const points = state.points.filter((p) => p.lat != null);
  localStorage.setItem(LS_KEY, JSON.stringify({ phase: state.phase, points }));
}
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved && Array.isArray(saved.points)) {
      state.points = saved.points;
      state.phase = saved.phase || 'calibrate';
    }
  } catch { /* ignore corrupt state */ }
}

// ---------- geodesy: similarity transform between Web-Mercator and image pixels ----------
// Mercator with y pointing DOWN so that it has the same handedness as image pixels;
// a complex-number similarity (scale + rotation + translation) then maps one to the other.
function toMerc(lat, lon) {
  const latRad = (lat * Math.PI) / 180;
  return { re: lon, im: (-Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * 180) / Math.PI };
}
const cmul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cconj = (a) => ({ re: a.re, im: -a.im });
const cabs = (a) => Math.hypot(a.re, a.im);

/** Least-squares fit  pixel = a * merc + b  over all points with coordinates. */
function solveTransform(points) {
  const pts = points.filter((p) => p.lat != null && p.lon != null);
  if (pts.length < 2) return null;
  const m = pts.map((p) => toMerc(p.lat, p.lon));
  const q = pts.map((p) => ({ re: p.px, im: p.py }));
  const mean = (arr) => ({ re: arr.reduce((s, v) => s + v.re, 0) / arr.length, im: arr.reduce((s, v) => s + v.im, 0) / arr.length });
  const mBar = mean(m);
  const qBar = mean(q);
  let num = { re: 0, im: 0 };
  let den = 0;
  for (let i = 0; i < pts.length; i++) {
    const dm = { re: m[i].re - mBar.re, im: m[i].im - mBar.im };
    const dq = { re: q[i].re - qBar.re, im: q[i].im - qBar.im };
    const t = cmul(cconj(dm), dq);
    num.re += t.re; num.im += t.im;
    den += dm.re * dm.re + dm.im * dm.im;
  }
  if (den < 1e-18) return null; // identical world coordinates
  const a = { re: num.re / den, im: num.im / den };
  const ab = cmul(a, mBar);
  const b = { re: qBar.re - ab.re, im: qBar.im - ab.im };
  const residuals = pts.map((p, i) => {
    const pred = worldToPixel({ a, b }, p.lat, p.lon);
    const pixErr = Math.hypot(pred.x - p.px, pred.y - p.py);
    return { id: p.id, pixels: pixErr, meters: pixErr / pixelsPerMeter({ a, b }, p.lat) };
  });
  return { a, b, residuals };
}
function worldToPixel(t, lat, lon) {
  const r = cmul(t.a, toMerc(lat, lon));
  return { x: r.re + t.b.re, y: r.im + t.b.im };
}
function pixelsPerMeter(t, lat) {
  return cabs(t.a) / (METERS_PER_DEG * Math.cos((lat * Math.PI) / 180));
}
/** CSS rotation (deg, clockwise) that turns an "up" arrow so it points to geographic north on the image. */
function northRotationDeg(t) {
  // north = -im direction in merc-down coords = complex(0,-1); its image direction = a * (0 - 1i)
  const n = cmul(t.a, { re: 0, im: -1 });
  return (Math.atan2(n.re, -n.im) * 180) / Math.PI;
}

let transform = null;
function recomputeTransform() {
  transform = solveTransform(state.points);
}

// ---------- coordinate parsing ----------
function parseCoords(text) {
  const s = text.trim();
  if (!s) return null;
  let lat, lon;
  let m;
  if ((m = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/))) {            // Google Maps URL ".../@lat,lon,zoom"
    lat = +m[1]; lon = +m[2];
  } else if ((m = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/))) { // Google Maps place URL
    lat = +m[1]; lon = +m[2];
  } else if ((m = s.match(/[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/))) {
    lat = +m[1]; lon = +m[2];
  } else {
    const re = /(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?/gi;
    const found = [];
    let f;
    while ((f = re.exec(s)) && found.length < 2) found.push({ v: +f[1], h: (f[2] || '').toUpperCase() });
    if (found.length < 2) return null;
    const hemi = (x) => (x.h === 'S' || x.h === 'W' ? -Math.abs(x.v) : x.v);
    const isLon = (x) => x.h === 'E' || x.h === 'W';
    const [p0, p1] = found;
    if (isLon(p0) && !isLon(p1)) { lon = hemi(p0); lat = hemi(p1); }
    else { lat = hemi(p0); lon = hemi(p1); }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
const fmtCoord = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

// ---------- view (pan / zoom) ----------
const view = {
  scale: 1, tx: 0, ty: 0, minScale: 0.05, maxScale: 40,
  rect() { return viewport.getBoundingClientRect(); },
  clientToScreen(cx, cy) { const r = this.rect(); return { x: cx - r.left, y: cy - r.top }; },
  screenToImage(sx, sy) { return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale }; },
  imageToScreen(x, y) { return { x: x * this.scale + this.tx, y: y * this.scale + this.ty }; },
  panBy(dx, dy) { this.tx += dx; this.ty += dy; scheduleRender(); },
  zoomAt(sx, sy, factor) {
    const ns = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    const k = ns / this.scale;
    this.tx = sx - (sx - this.tx) * k;
    this.ty = sy - (sy - this.ty) * k;
    this.scale = ns;
    scheduleRender();
  },
  fit() {
    if (!img.naturalWidth) return;
    const r = this.rect();
    const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) * 0.96;
    this.scale = s;
    this.minScale = s * 0.2;
    this.tx = (r.width - img.naturalWidth * s) / 2;
    this.ty = (r.height - img.naturalHeight * s) / 2;
    scheduleRender();
  },
  centerOnImagePoint(x, y) {
    const r = this.rect();
    this.tx = r.width / 2 - x * this.scale;
    this.ty = r.height / 2 - y * this.scale;
    scheduleRender();
  },
};

// Pointer gestures: one pointer pans (or taps), two pointers pinch-zoom, wheel zooms.
const pointers = new Map();
let gesture = null;
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.target.closest('.marker.cal') && state.phase === 'calibrate') return; // marker drag handles itself
  if (e.target.closest('button')) return;
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) gesture = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, multi: false };
  else if (gesture) gesture.multi = true;
  viewport.classList.add('grabbing');
});
viewport.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const cur = { x: e.clientX, y: e.clientY };
  if (pointers.size === 1) {
    if (gesture && Math.hypot(cur.x - gesture.x, cur.y - gesture.y) > 8) gesture.moved = true;
    if (gesture?.moved) {
      view.panBy(cur.x - prev.x, cur.y - prev.y);
      if (state.phase === 'navigate') setFollow(false);
    }
  } else if (pointers.size === 2) {
    const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)[1];
    const oldMid = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
    const newMid = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
    const oldDist = Math.hypot(prev.x - other.x, prev.y - other.y) || 1;
    const newDist = Math.hypot(cur.x - other.x, cur.y - other.y) || 1;
    view.panBy(newMid.x - oldMid.x, newMid.y - oldMid.y);
    const s = view.clientToScreen(newMid.x, newMid.y);
    view.zoomAt(s.x, s.y, newDist / oldDist);
    if (state.phase === 'navigate') setFollow(false);
  }
  pointers.set(e.pointerId, cur);
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    viewport.classList.remove('grabbing');
    if (gesture && !gesture.moved && !gesture.multi && performance.now() - gesture.t < 700 && e.type === 'pointerup') {
      const s = view.clientToScreen(e.clientX, e.clientY);
      onTap(view.screenToImage(s.x, s.y));
    }
    gesture = null;
  }
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!img.naturalWidth) return;
  const unit = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 200 : 1;
  const factor = Math.exp(-e.deltaY * unit * 0.0022);
  const s = view.clientToScreen(e.clientX, e.clientY);
  view.zoomAt(s.x, s.y, factor);
  if (state.phase === 'navigate') setFollow(false);
}, { passive: false });
viewport.addEventListener('dblclick', (e) => {
  if (!img.naturalWidth || state.phase === 'calibrate') return;
  const s = view.clientToScreen(e.clientX, e.clientY);
  view.zoomAt(s.x, s.y, 2);
});
window.addEventListener('resize', scheduleRender);

// ---------- rendering ----------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

const markerEls = new Map(); // point id -> element
let meEl = null;

function ensureMeEl() {
  if (meEl) return meEl;
  meEl = document.createElement('div');
  meEl.className = 'marker me';
  meEl.innerHTML = '<div class="acc"></div><div class="heading" hidden></div><div class="dot"></div>';
  overlay.appendChild(meEl);
  return meEl;
}

function render() {
  img.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;

  // calibration markers
  const seen = new Set();
  state.points.forEach((p, i) => {
    seen.add(p.id);
    let el = markerEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'marker cal';
      el.innerHTML = '<div class="pin"></div><div class="cross"></div>';
      el.dataset.id = p.id;
      attachMarkerDrag(el);
      overlay.appendChild(el);
      markerEls.set(p.id, el);
    }
    el.querySelector('.pin').textContent = i + 1;
    el.classList.toggle('pending', p.lat == null);
    el.classList.toggle('small', state.phase === 'navigate');
    const s = view.imageToScreen(p.px, p.py);
    el.style.transform = `translate(${s.x}px, ${s.y}px)`;
  });
  for (const [id, el] of markerEls) if (!seen.has(id)) { el.remove(); markerEls.delete(id); }

  // user position
  const showMe = state.phase === 'navigate' && lastPosition && transform;
  if (showMe) {
    const el = ensureMeEl();
    const { latitude: lat, longitude: lon, accuracy, heading } = lastPosition.coords;
    const px = worldToPixel(transform, lat, lon);
    const s = view.imageToScreen(px.x, px.y);
    el.hidden = false;
    el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    const radiusPx = (accuracy || 0) * pixelsPerMeter(transform, lat) * view.scale;
    const acc = el.querySelector('.acc');
    acc.style.width = acc.style.height = `${Math.max(0, radiusPx * 2)}px`;
    const hd = el.querySelector('.heading');
    if (heading != null && !Number.isNaN(heading)) {
      hd.hidden = false;
      hd.style.transform = `translate(-50%, -100%) rotate(${northRotationDeg(transform) + heading}deg)`;
    } else hd.hidden = true;
    el.classList.toggle('stale', Date.now() - lastPosition.timestamp > 30000);
  } else if (meEl) meEl.hidden = true;

  // compass
  if (transform && state.phase !== 'upload') {
    compass.hidden = false;
    compass.style.transform = `rotate(${northRotationDeg(transform)}deg)`;
  } else compass.hidden = true;
}

// Dragging a calibration marker to fine-tune its pixel position.
function attachMarkerDrag(el) {
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (state.phase !== 'calibrate') return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const p = state.points.find((q) => q.id === el.dataset.id);
    if (!p) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    p.px += dx / view.scale;
    p.py += dy / view.scale;
    drag.x = e.clientX; drag.y = e.clientY;
    scheduleRender();
  });
  const end = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const wasTap = !drag.moved;
    drag = null;
    const p = state.points.find((q) => q.id === el.dataset.id);
    if (!p) return;
    if (wasTap) openCoordDialog(p);
    else { recomputeTransform(); saveState(); updateCalibratePanel(); scheduleRender(); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ---------- phases ----------
function setPhase(phase) {
  state.phase = phase;
  saveState();
  dropZone.hidden = phase !== 'upload';
  panelCal.hidden = phase !== 'calibrate';
  panelNav.hidden = phase !== 'navigate';
  viewport.classList.toggle('picking', phase === 'calibrate');
  recenterBtn.hidden = phase !== 'navigate';
  $('#menu-edit').hidden = phase === 'upload';
  stepLabel.textContent =
    phase === 'upload' ? 'Step 1 · add a map image' :
    phase === 'calibrate' ? 'Step 2 · mark known points' : 'Navigating';
  if (phase === 'navigate') startNavigation(); else stopNavigation();
  if (phase === 'calibrate') updateCalibratePanel();
  scheduleRender();
}

function onTap(imgPt) {
  if (state.phase !== 'calibrate' || !img.naturalWidth) return;
  if (imgPt.x < 0 || imgPt.y < 0 || imgPt.x > img.naturalWidth || imgPt.y > img.naturalHeight) return;
  const p = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, px: imgPt.x, py: imgPt.y, lat: null, lon: null };
  state.points.push(p);
  scheduleRender();
  openCoordDialog(p);
}

function updateCalibratePanel() {
  const withCoords = state.points.filter((p) => p.lat != null);
  const n = withCoords.length;
  calHint.textContent =
    n === 0 ? 'Tap a spot on the map whose real-world coordinates you know (a corner, a junction, a landmark).' :
    n === 1 ? 'Good. Tap a second, well-separated spot. Drag a marker to fine-tune it; tap it to edit.' :
    'Ready. Add more points for a better fit, or start navigation.';
  pointList.innerHTML = '';
  const resid = transform?.residuals || [];
  state.points.forEach((p, i) => {
    const li = document.createElement('li');
    const r = resid.find((x) => x.id === p.id);
    li.innerHTML = `<span class="num">${i + 1}</span>` +
      `<span class="coords">${p.lat == null ? '<em>no coordinates</em>' : fmtCoord(p.lat, p.lon)}</span>` +
      (r && n >= 3 ? `<span class="resid">±${r.meters < 1000 ? r.meters.toFixed(0) + ' m' : (r.meters / 1000).toFixed(1) + ' km'}</span>` : '') +
      `<button class="btn tiny" data-act="edit">Edit</button><button class="btn tiny danger" data-act="del">✕</button>`;
    li.querySelector('[data-act=edit]').onclick = () => { view.centerOnImagePoint(p.px, p.py); openCoordDialog(p); };
    li.querySelector('[data-act=del]').onclick = () => deletePoint(p.id);
    pointList.appendChild(li);
  });
  $('#start-nav-btn').disabled = n < 2 || !transform;
}

function deletePoint(id) {
  state.points = state.points.filter((p) => p.id !== id);
  recomputeTransform();
  saveState();
  updateCalibratePanel();
  scheduleRender();
}

// ---------- coordinate dialog ----------
let dialogPoint = null;
function openCoordDialog(p) {
  dialogPoint = p;
  $('#dlg-num').textContent = state.points.indexOf(p) + 1;
  coordInput.value = p.lat == null ? '' : fmtCoord(p.lat, p.lon);
  updateCoordPreview();
  coordDialog.showModal();
  setTimeout(() => coordInput.focus(), 50);
}
function updateCoordPreview() {
  const c = parseCoords(coordInput.value);
  coordPreview.className = 'small ' + (c ? 'ok' : coordInput.value.trim() ? 'bad' : '');
  coordPreview.textContent = c ? `lat ${c.lat.toFixed(6)}, lon ${c.lon.toFixed(6)}` : coordInput.value.trim() ? 'Could not read coordinates' : '';
  $('#dlg-ok').disabled = !c;
}
coordInput.addEventListener('input', updateCoordPreview);
coordDialog.addEventListener('close', () => {
  const p = dialogPoint;
  dialogPoint = null;
  if (!p) return;
  const action = coordDialog.returnValue;
  if (action === 'ok') {
    const c = parseCoords(coordInput.value);
    if (c) { p.lat = c.lat; p.lon = c.lon; }
  } else if (action === 'delete') {
    state.points = state.points.filter((q) => q.id !== p.id);
  }
  if (p.lat == null) state.points = state.points.filter((q) => q.id !== p.id); // cancelled new point
  recomputeTransform();
  saveState();
  updateCalibratePanel();
  scheduleRender();
});
$('#use-gps-btn').addEventListener('click', () => {
  const btn = $('#use-gps-btn');
  if (!navigator.geolocation) { coordPreview.textContent = 'Geolocation is not available in this browser.'; return; }
  btn.disabled = true; btn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition((pos) => {
    coordInput.value = fmtCoord(pos.coords.latitude, pos.coords.longitude);
    updateCoordPreview();
    coordPreview.textContent += ` (accuracy ±${Math.round(pos.coords.accuracy)} m)`;
    btn.disabled = false; btn.textContent = 'Use my current location';
  }, (err) => {
    coordPreview.className = 'small bad';
    coordPreview.textContent = geoErrorText(err);
    btn.disabled = false; btn.textContent = 'Use my current location';
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
});

// ---------- navigation ----------
let watchId = null;
let lastPosition = null;
let wakeLock = null;

function geoErrorText(err) {
  if (!window.isSecureContext) return 'Location needs a secure (HTTPS) page or localhost.';
  switch (err?.code) {
    case 1: return 'Location permission denied. Allow location access for this site in your browser settings.';
    case 2: return 'Position unavailable. Check that location services are on.';
    case 3: return 'Timed out waiting for a location fix.';
    default: return err?.message || 'Unknown location error.';
  }
}

function startNavigation() {
  recomputeTransform();
  if (!navigator.geolocation) { setNavStatus('Geolocation is not supported by this browser.', true); return; }
  if (watchId != null) return;
  setNavStatus('Waiting for location…');
  watchId = navigator.geolocation.watchPosition(onPosition, (err) => setNavStatus(geoErrorText(err), true),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  requestWakeLock();
}
function stopNavigation() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  lastPosition = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  scheduleRender();
}
function onPosition(pos) {
  lastPosition = pos;
  if (!transform) { setNavStatus('Need at least two calibrated points.', true); return; }
  const { latitude: lat, longitude: lon, accuracy, speed } = pos.coords;
  const px = worldToPixel(transform, lat, lon);
  const onMap = px.x >= 0 && px.y >= 0 && px.x <= img.naturalWidth && px.y <= img.naturalHeight;
  setNavStatus(onMap ? `On map · accuracy ±${Math.round(accuracy)} m` : `Outside the map image · accuracy ±${Math.round(accuracy)} m`, !onMap);
  const parts = [fmtCoord(lat, lon)];
  if (speed != null && speed > 0.3) parts.push(`${(speed * 3.6).toFixed(1)} km/h`);
  navDetail.textContent = parts.join(' · ');
  if (state.follow) view.centerOnImagePoint(px.x, px.y);
  scheduleRender();
}
function setNavStatus(text, isErr = false) {
  navStatus.textContent = text;
  navStatus.classList.toggle('err', isErr);
}
function setFollow(on) {
  state.follow = on;
  recenterBtn.classList.toggle('active', on);
  if (on && lastPosition && transform) {
    const px = worldToPixel(transform, lastPosition.coords.latitude, lastPosition.coords.longitude);
    view.centerOnImagePoint(px.x, px.y);
  }
}
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && state.phase === 'navigate' && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWakeLock(); });
setInterval(() => { if (state.phase === 'navigate' && lastPosition) scheduleRender(); }, 10000); // refresh "stale" styling

// ---------- image input ----------
let imgObjectUrl = null;
function showImage(blob) {
  return new Promise((resolve, reject) => {
    if (imgObjectUrl) URL.revokeObjectURL(imgObjectUrl);
    imgObjectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      img.style.width = `${img.naturalWidth}px`;
      img.style.height = `${img.naturalHeight}px`;
      img.hidden = false;
      view.fit();
      resolve();
    };
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = imgObjectUrl;
  });
}
async function acceptNewImage(blob) {
  if (!blob || !blob.type.startsWith('image/')) { setUploadMsg('That is not an image.'); return; }
  try {
    await showImage(blob);
  } catch (e) { setUploadMsg(e.message); return; }
  try { await idbPut(IMG_KEY, blob); }
  catch { setUploadMsg('Image shown, but could not be saved for next time (storage blocked?).'); }
  state.points = [];
  recomputeTransform();
  setPhase('calibrate');
}
function setUploadMsg(text) { $('#upload-msg').textContent = text; }

document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find((it) => it.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  confirmReplace().then((ok) => ok && acceptNewImage(item.getAsFile()));
});
$('#file-input').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) confirmReplace().then((ok) => ok && acceptNewImage(f));
});
$('#paste-btn').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.read) throw new Error('unsupported');
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) { acceptNewImage(await it.getType(type)); return; }
    }
    setUploadMsg('No image found in the clipboard.');
  } catch {
    setUploadMsg('Clipboard access is unavailable here. Use Ctrl+V or choose a file.');
  }
});
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) confirmReplace().then((ok) => ok && acceptNewImage(f));
});
async function confirmReplace() {
  if (state.phase === 'upload') return true;
  return confirm('Replace the current map? Its calibration points will be discarded.');
}

// ---------- menu & buttons ----------
$('#menu-btn').addEventListener('click', () => menuDialog.showModal());
menuDialog.addEventListener('close', async () => {
  switch (menuDialog.returnValue) {
    case 'replace': $('#file-input').click(); break;
    case 'edit': if (state.phase !== 'upload') setPhase('calibrate'); break;
    case 'fit': view.fit(); break;
    case 'reset':
      if (confirm('Delete the map image and all calibration points?')) {
        stopNavigation();
        state.points = [];
        transform = null;
        localStorage.removeItem(LS_KEY);
        await idbDelete(IMG_KEY).catch(() => {});
        img.hidden = true; img.removeAttribute('src');
        setPhase('upload');
      }
      break;
  }
});
$('#fit-btn').addEventListener('click', () => view.fit());
$('#start-nav-btn').addEventListener('click', () => { setFollow(true); setPhase('navigate'); });
$('#edit-points-btn').addEventListener('click', () => setPhase('calibrate'));
$('#stop-nav-btn').addEventListener('click', () => setPhase('calibrate'));
recenterBtn.addEventListener('click', () => setFollow(true));

// ---------- boot ----------
(async function init() {
  loadState();
  let blob = null;
  try { blob = await idbGet(IMG_KEY); } catch { /* no storage */ }
  if (blob) {
    try { await showImage(blob); } catch { blob = null; }
  }
  if (!blob) {
    state.points = [];
    setPhase('upload');
    if (!window.isSecureContext) setUploadMsg('Note: location tracking requires HTTPS or localhost.');
    return;
  }
  recomputeTransform();
  const phase = state.phase === 'navigate' && transform ? 'navigate' : 'calibrate';
  if (phase === 'navigate') setFollow(true);
  setPhase(phase);
})();

// hud.js : the full-screen dashboard from the team's reference image (opened by tapping the kart), plus the live maps.
// Uses app.html's globals: $, fmt, fin, last, track, lastFix, lapTrack, lapStart, lapNo, best, lastLapMs, markLap, openPart, openId, zoneState,
// LIMITS, TEMPS, FAULT_TEXT, MC_FAULT, CRIT_MASK, MODES, RPM_MAX, RPM_RED, KW_MIN, KW_MAX, V_MIN, V_MAX.
// Maps: Leaflet with OpenStreetMap tiles (free, no key; the dark look is a CSS filter); the service worker keeps the tiles you have seen.
// Google Maps (dark style) is ready too: put a key in GMAPS_KEY and every map switches to it, falling back to OSM if Google cannot load.
"use strict";

// ---------- maps ----------
const MAP_HOME = [34.0698, 72.6444];                       // GIKI, Topi: shown until the kart has a GPS fix
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
// Browser key for the Maps JavaScript API; empty = OpenStreetMap only. A key is visible to anyone who opens the app, so before adding
// one restrict it in Google Cloud to HTTP referrers https://mdaudmirza.github.io/* and http://localhost:*/*, to the Maps JavaScript API
// only, and cap its daily map loads.
const GMAPS_KEY = "";
const GDARK = [                                              // graphite like the app, PARCO orange only on the kart and the lap line
  { elementType: "geometry", stylers: [{ color: "#1c1f23" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8d929b" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#121417" }] },
  { elementType: "labels.icon", stylers: [{ saturation: -100 }, { lightness: -35 }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#2c3036" }] },
  { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#25292f" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#22262b" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1a2a1f" }] },
  { featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#353a42" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#16181b" }] },
  { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#4a4339" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1822" }] },
];
let mapKind = "leaflet";
const mapsReady = new Promise(res => {
  let settled = false; const done = k => { if (settled) return; settled = true; mapKind = k; res(); };
  if (!GMAPS_KEY || !navigator.onLine) return done("leaflet");
  window.gm_authFailure = () => { if (mapKind === "google") { mapKind = "leaflet"; remakeMaps(); } else done("leaflet"); };   // key refused
  window.__gmReady = () => Promise.all([google.maps.importLibrary("maps"), google.maps.importLibrary("marker")]).then(() => done("google"), () => done("leaflet"));
  const sc = document.createElement("script"); sc.async = true; sc.onerror = () => done("leaflet");
  sc.src = `https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}&v=weekly&loading=async&callback=__gmReady`;
  document.head.appendChild(sc);
  setTimeout(() => done("leaflet"), 8000);                   // slow network: use OSM rather than wait
});
const KART_ICON = '<svg width="28" height="28" viewBox="-14 -14 28 28"><g class="rot"><path d="M0 -12 L9 10 L0 5 L-9 10 Z" fill="#ff8a1f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></g></svg>';
let heading = 0;

function bearing(a, b) {                                     // degrees clockwise from north, a -> b
  const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function metres(a, b) { const k = Math.cos(a[0] * Math.PI / 180); return Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * k); }
function updateHeading() {                                    // from the last GPS points at least 1.5 m apart
  const n = track.length; if (n < 2) return;
  for (let j = n - 2; j >= Math.max(0, n - 30); j--) if (metres(track[j], track[n - 1]) > 1.5) { heading = bearing(track[j], track[n - 1]); return; }
}

// Every map shows the kart where it is; the track line appears only while a lap is being timed and starts over every lap.
// mini: the round Drive-screen map, north-up, always centred on the kart, no gestures (the arrow over it is drawn in app.html)
// Each map offers: update(), zoomIn(), zoomOut(), fitLap(pad), resize(), setTheme(t), destroy(), plus follow / fitted / onFollow.
function makeMap(el, opts = {}) { return mapKind === "google" ? makeGoogleMap(el, opts) : makeLeafletMap(el, opts); }

function makeGoogleMap(el, { theme = "dark", follow = true, mini = false, still = false } = {}) {
  const g = google.maps, ll = p => ({ lat: p[0], lng: p[1] });
  const map = new g.Map(el, { center: ll(MAP_HOME), zoom: 17, minZoom: 3, maxZoom: 20, disableDefaultUI: true, clickableIcons: false,
    keyboardShortcuts: !(mini || still), gestureHandling: mini || still ? "none" : "greedy", backgroundColor: "#0b0c0e", styles: theme === "dark" ? GDARK : [] });
  const line = new g.Polyline({ map, strokeColor: "#ff8a1f", strokeOpacity: .95, strokeWeight: mini ? 3 : 3.5, clickable: false });
  const start = new g.Marker({ clickable: false, icon: { path: g.SymbolPath.CIRCLE, scale: 5, fillColor: "#2fbf4a", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 } });
  const kartIcon = { path: "M0 -12 L9 10 L0 5 L-9 10 Z", fillColor: "#ff8a1f", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 1.6, scale: 1, anchor: new g.Point(0, 0), rotation: 0 };
  const kart = new g.Marker({ clickable: false, icon: kartIcon });
  const m = { follow, fitted: false };
  map.addListener("dragstart", () => { m.follow = false; m.onFollow && m.onFollow(false); });
  const fit = (pts, pad) => { const b = new g.LatLngBounds(); for (const p of pts) b.extend(ll(p)); map.fitBounds(b, pad);
    g.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > 18) map.setZoom(18); }); };
  m.update = () => {
    const lap = lapStart ? lapTrack : [];
    line.setPath(lap.map(ll));
    if (lap.length && !mini) { start.setPosition(ll(lap[0])); if (!start.getMap()) start.setMap(map); } else if (start.getMap()) start.setMap(null);
    if (!lastFix) { if (kart.getMap()) kart.setMap(null); return; }
    if (!mini) { kartIcon.rotation = heading; kart.setIcon(kartIcon); kart.setPosition(ll(lastFix)); if (!kart.getMap()) kart.setMap(map); }
    if (m.follow || mini) mini ? map.setCenter(ll(lastFix)) : map.panTo(ll(lastFix));
    else if (!m.fitted && lap.length > 5) { fit(lap, 24); m.fitted = true; }
  };
  m.zoomIn = () => map.setZoom(map.getZoom() + 1); m.zoomOut = () => map.setZoom(map.getZoom() - 1);
  m.fitLap = pad => fit(lapTrack, pad);
  m.resize = () => {};                                       // Google watches its own size
  m.setTheme = t => map.setOptions({ styles: t === "dark" ? GDARK : [] });
  m.destroy = () => { line.setMap(null); start.setMap(null); kart.setMap(null); el.replaceChildren(); el.removeAttribute("style"); };
  return m;
}

function makeLeafletMap(el, { theme = "dark", follow = true, mini = false, still = false } = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: !mini, zoomSnap: 0.5, minZoom: 3, maxZoom: 20, fadeAnimation: !mini,
    ...(mini || still ? { dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false } : {}) }).setView(MAP_HOME, 17);
  if (!mini) map.attributionControl.setPrefix(false);                        // the mini map's credit is in Settings > About
  const tiles = L.tileLayer(TILE_URL, { maxZoom: 20, maxNativeZoom: 19, attribution: TILE_ATTR, className: theme === "dark" ? "tiles-dark" : "" }).addTo(map);
  const line = L.polyline([], { color: "#ff8a1f", weight: mini ? 3 : 3.5, opacity: .95, className: "trackline", interactive: false }).addTo(map);
  const start = L.circleMarker(MAP_HOME, { radius: 5, color: "#fff", weight: 2, fillColor: "#2fbf4a", fillOpacity: 1, interactive: false });
  const kart = L.marker(MAP_HOME, { icon: L.divIcon({ className: "kartmk", html: KART_ICON, iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false, keyboard: false });
  const m = { follow, fitted: false };
  map.on("dragstart", () => { m.follow = false; m.onFollow && m.onFollow(false); });
  m.update = () => {
    const lap = lapStart ? lapTrack : [];
    line.setLatLngs(lap);
    if (lap.length && !mini) { start.setLatLng(lap[0]); if (!map.hasLayer(start)) start.addTo(map); } else if (map.hasLayer(start)) start.remove();
    if (!lastFix) { if (map.hasLayer(kart)) kart.remove(); return; }
    if (!mini) {
      kart.setLatLng(lastFix); if (!map.hasLayer(kart)) kart.addTo(map);
      const rot = kart.getElement() && kart.getElement().querySelector(".rot"); if (rot) rot.setAttribute("transform", `rotate(${heading.toFixed(0)})`);
    }
    if (m.follow || mini) map.panTo(lastFix, { animate: !mini, duration: 0.45 });
    else if (!m.fitted && lap.length > 5) { map.fitBounds(line.getBounds(), { padding: [24, 24], maxZoom: 18 }); m.fitted = true; }
  };
  m.zoomIn = () => map.zoomIn(); m.zoomOut = () => map.zoomOut();
  m.fitLap = pad => map.fitBounds(L.latLngBounds(lapTrack), { padding: [pad, pad], maxZoom: 18 });
  m.resize = () => map.invalidateSize();
  m.setTheme = t => tiles.getContainer().classList.toggle("tiles-dark", t === "dark");
  m.destroy = () => map.remove();
  return m;
}
const mapsAvailable = () => mapKind === "google" || typeof L !== "undefined";

// Google refused the key after the maps were made: rebuild whichever maps are on screen with OpenStreetMap
function remakeMaps() {
  for (const m of [miniMap, lapsMap, hudMap, fullMap]) if (m) m.destroy();
  miniMap = lapsMap = hudMap = fullMap = null;
  if (!$("view-drive").hidden) miniMapShow();
  if (!$("view-laps").hidden) lapsMapShow();
  if ($("hud") && !$("hud").hidden) hudMapShow();
  if ($("mapFull") && !$("mapFull").hidden) fullMapShow();
}

// Drive screen: the round mini map in the top-right corner
let miniMap = null;
function miniMapShow() {
  mapsReady.then(() => {
    const el = $("miniMapCanvas"); if (!el || !mapsAvailable()) return;
    if (!miniMap) miniMap = makeMap(el, { mini: true });
    setTimeout(() => { miniMap.resize(); miniMap.update(); }, 0);
  });
}
window.miniMapShow = miniMapShow;
window.addEventListener("resize", () => { if (miniMap) miniMap.resize(); });

// Laps tab: whole-session map, follows the theme
let lapsMap = null;
const pageTheme = () => matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
function lapsMapShow() {
  mapsReady.then(() => {
    const el = $("lapMap"); if (!el || !mapsAvailable()) return;
    if (!lapsMap) { lapsMap = makeMap(el, { theme: pageTheme(), follow: false }); matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => lapsMap && lapsMap.setTheme(pageTheme())); }
    setTimeout(() => { lapsMap.resize(); lapsMap.fitted = false; lapsMap.update(); }, 0);
  });
}
window.lapsMapShow = lapsMapShow;

// ---------- dashboard markup ----------
const ARC = (cx, cy, r, a0, a1) => {                          // SVG arc from angle a0 to a1 (degrees, maths convention), clockwise
  const p = a => [cx + r * Math.cos(a * Math.PI / 180), cy - r * Math.sin(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1), large = Math.abs(a0 - a1) > 180 ? 1 : 0, sweep = a0 > a1 ? 1 : 0;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
};
const LEDS = 60;
function rpmSvg() {
  const cx = 150, cy = 130, r = 118, A = f => 210 - 240 * f, red = RPM_RED / RPM_MAX;
  let ticks = "";
  for (let k = 0; k <= RPM_MAX / 1000; k++) {
    const f = k * 1000 / RPM_MAX, a = A(f) * Math.PI / 180, major = k % 2 === 0, r0 = r - 12, r1 = r - (major ? 26 : 19);
    ticks += `<line class="tick${major ? "" : " minor"}" x1="${(cx + r0 * Math.cos(a)).toFixed(1)}" y1="${(cy - r0 * Math.sin(a)).toFixed(1)}" x2="${(cx + r1 * Math.cos(a)).toFixed(1)}" y2="${(cy - r1 * Math.sin(a)).toFixed(1)}"/>`;
    if (major) ticks += `<text x="${(cx + (r - 40) * Math.cos(a)).toFixed(1)}" y="${(cy - (r - 40) * Math.sin(a)).toFixed(1)}">${k}</text>`;
  }
  // LED ring: short radial segments that light up to the rpm, green -> PARCO orange -> red in the red zone
  let leds = "";
  for (let i = 0; i < LEDS; i++) {
    const f = (i + 0.5) / LEDS, a = A(f) * Math.PI / 180, r0 = r + 3, r1 = r + 15, c = f >= red ? "r" : f >= 0.6 ? "a" : "g";
    leds += `<line class="led ${c}" x1="${(cx + r0 * Math.cos(a)).toFixed(1)}" y1="${(cy - r0 * Math.sin(a)).toFixed(1)}" x2="${(cx + r1 * Math.cos(a)).toFixed(1)}" y2="${(cy - r1 * Math.sin(a)).toFixed(1)}"/>`;
  }
  return `<svg class="rpmg" viewBox="0 0 300 195" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="trk" d="${ARC(cx, cy, r - 4, A(0), A(1))}"/><path class="red" d="${ARC(cx, cy, r - 4, A(red), A(1))}"/>
    <g id="hLeds">${leds}</g>${ticks}</svg>`;
}
const AMP_MIN = -40, AMP_MAX = 160;
function ampSvg() {
  const cx = 100, cy = 100, r = 82, A = f => 225 - 270 * f, z = -AMP_MIN / (AMP_MAX - AMP_MIN);
  let ticks = "";
  for (let v = AMP_MIN; v <= AMP_MAX; v += 20) {
    const f = (v - AMP_MIN) / (AMP_MAX - AMP_MIN), a = A(f) * Math.PI / 180, major = v % 40 === 0;
    ticks += `<line class="tick" x1="${(cx + (r - 6) * Math.cos(a)).toFixed(1)}" y1="${(cy - (r - 6) * Math.sin(a)).toFixed(1)}" x2="${(cx + (r - (major ? 14 : 10)) * Math.cos(a)).toFixed(1)}" y2="${(cy - (r - (major ? 14 : 10)) * Math.sin(a)).toFixed(1)}"/>`;
    if (major) ticks += `<text x="${(cx + (r - 26) * Math.cos(a)).toFixed(1)}" y="${(cy - (r - 26) * Math.sin(a)).toFixed(1)}">${v}</text>`;
  }
  return `<svg class="ampg" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="trk" d="${ARC(cx, cy, r, A(0), A(1))}"/>
    <path class="val" id="hAmpArc" d="${ARC(cx, cy, r, A(z), A(1))}" pathLength="100"/>
    <path class="val regen" id="hRegArc" d="${ARC(cx, cy, r, A(z), A(0))}" pathLength="100"/>
    ${ticks}<line class="needle" id="hNeedle" x1="100" y1="100" x2="100" y2="34" style="transform-box: view-box"/><circle cx="100" cy="100" r="6" fill="#fff"/></svg>`;
}
function tempSvg(id) {
  const cx = 60, cy = 56, r = 42, A = f => 210 - 240 * f;
  return `<svg viewBox="0 0 120 98" aria-hidden="true">${id === "tMot" ? `<defs><linearGradient id="hTempGrad" gradientUnits="userSpaceOnUse" x1="18" y1="0" x2="102" y2="0">
    <stop offset="0" stop-color="#2fbf4a"/><stop offset=".55" stop-color="#ffd60a"/><stop offset="1" stop-color="#ff453a"/></linearGradient></defs>` : ""}
    <path class="trk" d="${ARC(cx, cy, r, A(0), A(1))}"/><path class="val" id="hT_${id}" d="${ARC(cx, cy, r, A(0), A(1))}" pathLength="100"/>
    <text class="t" x="60" y="58" id="hTv_${id}">--</text></svg>`;
}
const SEGS = 20;
function hudMarkup() {
  return `<section class="hud" id="hud" role="dialog" aria-modal="true" aria-label="Dashboard" hidden>
  <div class="hud-grid"><svg class="hud-trace" id="hTrace" aria-hidden="true"></svg>
    <button class="hp h-volt cut-br" type="button" data-part="battery" aria-label="Battery details"><div class="in">
      <div class="vscale"><span>${V_MAX}</span><span>${Math.round((V_MAX + V_MIN) / 2)}</span><span>${V_MIN}</span></div>
      <div class="vsegs" id="hSegs">${"<i></i>".repeat(SEGS)}</div>
      <div class="txt"><div class="hl">Battery voltage</div><div class="hv"><span id="hV">--</span><small>V</small></div><div class="hs" id="hSoc">SoC --</div><div class="hs" id="hRange">Range --</div></div></div></button>
    <button class="hp h-rpm cut-b" type="button" data-part="motor" aria-label="Motor details"><div class="in">${rpmSvg()}
      <div class="spdc"><span class="big" id="hKmh">--</span><span class="u" data-unit="speed">km/h</span><span class="hs" id="hRpm">-- rpm</span></div>
      <span class="mode-chip" id="hMode" role="button" tabindex="0" aria-label="Drive mode. Tap to change">Mode --</span></div></button>
    <button class="hp h-amps cut-bl" type="button" data-part="inverter" aria-label="Pack current, inverter details"><div class="in">${ampSvg()}
      <span class="hl top">Current</span><div class="ampc"><div class="hv"><span id="hA">--</span><small>A</small></div></div></div></button>
    <button class="hp h-power cut-r" type="button" data-part="battery" aria-label="Power, battery details"><div class="in">
      <div class="hv"><span id="hKw">--</span><small>kW</small></div>
      <div class="hbar"><i id="hKwBar"></i><b id="hKwZero"></b></div><div class="hl">Power</div></div></button>
    <div class="hp h-map cut-t"><div class="in"><div id="hMap" role="application" aria-label="Live track map"></div>
      <div class="mapui tl"><div class="north" aria-hidden="true"><svg width="14" height="16" viewBox="0 0 14 16"><path d="M7 0 L13 15 L7 11 L1 15Z" fill="#ff8a1f"/></svg>N</div></div>
      <button class="maptap" type="button" id="hMapTap" aria-label="Open the full-screen map"></button>
      <div class="mapnote" id="hMapNote">Waiting for GPS fix</div></div></div>
    <div class="hp h-temps cut-l"><div class="in">
      <button class="tg" type="button" data-part="motor" aria-label="Motor temperature, details">${tempSvg("tMot")}<span class="hl">Motor temp</span><span class="st" id="hTs_tMot"></span></button>
      <button class="tg" type="button" data-part="battery" aria-label="Battery temperature, details">${tempSvg("tBatt")}<span class="hl">Battery temp</span><span class="st" id="hTs_tBatt"></span></button></div></div>
    <div class="hp h-lap cut-tr"><div class="in">
      <div class="txt"><div class="hl" id="hLapLbl">Lap</div><div class="hv" id="hLapNow">0:00.0</div><div class="hs" id="hLapSub">Tap the flag at the start line</div></div>
      <button class="flagbtn" type="button" id="hLapBtn" aria-label="Start lap"><svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg></button></div></div>
    <div class="hp h-pedals cut-tl"><div class="in">
      <div class="ped"><span class="hl">Throttle</span><div class="hbar"><i id="hThr"></i></div><span class="r" id="hThrT">--</span></div>
      <div class="ped" title="No brake sensor yet: regenerative braking current is shown"><span class="hl">Regen</span><div class="hbar"><i id="hRegen"></i></div><span class="r" id="hRegT">--</span></div>
      </div></div>
  </div>
  <button class="hud-close" type="button" id="hudClose" aria-label="Close dashboard"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  <div class="hud-alert" id="hAlert" role="status" hidden><span id="hAlertT"></span></div>
  <div class="hud-tell" aria-hidden="true">
    <svg viewBox="0 0 24 24"><rect x="3" y="7" width="16" height="10" rx="1.5"/><path d="M21 10.5v3M7 12h5"/></svg>
    <svg viewBox="0 0 24 24"><path d="M13 3L6 13.5h5L10 21l7-10.5h-5z"/></svg>
    <svg viewBox="0 0 24 24"><path d="M12 3v11.5M9.5 14.6a3.6 3.6 0 1 0 5 0V5.5a2.5 2.5 0 0 0-5 0z"/><path d="M15.5 7h3M15.5 10h3"/></svg>
  </div>
  <div class="hud-status" id="hStatus" data-s="idle"><span class="dot"></span><span id="hStatusT"></span></div>
</section>`;
}

// ---------- open / close ----------
let hudMap = null, hudBuilt = false, hudTimer = null;
// Sideways the panels interlock like the team's reference: each is a polygon on one shared plan (percent of the dashboard),
// the speed gauge a trapezoid, the map a hexagon under it, the others wrapped around their slanted sides. Every polygon is
// pulled 1 px inside its outline, so neighbours leave a hairline seam; the neon edge is the 2 px band between --shape and --shape-in.
const HUD_PLAN = {
  volt:   [[0, 0], [21, 0], [30.5, 38], [0, 38]],
  rpm:    [[21, 0], [79, 0], [67, 48], [33, 48]],
  amps:   [[79, 0], [100, 0], [100, 38], [69.5, 38]],
  power:  [[0, 38], [30.5, 38], [33, 48], [22, 79], [0, 79]],
  map:    [[33, 48], [67, 48], [78, 79], [72, 100], [28, 100], [22, 79]],
  pedals: [[69.5, 38], [100, 38], [100, 79], [78, 79], [67, 48]],
  lap:    [[0, 79], [22, 79], [28, 100], [0, 100]],
  temps:  [[78, 79], [100, 79], [100, 100], [72, 100]],
};
function insetPoly(pts, d) {                                  // a convex polygon moved d px inwards on every side
  const n = pts.length; let area = 0;
  for (let i = 0; i < n; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n]; area += x0 * y1 - x1 * y0; }
  const sg = area > 0 ? 1 : -1;
  const lines = pts.map((p, i) => { const q = pts[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    return { x: p[0] - sg * dy / len * d, y: p[1] + sg * dx / len * d, dx, dy }; });
  return lines.map((b, i) => { const a = lines[(i + n - 1) % n], den = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(den) < 1e-9) return [b.x, b.y];
    const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / den; return [a.x + t * a.dx, a.y + t * a.dy]; });
}
const polyCss = (pts, ox, oy) => `polygon(${pts.map(([x, y]) => `${(x - ox).toFixed(1)}px ${(y - oy).toFixed(1)}px`).join(", ")})`;
function layoutHud() {
  const g = document.querySelector(".hud-grid"); if (!g) return;
  const side = matchMedia("(min-aspect-ratio: 1/1)").matches, W = g.clientWidth, H = g.clientHeight;
  g.classList.toggle("interlock", side);
  for (const [name, plan] of Object.entries(HUD_PLAN)) {
    const el = g.querySelector(".h-" + name); if (!el) continue;
    if (!side || !W || !H) { for (const k of ["left", "top", "width", "height", "--shape", "--shape-in"]) el.style.removeProperty(k); continue; }
    const px = plan.map(([x, y]) => [x / 100 * W, y / 100 * H]), outer = insetPoly(px, 1), inner = insetPoly(px, 3);
    const x0 = Math.min(...outer.map(p => p[0])), y0 = Math.min(...outer.map(p => p[1]));
    const x1 = Math.max(...outer.map(p => p[0])), y1 = Math.max(...outer.map(p => p[1]));
    Object.assign(el.style, { left: x0 + "px", top: y0 + "px", width: (x1 - x0) + "px", height: (y1 - y0) + "px" });
    el.style.setProperty("--shape", polyCss(outer, x0, y0)); el.style.setProperty("--shape-in", polyCss(inner, x0 + 2, y0 + 2));
  }
  // the start-up outlines: one polygon per panel, drawn in on opening (crimson for the speed gauge and map, like the seam between them)
  const tr = $("hTrace");
  if (tr) tr.innerHTML = !side || !W ? "" : Object.entries(HUD_PLAN).map(([name, plan], i) => {
    const pts = insetPoly(plan.map(([x, y]) => [x / 100 * W, y / 100 * H]), 1); let len = 0;
    pts.forEach((p, j) => { const q = pts[(j + 1) % pts.length]; len += Math.hypot(q[0] - p[0], q[1] - p[1]); });
    return `<polygon class="${name === "rpm" || name === "map" ? "red" : ""}" style="--len:${len.toFixed(0)};--d:${i * 55}ms" points="${pts.map(p => p.map(v => v.toFixed(1)).join(",")).join(" ")}"/>`;
  }).join("");
  if (hudMap) hudMap.resize();                                  // the map redraws for its new size
}
window.addEventListener("resize", () => { if (hudBuilt) layoutHud(); });
function buildHud() {
  document.body.insertAdjacentHTML("beforeend", hudMarkup()); hudBuilt = true;
  $("hud").addEventListener("click", e => { const b = e.target.closest("[data-part]"); if (b) openPart(b.dataset.part); });
  $("hudClose").onclick = () => closeHud();
  $("hLapBtn").onclick = () => lapToggle();                         // press: start the lap; press again: stop it
  $("hMapTap").onclick = () => openMapFull();                      // tap anywhere on the map: the full-screen map, with its buttons
  // the mode chip on the RPM gauge: tap for the next drive mode (not the motor details behind it)
  $("hMode").addEventListener("click", e => { e.stopPropagation(); cycleMode(); });
  $("hMode").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); cycleMode(); } });
  $("hKwZero").style.left = (-KW_MIN / (KW_MAX - KW_MIN) * 100) + "%";
  new ResizeObserver(layoutHud).observe(document.querySelector(".hud-grid")); layoutHud();
}
function openHud() {
  if (!hudBuilt) buildHud();
  const h = $("hud"); if (!h.hidden) return;
  h.hidden = false; layoutHud(); requestAnimationFrame(() => h.classList.add("open"));   // shapes placed before anything shows
  document.documentElement.style.overflow = "hidden";
  history.pushState({ hud: 1 }, "");
  // the map is created after the fade-in, so it never competes with the transition for frames
  setTimeout(hudMapShow, 300);
  if (last) hudRender(last);
  hudPowerOn();
  clearInterval(hudTimer); hudTimer = setInterval(hudTick, 100);
  $("hudClose").focus({ preventScroll: true });
}
function hudMapShow() {
  mapsReady.then(() => {
    if (!mapsAvailable()) { $("hMapNote").textContent = "Map unavailable"; return; }
    if (!hudMap) hudMap = makeMap($("hMap"), { theme: "dark", follow: true, still: true });
    hudMap.resize(); hudMap.update();
  });
}
function closeHud(fromPop) {
  const h = $("hud"); if (!h || h.hidden) return;
  h.classList.remove("open"); setTimeout(() => { h.hidden = true; }, 250);
  document.documentElement.style.overflow = "";
  clearInterval(hudTimer);
  if (window.kart3d && kart3d.home) kart3d.home();                              // camera back out of the driver's seat
  if (!fromPop && history.state && history.state.hud) history.back();
}
// back gesture: the full-screen map closes first, then the dashboard
window.addEventListener("popstate", () => { const st = history.state || {}; if (!st.mapfull) closeMapFull(true); if (!st.hud && !st.mapfull) closeHud(true); });
document.addEventListener("keydown", e => { if (e.key !== "Escape" || openId) return; const mf = $("mapFull"); if (mf && !mf.hidden) closeMapFull(); else closeHud(); });

// Full-screen map: opened from the Drive screen's round map or the dashboard's map; Back (or the phone's back gesture) closes it
let fullMap = null;
function buildMapFull() {
  const d = document.createElement("div"); d.className = "hud mapfull"; d.id = "mapFull"; d.hidden = true;
  d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Map");
  d.innerHTML = `<div id="mfMap" role="application" aria-label="Live track map"></div>
    <button class="mfback" type="button" id="mfBack"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Back</button>
    <div class="mapui br">
      <button class="mbtn" type="button" id="mfIn" aria-label="Zoom in">+</button>
      <button class="mbtn" type="button" id="mfOut" aria-label="Zoom out">−</button>
      <button class="mbtn" type="button" id="mfFollow" aria-pressed="true" aria-label="Follow the kart"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button>
      <button class="mbtn" type="button" id="mfFit" aria-label="Show the whole lap"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
    </div>
    <div class="mapnote" id="mfNote">Waiting for GPS fix</div>`;
  document.body.appendChild(d);
  $("mfBack").onclick = () => closeMapFull();
  $("mfIn").onclick = () => fullMap && fullMap.zoomIn(); $("mfOut").onclick = () => fullMap && fullMap.zoomOut();
  $("mfFollow").onclick = () => { if (!fullMap) return; fullMap.follow = !fullMap.follow; $("mfFollow").setAttribute("aria-pressed", fullMap.follow); fullMap.update(); };
  $("mfFit").onclick = () => { if (!fullMap || lapTrack.length < 2) return; fullMap.follow = false; $("mfFollow").setAttribute("aria-pressed", "false"); fullMap.fitLap(40); };
}
function openMapFull() {
  if (!$("mapFull")) buildMapFull();
  const d = $("mapFull"); if (!d.hidden) return;
  d.hidden = false; requestAnimationFrame(() => d.classList.add("open"));
  history.pushState({ mapfull: 1 }, "");
  $("mfNote").hidden = !!lastFix;
  setTimeout(fullMapShow, 120);
  $("mfBack").focus({ preventScroll: true });
}
function fullMapShow() {
  mapsReady.then(() => {
    if (!mapsAvailable()) { $("mfNote").hidden = false; $("mfNote").textContent = "Map unavailable"; return; }
    if (!fullMap) { fullMap = makeMap($("mfMap"), { theme: "dark", follow: true }); fullMap.onFollow = f => $("mfFollow").setAttribute("aria-pressed", f); }
    fullMap.resize(); fullMap.update();
  });
}
function closeMapFull(fromPop) {
  const d = $("mapFull"); if (!d || d.hidden) return;
  d.classList.remove("open"); setTimeout(() => { d.hidden = true; }, 250);
  if (!fromPop && history.state && history.state.mapfull) history.back();
}
window.openMapFull = openMapFull;
window.addEventListener("kartopen", openHud);
// build the dashboard ahead of time (idle moment, or as the fly-in starts) so opening it never stutters
window.addEventListener("kartopening", () => { if (!hudBuilt) buildHud(); });
(window.requestIdleCallback || (fn => setTimeout(fn, 1500)))(() => { if (!hudBuilt) buildHud(); });
window.openHud = openHud;

// ---------- live values ----------
let mapTick = 0;
function hudTick() {
  $("hLapNow").textContent = lapStart ? mmss(Date.now() - lapStart) : lastLapMs ? mmss(lastLapMs) : "0:00.0";
  $("hLapLbl").textContent = lapStart ? `Lap ${lapNo}` : lastLapMs ? `Lap ${lapNo} · done` : "Lap";
  $("hLapSub").textContent = lapStart ? "Tap to stop" : lastLapMs ? `Best ${mmss(best)}` : "Tap flag to start";
  const fb = $("hLapBtn"), run = !!lapStart;
  if (fb.classList.contains("running") !== run) {                        // flag to start, square to stop
    fb.classList.toggle("running", run); fb.setAttribute("aria-label", run ? "Stop lap" : "Start lap");
    fb.innerHTML = run ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>';
  }
  const c = $("chip"); $("hStatus").dataset.s = c.dataset.s; $("hStatusT").textContent = $("chipText").textContent;
}
let hudLit = -1, hudSweep = false;
// opening the dashboard: panels power on one after another and the tachometer sweeps to the redline and back, like a cluster at ignition
function hudPowerOn() {
  const h = $("hud"); if (!h || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // like the preview video: telltales blink (0-0.9 s), outlines draw in (0.55-1.2 s), panels light (from 1.0 s),
  // then the tachometer fills to the redline and settles while the speed counts up (from 1.2 s)
  h.classList.remove("poweron"); void h.offsetWidth; h.classList.add("poweron"); setTimeout(() => h.classList.remove("poweron"), 2500);
  if (typeof sfx !== "undefined") sfx.startup();                    // the start-up hum (Settings > Sounds)
  const leds = $("hLeds").querySelectorAll(".led"), n = leds.length, up = 480, hold = 110, down = 420, kmh = $("hKmh");
  hudSweep = true; leds.forEach(el => el.classList.remove("on")); kmh.textContent = "0";
  setTimeout(() => {
    const t0 = performance.now(), target = last && fin(last.kmh) ? Math.round(spd(last.kmh)) : 0;
    const step = t => {
      const e = t - t0, k = e < up ? e / up : e < up + hold ? 1 : Math.max(0, 1 - (e - up - hold) / down), lit = Math.round(n * (1 - Math.pow(1 - k, 2)));
      leds.forEach((el, i) => el.classList.toggle("on", i < lit));
      kmh.textContent = Math.round(target * Math.min(1, e / (up + hold)));
      if (e < up + hold + down) requestAnimationFrame(step); else { hudSweep = false; hudLit = -1; if (last) hudRender(last); }
    };
    requestAnimationFrame(step);
  }, 1200);
}
function hudRender(s) {
  const h = $("hud"); if (!h || h.hidden) return;
  // voltage + charge
  $("hV").textContent = fmt(s.v, 1);
  const vf = fin(s.v) ? Math.max(0, Math.min(1, (s.v - V_MIN) / (V_MAX - V_MIN))) : 0, on = Math.round(vf * SEGS);
  $("hSegs").querySelectorAll("i").forEach((el, i) => { el.className = i < on ? (i < 3 ? "on low" : i < 6 ? "on mid" : "on") : ""; });
  $("hSoc").textContent = `SoC ${fmt(s.soc, 0)}%`; const rd = spd(rangeKm); $("hRange").textContent = `Range ~${fin(rd) ? fmt(rd, rd < 10 ? 1 : 0) : "--"} ${distUnit()}`;
  // speed + rpm
  if (!hudSweep) $("hKmh").textContent = fmt(spd(s.kmh), 0);
  const su = h.querySelector("[data-unit=speed]"); if (su.textContent !== spdUnit()) su.textContent = spdUnit();
  $("hRpm").textContent = `${fin(s.rpm) ? Math.round(s.rpm).toLocaleString("en-US") : "--"} rpm`;
  const lit = Math.round(LEDS * Math.max(0, Math.min(1, Math.abs(s.rpm || 0) / RPM_MAX)));
  if (!hudSweep && lit !== hudLit) { hudLit = lit; $("hLeds").querySelectorAll(".led").forEach((el, i) => el.classList.toggle("on", i < lit)); }
  $("hMode").textContent = fin(s.mode) && MODES[s.mode] ? MODES[s.mode] : "Mode --";
  // current: needle plus drive (orange) or regen (green) arc from zero
  const a = fin(s.i) ? Math.max(AMP_MIN, Math.min(AMP_MAX, s.i)) : 0, span = AMP_MAX - AMP_MIN, zf = -AMP_MIN / span;
  $("hA").textContent = fmt(s.i, 0);
  $("hNeedle").style.transform = `rotate(${(-135 + 270 * (a - AMP_MIN) / span).toFixed(1)}deg)`;
  $("hAmpArc").style.strokeDashoffset = 100 - (a > 0 ? 100 * a / AMP_MAX : 0);
  $("hRegArc").style.strokeDashoffset = 100 - (a < 0 ? 100 * a / AMP_MIN : 0);
  // power
  const kw = fin(s.kw) ? Math.max(KW_MIN, Math.min(KW_MAX, s.kw)) : 0, z = -KW_MIN / (KW_MAX - KW_MIN) * 100, w = Math.abs(kw) / (KW_MAX - KW_MIN) * 100;
  $("hKw").textContent = fmt(s.kw, 1);
  const kb = $("hKwBar"); kb.style.left = (kw >= 0 ? z : z - w) + "%"; kb.style.width = w + "%"; kb.style.background = kw < 0 ? "var(--h-ok)" : "var(--h-acc)";
  // temperatures
  for (const [k, , max] of TEMPS) {
    if (!$("hT_" + k)) continue;
    $("hTv_" + k).textContent = fin(s[k]) ? `${fmt(s[k], 0)}°C` : "--";
    $("hT_" + k).style.strokeDashoffset = 100 - 100 * (fin(s[k]) ? Math.max(0, Math.min(1, (s[k] - 20) / (max - 20))) : 0);
    const sv = sev(k, s[k]), st = $("hTs_" + k); st.dataset.sev = sv; st.textContent = sevWord(k, sv);
  }
  // pedals
  $("hThr").style.width = fin(s.thr) ? Math.max(0, Math.min(100, s.thr)) + "%" : "0"; $("hThrT").textContent = fin(s.thr) ? fmt(s.thr, 0) + "%" : "--";
  const rg = fin(s.i) && s.i < 0 ? Math.min(1, -s.i / 40) : 0; $("hRegen").style.width = rg * 100 + "%"; $("hRegT").textContent = fin(s.i) && s.i < 0 ? fmt(-s.i, 0) + " A" : "0 A";
  // panel edges follow part state; faults on top
  const zs = p => (zoneState[p] && zoneState[p].sev) || "";
  h.querySelector(".h-volt").dataset.sev = zs("battery"); h.querySelector(".h-power").dataset.sev = zs("battery");
  h.querySelector(".h-amps").dataset.sev = zs("inverter"); h.querySelector(".h-rpm").dataset.sev = zs("motor");
  h.querySelector(".h-temps").dataset.sev = [zs("motor"), zs("battery")].includes("crit") ? "crit" : [zs("motor"), zs("battery")].includes("warn") ? "warn" : "";
  const al = $("alert"), ha = $("hAlert");
  ha.hidden = !(al.dataset.sev === "warn" || al.dataset.sev === "crit"); ha.dataset.sev = al.dataset.sev;
  $("hAlertT").textContent = `${$("alertTag").textContent}: ${$("alertText").textContent}`;
  // map, twice a second
  $("hMapNote").hidden = !!lastFix;
}
window.hudRender = hudRender;
// called on every sample: heading arrow every time, maps twice a second
window.mapsTick = () => {
  updateHeading();
  const a = $("mmArrow"); if (a) a.style.transform = `rotate(${heading.toFixed(0)}deg)`;
  const n = $("mmNote"); if (n) n.hidden = !!lastFix;
  if (++mapTick % 2) return;
  if (miniMap && !$("view-drive").hidden) miniMap.update();
  if (hudMap && $("hud") && !$("hud").hidden) hudMap.update();
  if (lapsMap && !$("view-laps").hidden) lapsMap.update();
  if (fullMap && !$("mapFull").hidden) { fullMap.update(); $("mfNote").hidden = !!lastFix; }
};
if (document.body.dataset.tab === "drive") miniMapShow();

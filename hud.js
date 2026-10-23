// hud.js : the full-screen dashboard from the team's reference image (opened by tapping the kart), plus the live maps.
// Uses app.html's globals: $, fmt, fin, last, track, lapStart, lapNo, best, lastLapMs, markLap, openPart, openId, zoneState,
// LIMITS, TEMPS, FAULT_TEXT, MC_FAULT, CRIT_MASK, MODES, RPM_MAX, RPM_RED, KW_MIN, KW_MAX, V_MIN, V_MAX.
// Maps: Leaflet with OpenStreetMap tiles (free, no key; the dark look is a CSS filter). Tiles need internet; the service worker keeps
// the ones you have seen. OSM asks for light use and visible attribution: fine for a team app, not for a public site with many users.
"use strict";

// ---------- maps ----------
const MAP_HOME = [34.0698, 72.6444];                       // GIKI, Topi: shown until the kart has a GPS fix
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
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

function makeMap(el, { theme = "dark", follow = true } = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, zoomSnap: 0.5, minZoom: 3, maxZoom: 20 }).setView(MAP_HOME, 17);
  map.attributionControl.setPrefix(false);
  const tiles = L.tileLayer(TILE_URL, { maxZoom: 20, maxNativeZoom: 19, attribution: TILE_ATTR, className: theme === "dark" ? "tiles-dark" : "" }).addTo(map);
  const line = L.polyline([], { color: "#ff8a1f", weight: 3.5, opacity: .95, className: "trackline", interactive: false }).addTo(map);
  const start = L.circleMarker(MAP_HOME, { radius: 5, color: "#fff", weight: 2, fillColor: "#2fbf4a", fillOpacity: 1, interactive: false });
  const kart = L.marker(MAP_HOME, { icon: L.divIcon({ className: "kartmk", html: KART_ICON, iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false, keyboard: false });
  const m = { map, follow, fitted: false, setTheme(t) { tiles.getContainer().classList.toggle("tiles-dark", t === "dark"); } };
  map.on("dragstart", () => { m.follow = false; m.onFollow && m.onFollow(false); });
  m.update = () => {
    if (!track.length) { if (map.hasLayer(kart)) { kart.remove(); start.remove(); line.setLatLngs([]); } return; }
    const p = track[track.length - 1];
    line.setLatLngs(track); start.setLatLng(track[0]); kart.setLatLng(p);
    if (!map.hasLayer(kart)) { kart.addTo(map); start.addTo(map); }
    const rot = kart.getElement() && kart.getElement().querySelector(".rot"); if (rot) rot.setAttribute("transform", `rotate(${heading.toFixed(0)})`);
    if (m.follow) map.panTo(p, { animate: true, duration: 0.4 });
    else if (!m.fitted && track.length > 5) { map.fitBounds(line.getBounds(), { padding: [24, 24], maxZoom: 18 }); m.fitted = true; }
  };
  return m;
}

// Laps tab: whole-session map, follows the theme
let lapsMap = null;
const pageTheme = () => matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
function lapsMapShow() {
  const el = $("lapMap"); if (!el || typeof L === "undefined") return;
  if (!lapsMap) { lapsMap = makeMap(el, { theme: pageTheme(), follow: false }); matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => lapsMap.setTheme(pageTheme())); }
  setTimeout(() => { lapsMap.map.invalidateSize(); lapsMap.fitted = false; lapsMap.update(); }, 0);
}
window.lapsMapShow = lapsMapShow;

// ---------- dashboard markup ----------
const ARC = (cx, cy, r, a0, a1) => {                          // SVG arc from angle a0 to a1 (degrees, maths convention), clockwise
  const p = a => [cx + r * Math.cos(a * Math.PI / 180), cy - r * Math.sin(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1), large = Math.abs(a0 - a1) > 180 ? 1 : 0, sweep = a0 > a1 ? 1 : 0;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
};
function rpmSvg() {
  const cx = 150, cy = 130, r = 118, A = f => 210 - 240 * f, red = RPM_RED / RPM_MAX;
  let ticks = "";
  for (let k = 0; k <= RPM_MAX / 500; k++) {
    const f = k * 500 / RPM_MAX, a = A(f) * Math.PI / 180, major = k % 2 === 0, r0 = r - 12, r1 = r - (major ? 26 : 19);
    ticks += `<line class="tick${major ? "" : " minor"}" x1="${(cx + r0 * Math.cos(a)).toFixed(1)}" y1="${(cy - r0 * Math.sin(a)).toFixed(1)}" x2="${(cx + r1 * Math.cos(a)).toFixed(1)}" y2="${(cy - r1 * Math.sin(a)).toFixed(1)}"/>`;
    if (major) ticks += `<text x="${(cx + (r - 40) * Math.cos(a)).toFixed(1)}" y="${(cy - (r - 40) * Math.sin(a)).toFixed(1)}">${k / 2}</text>`;
  }
  return `<svg class="rpmg" viewBox="0 0 300 195" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="trk" d="${ARC(cx, cy, r, A(0), A(1))}"/><path class="red" d="${ARC(cx, cy, r, A(red), A(1))}"/>
    <path class="val" id="hRpmArc" d="${ARC(cx, cy, r, A(0), A(1))}" pathLength="100"/>${ticks}
    <text class="unit" x="150" y="188">RPM ×1000</text></svg>`;
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
  <div class="hud-grid">
    <button class="hp h-volt cut-br" type="button" data-part="battery" aria-label="Battery details"><div class="in">
      <div class="vscale"><span>${V_MAX}</span><span>${Math.round((V_MAX + V_MIN) / 2)}</span><span>${V_MIN}</span></div>
      <div class="vsegs" id="hSegs">${"<i></i>".repeat(SEGS)}</div>
      <div class="txt"><div class="hl">Battery voltage</div><div class="hv"><span id="hV">--</span><small>V</small></div><div class="hs" id="hSoc">SoC --</div><div class="hs" id="hRange">Range --</div></div></div></button>
    <button class="hp h-rpm cut-b" type="button" data-part="motor" aria-label="Motor details"><div class="in">${rpmSvg()}
      <div class="spdc"><span class="big" id="hKmh">--</span><span class="u">km/h</span><span class="hs" id="hRpm">-- rpm</span></div>
      <span class="mode-chip" id="hMode">Mode --</span></div></button>
    <button class="hp h-amps cut-bl" type="button" data-part="inverter" aria-label="Pack current, inverter details"><div class="in">${ampSvg()}
      <span class="hl top">Current</span><div class="ampc"><div class="hv"><span id="hA">--</span><small>A</small></div></div></div></button>
    <button class="hp h-power cut-r" type="button" data-part="battery" aria-label="Power, battery details"><div class="in">
      <div class="hv"><span id="hKw">--</span><small>kW</small></div>
      <div class="hbar"><i id="hKwBar"></i><b id="hKwZero"></b></div><div class="hl">Power</div></div></button>
    <div class="hp h-map cut-t"><div class="in"><div id="hMap" role="application" aria-label="Live track map"></div>
      <div class="mapui tl"><div class="north" aria-hidden="true"><svg width="14" height="16" viewBox="0 0 14 16"><path d="M7 0 L13 15 L7 11 L1 15Z" fill="#ff8a1f"/></svg>N</div></div>
      <div class="mapui br">
        <button class="mbtn" type="button" id="hZoomIn" aria-label="Zoom in">+</button>
        <button class="mbtn" type="button" id="hZoomOut" aria-label="Zoom out">−</button>
        <button class="mbtn" type="button" id="hFollow" aria-pressed="true" aria-label="Follow the kart"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button>
        <button class="mbtn" type="button" id="hFit" aria-label="Show the whole track"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      </div>
      <div class="mapnote" id="hMapNote">Waiting for GPS fix</div></div></div>
    <div class="hp h-temps cut-l"><div class="in">
      <button class="tg" type="button" data-part="motor" aria-label="Motor temperature, details">${tempSvg("tMot")}<span class="hl">Motor temp</span><span class="st" id="hTs_tMot"></span></button>
      <button class="tg" type="button" data-part="battery" aria-label="Battery temperature, details">${tempSvg("tBatt")}<span class="hl">Battery temp</span><span class="st" id="hTs_tBatt"></span></button></div></div>
    <div class="hp h-lap cut-tr"><div class="in">
      <div class="txt"><div class="hl" id="hLapLbl">Lap</div><div class="hv" id="hLapNow">0:00.0</div><div class="hs" id="hLapSub">Tap the flag at the start line</div></div>
      <button class="flagbtn" type="button" id="hLapBtn" aria-label="Mark lap"><svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg></button></div></div>
    <div class="hp h-pedals cut-tl"><div class="in">
      <div class="ped"><span class="hl">Throttle</span><div class="hbar"><i id="hThr"></i></div><span class="r" id="hThrT">--</span></div>
      <div class="ped" title="No brake sensor yet: regenerative braking current is shown"><span class="hl">Regen</span><div class="hbar"><i id="hRegen"></i></div><span class="r" id="hRegT">--</span></div>
      </div></div>
  </div>
  <button class="hud-close" type="button" id="hudClose" aria-label="Close dashboard"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  <div class="hud-alert" id="hAlert" role="status" hidden><span id="hAlertT"></span></div>
  <div class="hud-status" id="hStatus" data-s="idle"><span class="dot"></span><span id="hStatusT"></span></div>
</section>`;
}

// ---------- open / close ----------
let hudMap = null, hudBuilt = false, hudTimer = null, wentFull = false;
function buildHud() {
  document.body.insertAdjacentHTML("beforeend", hudMarkup()); hudBuilt = true;
  $("hud").addEventListener("click", e => { const b = e.target.closest("[data-part]"); if (b) openPart(b.dataset.part); });
  $("hudClose").onclick = () => closeHud();
  $("hLapBtn").onclick = () => markLap();
  $("hZoomIn").onclick = () => hudMap && hudMap.map.zoomIn(); $("hZoomOut").onclick = () => hudMap && hudMap.map.zoomOut();
  $("hFollow").onclick = () => { if (!hudMap) return; hudMap.follow = !hudMap.follow; $("hFollow").setAttribute("aria-pressed", hudMap.follow); hudMap.update(); };
  $("hFit").onclick = () => { if (!hudMap || track.length < 2) return; hudMap.follow = false; $("hFollow").setAttribute("aria-pressed", "false"); hudMap.map.fitBounds(L.latLngBounds(track), { padding: [30, 30], maxZoom: 18 }); };
  $("hKwZero").style.left = (-KW_MIN / (KW_MAX - KW_MIN) * 100) + "%";
}
function openHud() {
  if (!hudBuilt) buildHud();
  const h = $("hud"); if (!h.hidden) return;
  h.hidden = false; requestAnimationFrame(() => h.classList.add("open"));
  document.documentElement.style.overflow = "hidden";
  history.pushState({ hud: 1 }, "");
  // phones: go full screen and turn sideways when the browser allows it (Chrome on Android does, iPhone browsers do not)
  if (matchMedia("(pointer: coarse)").matches && document.fullscreenEnabled && !document.fullscreenElement) {
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(() => { wentFull = true; return screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape"); }).catch(() => {});
  }
  if (typeof L !== "undefined") {
    if (!hudMap) { hudMap = makeMap($("hMap"), { theme: "dark", follow: true }); hudMap.onFollow = f => $("hFollow").setAttribute("aria-pressed", f); }
    setTimeout(() => { hudMap.map.invalidateSize(); hudMap.update(); }, 60);
  } else $("hMapNote").textContent = "Map unavailable";
  if (last) hudRender(last);
  clearInterval(hudTimer); hudTimer = setInterval(hudTick, 100);
  $("hudClose").focus({ preventScroll: true });
}
function closeHud(fromPop) {
  const h = $("hud"); if (!h || h.hidden) return;
  h.classList.remove("open"); setTimeout(() => { h.hidden = true; }, 250);
  document.documentElement.style.overflow = "";
  clearInterval(hudTimer);
  if (wentFull && document.fullscreenElement) { try { screen.orientation.unlock(); } catch (e) {} document.exitFullscreen().catch(() => {}); }
  wentFull = false;
  if (window.kart3d && kart3d.home) kart3d.home();                              // camera back out of the driver's seat
  if (!fromPop && history.state && history.state.hud) history.back();
}
window.addEventListener("popstate", () => closeHud(true));
document.addEventListener("keydown", e => { if (e.key === "Escape" && !openId) closeHud(); });
window.addEventListener("kartopen", openHud);
window.openHud = openHud;

// ---------- live values ----------
let mapTick = 0;
function hudTick() {
  if (lapStart) $("hLapNow").textContent = mmss(Date.now() - lapStart);
  $("hLapLbl").textContent = lapStart ? `Lap ${lapNo}` : "Lap";
  $("hLapSub").textContent = !lapStart ? "Tap flag at start line" : lapNo > 1 ? `Last ${mmss(lastLapMs)} · Best ${mmss(best)}` : "Timing first lap";
  const c = $("chip"); $("hStatus").dataset.s = c.dataset.s; $("hStatusT").textContent = $("chipText").textContent;
}
function hudRender(s) {
  const h = $("hud"); if (!h || h.hidden) return;
  // voltage + charge
  $("hV").textContent = fmt(s.v, 1);
  const vf = fin(s.v) ? Math.max(0, Math.min(1, (s.v - V_MIN) / (V_MAX - V_MIN))) : 0, on = Math.round(vf * SEGS);
  $("hSegs").querySelectorAll("i").forEach((el, i) => { el.className = i < on ? (i < 3 ? "on low" : i < 6 ? "on mid" : "on") : ""; });
  $("hSoc").textContent = `SoC ${fmt(s.soc, 0)}%`; $("hRange").textContent = `Range ~${$("range").textContent} km`;
  // speed + rpm
  $("hKmh").textContent = fmt(s.kmh, 0);
  $("hRpm").textContent = `${fin(s.rpm) ? Math.round(s.rpm).toLocaleString("en-US") : "--"} rpm`;
  $("hRpmArc").style.strokeDashoffset = 100 - 100 * Math.max(0, Math.min(1, Math.abs(s.rpm || 0) / RPM_MAX));
  $("hMode").textContent = fin(s.mode) ? `${MODES[s.mode]} mode` : "Mode --";
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
  $("hMapNote").hidden = !!track.length;
  if (++mapTick % 2 === 0) { updateHeading(); if (hudMap) hudMap.update(); if (lapsMap && !$("view-laps").hidden) lapsMap.update(); }
}
window.hudRender = hudRender;
window.mapsTick = () => { updateHeading(); if (lapsMap && !$("view-laps").hidden) lapsMap.update(); };

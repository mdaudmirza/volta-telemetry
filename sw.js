// Caches the app so it opens at the track with no internet (Bluetooth mode needs no internet).
// Map tiles are kept as you view them (up to TILE_MAX), so a track you have opened once still shows offline.
const CACHE = "crosskart-v18", TILES = "crosskart-tiles-v1", TILE_MAX = 3000;
const FILES = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png", "parco-logo.png", "parco-nose.png", "kart3d.js", "hud.js", "hud.css", "model/volta.glb",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "vendor/three/three.module.min.js", "vendor/three/addons/loaders/GLTFLoader.js", "vendor/three/addons/utils/BufferGeometryUtils.js",
  "vendor/three/addons/libs/meshopt_decoder.module.js", "vendor/three/addons/environments/RoomEnvironment.js", "vendor/three/addons/controls/OrbitControls.js",
  "vendor/three/addons/postprocessing/EffectComposer.js", "vendor/three/addons/postprocessing/RenderPass.js", "vendor/three/addons/postprocessing/OutputPass.js",
  "vendor/three/addons/postprocessing/GTAOPass.js", "vendor/three/addons/postprocessing/Pass.js", "vendor/three/addons/postprocessing/ShaderPass.js",
  "vendor/three/addons/postprocessing/MaskPass.js", "vendor/three/addons/shaders/CopyShader.js", "vendor/three/addons/shaders/GTAOShader.js",
  "vendor/three/addons/shaders/PoissonDenoiseShader.js", "vendor/three/addons/shaders/OutputShader.js", "vendor/three/addons/math/SimplexNoise.js"];
const FONTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim())));
const cacheFirst = (req, name, trim) => caches.open(name).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
  if (res.ok || res.type === "opaque") { c.put(req, res.clone()); if (trim) c.keys().then(k => { if (k.length > TILE_MAX) for (const old of k.slice(0, k.length - TILE_MAX)) c.delete(old); }); }
  return res;
})));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (FONTS.includes(u.hostname)) return e.respondWith(cacheFirst(e.request, CACHE));
  if (u.hostname === "tile.openstreetmap.org") return e.respondWith(cacheFirst(e.request, TILES, true));
  if (u.origin !== location.origin) return;                                      // Firebase stream goes straight to the network
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});

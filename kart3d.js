// kart3d.js : the 3D VOLTA kart on the Drive stage.
// model/volta.glb is the team website's model split into its CAD parts by ../model-build.mjs, one mesh per material
// (body, frame, rim, tyre, caliper, seat, metal), already straightened and scaled to the frame below.
// It is painted like the real kart (matte charcoal, gunmetal tubes, red calipers, PARCO decals) and tints part zones by live state.
// Tap the kart: the camera flies to the driver's seat, zooms into the dash screen and fires "kartopen" (the dashboard opens).
// Press and hold for half a second: the kart splits into labelled compartments (wheels, battery, driver seat, motor controller, motor,
// headlights, rear lights); tapping one fires "kartpart" with its part name; hold again to put it back together.
// If WebGL or the model fails, the SVG top view stays. API used by app.html: window.kart3d.update(state), .select(part), .explode(on).
import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/three/addons/libs/meshopt_decoder.module.js";
import { toCreasedNormals } from "./vendor/three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "./vendor/three/addons/environments/RoomEnvironment.js";
import { OrbitControls } from "./vendor/three/addons/controls/OrbitControls.js";

// ---- model frame: x = side, y = rear (nose at y = -1.5), z = up, ground at z = -0.487 ----
// Wheels at x = +-0.645, y = -0.87 (front) / +1.08 (rear), radius ~0.25; brake discs just inside at x = +-0.685.
const GROUND = -0.487;

// Part zones as boxes [xmin, ymin, zmin, xmax, ymax, zmax] on |x| (mirrored left/right). The model has no battery,
// inverter or motor of its own, so these sit where the team's layout puts them: move them if the packaging differs.
// The battery pack, motor and motor controller are drawn here (makePack, makeMotor, makeController), since the website model has none.
// T shape seen from above: the crossbar runs across the car just behind the seat backs (BAR); the stem runs forward under the seats
// and out past their front edge (STEM). The seats span y = -0.02 (front) to 0.60 (backs).
const PACK = { z0: -0.44, z1: -0.29, BAR: { w: 0.68, y0: 0.62, y1: 0.82 }, STEM: { w: 0.22, y0: -0.42, y1: 0.62 } };
const ZONES = {
  brakes:     [[0.62, -1.01, -0.38, 0.74, -0.72, -0.10], [0.62, 0.94, -0.38, 0.74, 1.23, -0.10]],
  tyres:      [[0.48, -1.12, -0.50, 0.80, -0.61, 0.05], [0.48, 0.82, -0.50, 0.80, 1.33, 0.05]],
  headlights: [[0.00, -1.52, -0.32, 0.32, -1.18, 0.05]],
  rearlights: [[0.00, 1.20, -0.45, 0.50, 1.33, 0.15]],
  motor:      [[0.00, 0.87, -0.37, 0.15, 1.13, -0.11]],
  inverter:   [[0.00, 0.51, -0.13, 0.18, 0.75, 0.01]],
  battery:    [[0.00, 0.61, -0.45, 0.35, 0.83, -0.26], [0.00, -0.43, -0.45, 0.12, 0.62, -0.26]],   // T pack: crossbar behind the seat backs + stem under and past the seats
  driver:     [[0.00, -0.04, -0.30, 0.46, 0.62, 0.40]],
};
const VIEWS = { all: [0.95, -1.0, 0.55], battery: [0.9, -0.9, 1.0], motor: [0.7, 1.3, 0.75], inverter: [0.9, 1.0, 1.0],
  brakes: [1.25, -0.55, 0.15], tyres: [1.2, -0.8, 0.3], headlights: [0.3, -1.3, 0.3], rearlights: [0.45, 1.35, 0.45], driver: [0.4, -0.5, 1.2] };

// ---- compartments: every triangle is sorted into one by where it sits; each moves out along its own offset when the kart splits ----
const WHEELS = [[1, -0.866, "FR"], [-1, -0.866, "FL"], [1, 1.085, "RR"], [-1, 1.085, "RL"]];
function compOf(x, y, z, cls) {
  if (cls === "seat") return "driver";
  for (const [sx, wy, id] of WHEELS) if (Math.sign(x) === sx && Math.abs(x) > 0.45 && Math.hypot(y - wy, z + 0.235) < 0.34) return "wheel" + id;
  const ax = Math.abs(x);
  if (y < -1.18 && ax < 0.32) return "headlights";
  if (y > 1.2 && z < 0.15 && ax < 0.5) return "rearlights";
  return "chassis";
}
// split offsets: wheels well out to the sides, nose forward, tail back, and the inner parts lifted to different heights so nothing overlaps
const COMPS = {
  wheelFR: { part: "tyres", off: [0.46, -0.18, 0] }, wheelFL: { part: "tyres", off: [-0.46, -0.18, 0] },
  wheelRR: { part: "tyres", off: [0.46, 0.18, 0] }, wheelRL: { part: "tyres", off: [-0.46, 0.18, 0] },
  battery: { part: "battery", off: [0, -0.68, 0.26] },
  headlights: { part: "headlights", off: [0, -0.52, 0.04] }, rearlights: { part: "rearlights", off: [0, 0.62, 0.04] },
  driver: { part: "driver", off: [0, 0.02, 0.55] }, controller: { part: "inverter", off: [0, 0.16, 0.88] },
  motor: { part: "motor", off: [0, 0.62, 0.34] }, chassis: { part: null, off: [0, 0, 0] },
};
// one label per part, pinned to one compartment; while split they sit in two columns with a line to their part
const LABELS = [["driver", "Driver", "driver"], ["battery", "Battery", "battery"], ["inverter", "Controller", "controller"], ["motor", "Motor", "motor"],
  ["tyres", "Tyres", "wheelFR"], ["brakes", "Brakes", "wheelRR"], ["headlights", "Headlights", "headlights"], ["rearlights", "Rear lights", "rearlights"]];
const COL = { cool: new THREE.Color(0x5ac8fa), ok: new THREE.Color(0x30d158), warn: new THREE.Color(0xffd60a), crit: new THREE.Color(0xff3b30), sel: new THREE.Color(0xff8a1f) };
const MAXB = 12;

const host = document.getElementById("stage3d");
const wrap = host && host.closest(".kartwrap");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
function webglOk() { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; } }

// PARCO decals drawn once into canvases (team colours: green word, orange A, orange pinstripe), projected onto the body in the shader
function decal(w, h, draw) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
function word(g, x, y, size, white) {
  g.font = `800 ${size}px Inter, "Segoe UI", Roboto, Arial, sans-serif`; g.textBaseline = "middle";
  const parts = [["P", 0], ["A", 1], ["RCO", 0]]; let tw = 0; for (const [s] of parts) tw += g.measureText(s).width;
  let cx = x - tw / 2; for (const [s, o] of parts) { g.fillStyle = o ? "#ff8a1f" : white ? "#f2f2f2" : "#2fbf4a"; g.fillText(s, cx, y); cx += g.measureText(s).width; }
}
const sideTex = () => decal(1024, 380, (g, w, h) => {
  g.clearRect(0, 0, w, h); g.strokeStyle = "#ff8a1f"; g.lineWidth = 7; g.beginPath();
  g.moveTo(30, h - 30); g.lineTo(w - 90, h - 30); g.quadraticCurveTo(w - 30, h - 30, w - 30, h - 90); g.lineTo(w - 30, 40); g.stroke();
  word(g, w * 0.47, h * 0.52, 190);
});
const fenderTex = () => decal(512, 160, (g, w, h) => { g.clearRect(0, 0, w, h); word(g, w / 2, h / 2, 120); });
const wingTex = () => decal(1024, 256, (g, w, h) => { g.clearRect(0, 0, w, h); word(g, w / 2, h / 2, 170, true); });

function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture; pmrem.dispose();
  scene.environmentIntensity = 0.6;
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.6, -2.2, 3.4); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 8 }); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.01;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb070, 0.9); rim.position.set(-2.5, 2.5, 1.6); scene.add(rim);    // warm back light, PARCO orange
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5); fill.position.set(-2, -2, 1); scene.add(fill);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
  controls.minPolarAngle = 0.15; controls.maxPolarAngle = 1.5;
  controls.target.set(0, 0.05, -0.2);
  controls.addEventListener("change", () => need = true);

  // ground: real shadow from the key light, plus a soft contact blur under the kart
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.38 }));
  ground.position.z = GROUND; ground.receiveShadow = true; scene.add(ground);
  const sc = document.createElement("canvas"); sc.width = sc.height = 128;
  const sg = sc.getContext("2d"), grd = sg.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, "rgba(0,0,0,.6)"); grd.addColorStop(.6, "rgba(0,0,0,.22)"); grd.addColorStop(1, "rgba(0,0,0,0)"); sg.fillStyle = grd; sg.fillRect(0, 0, 128, 128);
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 3.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  contact.position.z = GROUND + 0.002; scene.add(contact);

  // headlamps: two glows and faint beams, shown when the lamp setting is On
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0, depthWrite: false });
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const lamps = new THREE.Group();
  for (const sx of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), glowMat); g.position.set(0.13 * sx, -1.36, -0.15); lamps.add(g);
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.0, 24, 1, true), beamMat); b.rotation.x = -0.08; b.position.set(0.13 * sx, -1.86, -0.19); lamps.add(b);
  }

  // ---- materials (colours from the kart photo) ----
  const M = {
    body:    new THREE.MeshPhysicalMaterial({ color: 0x24272b, metalness: 0.3, roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.4 }),
    frame:   new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.85, roughness: 0.32 }),
    rim:     new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.9, roughness: 0.28 }),
    tyre:    new THREE.MeshStandardMaterial({ color: 0x141416, metalness: 0.0, roughness: 0.92 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xc8161d, metalness: 0.2, roughness: 0.38 }),
    seat:    new THREE.MeshStandardMaterial({ color: 0x18181a, metalness: 0.0, roughness: 0.85 }),
    metal:   new THREE.MeshStandardMaterial({ color: 0x8b8f95, metalness: 1.0, roughness: 0.35 }),
    pack:    new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.7, roughness: 0.34 }),
  };
  // while split, the chassis (frame and body panels) keeps its colours but turns see-through, so the compartments stand out
  const seeThrough = new Map();
  const ghostOf = mat => {
    if (!seeThrough.has(mat)) { const c = mat.clone(); Object.assign(c, { transparent: true, opacity: 0.32, depthWrite: false });
      c.onBeforeCompile = mat.onBeforeCompile; seeThrough.set(mat, c); }
    return seeThrough.get(mat);
  };
  for (const m of Object.values(M)) m.side = THREE.DoubleSide;

  // zone uniforms, shared by every material
  const boxes = [];
  for (const p of Object.keys(ZONES)) for (const b of ZONES[p]) boxes.push([p, new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5])]);
  const far = new THREE.Vector3(9, 9, 9);
  const U = {
    uZMin: { value: boxes.map(b => b[1]).concat(Array(MAXB - boxes.length).fill(far)) },
    uZMax: { value: boxes.map(b => b[2]).concat(Array(MAXB - boxes.length).fill(far)) },
    uZCol: { value: Array.from({ length: MAXB }, () => new THREE.Color(0, 0, 0)) },
    uZStr: { value: new Array(MAXB).fill(0) },
    uSide: { value: sideTex() }, uWing: { value: wingTex() }, uFender: { value: fenderTex() },
  };
  for (const [name, mat] of Object.entries(M)) mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vKPos; varying vec3 vKNor;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKPos = position; vKNor = normal;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vKPos; varying vec3 vKNor;
uniform vec3 uZMin[${MAXB}]; uniform vec3 uZMax[${MAXB}]; uniform vec3 uZCol[${MAXB}]; uniform float uZStr[${MAXB}];
uniform sampler2D uSide; uniform sampler2D uWing; uniform sampler2D uFender;
float kIn(vec3 p, vec3 a, vec3 b) { vec3 d = max(a - p, p - b); return 1.0 - smoothstep(0.0, 0.035, max(max(d.x, d.y), d.z)); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 kp = vec3(abs(vKPos.x), vKPos.yz); vec3 kn = normalize(vKNor);
${name === "body" ? `
// sidepod decal: outer faces, projected along x; mirrored so it reads correctly on both sides
if (abs(kn.x) > 0.55 && kp.x > 0.5 && kp.y > 0.14 && kp.y < 0.78 && kp.z > -0.33 && kp.z < -0.11) {
  vec2 uv = vec2((vKPos.y - 0.14) / 0.64, (vKPos.z + 0.33) / 0.22); if (vKPos.x < 0.0) uv.x = 1.0 - uv.x;
  vec4 d = texture2D(uSide, uv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a); }
// rear wing decal: upper faces, projected along z, reads from the front
if (kn.z > 0.6 && kp.x < 0.5 && vKPos.y > 0.86 && vKPos.y < 1.2 && vKPos.z > 0.2) {
  vec2 uv = vec2((vKPos.x + 0.5) / 1.0, (vKPos.y - 0.86) / 0.34);
  vec4 d = texture2D(uWing, uv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a * 0.95); }
// mudguard logos: upper faces above each wheel, text running along the mudguard (front to back)
if (kn.z > 0.45 && kp.x > 0.53 && kp.x < 0.79 && vKPos.z > -0.15) {
  float wy = vKPos.y < 0.1 ? -0.866 : 1.085;
  vec2 uv = vec2((wy + 0.15 - vKPos.y) / 0.30, (kp.x - 0.55) / 0.22);
  if (vKPos.x < 0.0) uv = vec2(1.0 - uv.x, uv.y);
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) { vec4 d = texture2D(uFender, uv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a); } }` : ""}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
for (int i = 0; i < ${MAXB}; i++) totalEmissiveRadiance += uZCol[i] * uZStr[i] * kIn(kp, uZMin[i], uZMax[i]);`);
  };

  let kart = null, need = true, state = null, selected = null, pulse = false, tween = null;
  let split = 0, splitTo = 0, ghosted = false, flight = null;                              // 0 = assembled, 1 = split into compartments
  const comps = {};                                                         // compartment name -> THREE.Group
  for (const [c, { off }] of Object.entries(COMPS)) { comps[c] = new THREE.Group(); comps[c].userData.off = new THREE.Vector3(...off); }
  comps.headlights.add(lamps);
  function addPart(g, cls, mat) {                                           // sort a non-indexed geometry's triangles into compartments
    const P = g.attributes.position.array, N = g.attributes.normal.array, n = P.length / 9, which = new Array(n), count = {};
    for (let t = 0; t < n; t++) {
      const i = t * 9, c = compOf((P[i] + P[i + 3] + P[i + 6]) / 3, (P[i + 1] + P[i + 4] + P[i + 7]) / 3, (P[i + 2] + P[i + 5] + P[i + 8]) / 3, cls);
      which[t] = c; count[c] = (count[c] || 0) + 1;
    }
    for (const c of Object.keys(count)) {
      const p = new Float32Array(count[c] * 9), q = new Float32Array(count[c] * 9); let k = 0;
      for (let t = 0; t < n; t++) if (which[t] === c) { p.set(P.subarray(t * 9, t * 9 + 9), k); q.set(N.subarray(t * 9, t * 9 + 9), k); k += 9; }
      const sub = new THREE.BufferGeometry(); sub.setAttribute("position", new THREE.BufferAttribute(p, 3)); sub.setAttribute("normal", new THREE.BufferAttribute(q, 3));
      const m = new THREE.Mesh(sub, mat); m.castShadow = true; m.receiveShadow = cls !== "tyre"; m.userData.mat = mat;
      m.userData.part = cls === "caliper" ? "brakes" : COMPS[c].part; comps[c].add(m);
    }
  }
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.load("model/volta.glb", gltf => {
    kart = new THREE.Group(); gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      const name = (o.material && o.material.name) || o.name, mat = M[name] || M.body;
      // positions arrive quantized (int16) with a node transform: copy to float, bake the transform, then crease normals
      const pa = o.geometry.getAttribute("position"), f = new Float32Array(pa.count * 3);
      for (let i = 0; i < pa.count; i++) { f[i * 3] = pa.getX(i); f[i * 3 + 1] = pa.getY(i); f[i * 3 + 2] = pa.getZ(i); }
      let g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(f, 3)); g.setIndex(o.geometry.getIndex());
      g.applyMatrix4(o.matrixWorld); g = toCreasedNormals(g, name === "tyre" || name === "rim" ? 0.9 : 0.6);
      addPart(g, name, mat);
    });
    // brake discs (not in the model file): plain metal discs inside each wheel
    const disc = new THREE.CylinderGeometry(0.135, 0.135, 0.022, 48); disc.rotateZ(Math.PI / 2);
    const discMat = new THREE.MeshStandardMaterial({ color: 0x9a9da2, metalness: 1, roughness: 0.42 });
    for (const [sx, y, id] of WHEELS) { const d = new THREE.Mesh(disc, discMat); d.position.set(0.685 * sx, y, -0.245); d.userData.part = "brakes"; comps["wheel" + id].add(d); }
    comps.battery.add(makePack()); comps.motor.add(makeMotor()); comps.controller.add(makeController()); comps.chassis.add(makeDash());
    for (const g of Object.values(comps)) { g.userData.centre = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()); kart.add(g); }
    scene.add(kart);
    wrap.classList.add("has3d");
    view("all", true); applyState(); need = true;
  }, undefined, err => { console.warn("3D kart unavailable, keeping the top view:", err); renderer.domElement.remove(); });

  // battery pack: a casing with module ridges, an orange HV band and a label on the lid (geometry baked in place so zone tints line up)
  function makePack() {
    const g = new THREE.Group(), { z0, z1, BAR, STEM } = PACK;
    const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; m.userData.part = "battery"; g.add(m); return m; };
    const band = new THREE.MeshStandardMaterial({ color: 0xff8a1f, metalness: 0.3, roughness: 0.45 });
    for (const { w, y0, y1 } of [BAR, STEM]) {
      const ln = y1 - y0, yc = (y0 + y1) / 2;
      add(new THREE.BoxGeometry(w, ln, z1 - z0).translate(0, yc, (z0 + z1) / 2), M.pack);
      add(new THREE.BoxGeometry(w + 0.024, ln + 0.024, 0.016).translate(0, yc, z1 - 0.012), band);   // orange rim: the T reads from above
    }
    for (let i = 0; i < 10; i++) add(new THREE.BoxGeometry(STEM.w - 0.05, 0.08, 0.012).translate(0, STEM.y0 + 0.06 + i * 0.1, z1 + 0.006), M.pack);
    const yc = (BAR.y0 + BAR.y1) / 2;
    const tex = decal(512, 256, (c, W, H) => {
      c.fillStyle = "rgba(20,22,25,.92)"; c.beginPath(); c.roundRect(6, 6, W - 12, H - 12, 22); c.fill();
      c.strokeStyle = "#ff8a1f"; c.lineWidth = 6; c.stroke();
      c.fillStyle = "#ffd60a"; c.beginPath(); c.moveTo(70, 60); c.lineTo(120, 150); c.lineTo(20, 150); c.closePath(); c.fill();
      c.fillStyle = "#111"; c.font = "800 64px Inter, Arial, sans-serif"; c.textAlign = "center"; c.fillText("!", 70, 140);
      c.textAlign = "left"; c.fillStyle = "#fff"; c.font = "800 66px Inter, Arial, sans-serif"; c.fillText("HV 336 V", 145, 112);
      c.fillStyle = "#a3a7ae"; c.font = "600 38px Inter, Arial, sans-serif"; c.fillText("LiFePO4 battery", 145, 168);
    });
    const lid = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.16), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    lid.position.set(0, yc, z1 + 0.003); lid.userData.part = "battery"; g.add(lid);
    return g;
  }

  // driver's dash screen in front of the right-hand seat (PARCO car colours: charcoal, orange, green); the tap transition flies into it
  const EYE = new THREE.Vector3(0.2, 0.2, 0.42), DASH = new THREE.Vector3(0.2, -0.42, 0.205);   // screen sits on top of the dash panel
  function makeDash() {
    const tex = decal(512, 256, (c, W, H) => {
      c.fillStyle = "#121417"; c.fillRect(0, 0, W, H); c.strokeStyle = "#ff8a1f"; c.lineWidth = 6; c.strokeRect(8, 8, W - 16, H - 16);
      c.lineWidth = 14; c.strokeStyle = "#24272b"; c.beginPath(); c.arc(W / 2, 170, 110, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
      c.strokeStyle = "#ff8a1f"; c.beginPath(); c.arc(W / 2, 170, 110, Math.PI * 1.1, Math.PI * 1.55); c.stroke();
      c.fillStyle = "#ffffff"; c.font = "800 60px Inter, Arial, sans-serif"; c.textAlign = "center"; c.fillText("VOLTA", W / 2, 190);
      c.fillStyle = "#2fbf4a"; c.font = "600 22px Inter, Arial, sans-serif"; c.fillText("DRIVER DISPLAY", W / 2, 225);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    m.position.copy(DASH); m.rotation.set(-1.25, 0, Math.PI);                  // faces the driver (+y), tilted back, upright
    return m;
  }

  // motor: a PMSM can across the rear, with lighter end caps and an orange HV lead
  function makeMotor() {
    const g = new THREE.Group(), tag = m => { m.castShadow = true; m.userData.part = "motor"; g.add(m); return m; };
    const can = new THREE.CylinderGeometry(0.12, 0.12, 0.24, 40); can.rotateZ(Math.PI / 2); can.translate(0, 1.0, -0.24); tag(new THREE.Mesh(can, M.pack));
    for (const sx of [-1, 1]) { const cap = new THREE.CylinderGeometry(0.1, 0.1, 0.03, 40); cap.rotateZ(Math.PI / 2); cap.translate(0.135 * sx, 1.0, -0.24); tag(new THREE.Mesh(cap, M.metal)); }
    for (let i = 0; i < 6; i++) { const fin = new THREE.TorusGeometry(0.121, 0.006, 6, 40); fin.rotateY(Math.PI / 2); fin.translate(-0.09 + i * 0.036, 1.0, -0.24); tag(new THREE.Mesh(fin, M.metal)); }
    const lead = new THREE.CylinderGeometry(0.014, 0.014, 0.16, 12); lead.translate(0, 0.9, -0.12); lead.rotateX(0.5);
    tag(new THREE.Mesh(lead, new THREE.MeshStandardMaterial({ color: 0xff8a1f, roughness: 0.5 })));
    return g;
  }
  // motor controller: a finned box behind the seats with a small label
  function makeController() {
    const g = new THREE.Group(), tag = m => { m.castShadow = true; m.userData.part = "inverter"; g.add(m); return m; };
    tag(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.07).translate(0, 0.63, -0.08), M.pack));
    for (let i = 0; i < 7; i++) tag(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.2, 0.04).translate(-0.12 + i * 0.04, 0.63, -0.025), M.metal));
    const tex = decal(256, 96, (c, W, H) => { c.fillStyle = "rgba(20,22,25,.95)"; c.beginPath(); c.roundRect(4, 4, W - 8, H - 8, 14); c.fill();
      c.strokeStyle = "#ff8a1f"; c.lineWidth = 4; c.stroke(); c.fillStyle = "#fff"; c.font = "800 34px Inter, Arial, sans-serif"; c.textAlign = "center"; c.fillText("INVERTER", W / 2, 46);
      c.fillStyle = "#a3a7ae"; c.font = "600 22px Inter, Arial, sans-serif"; c.fillText("STM32 · 3-phase", W / 2, 76); });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.06), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    plate.rotation.x = Math.PI / 2; plate.position.set(0, 0.519, -0.08); plate.userData.part = "inverter"; g.add(plate);
    return g;
  }

  // The speed readout sits on top of the stage and the part buttons at the bottom; the kart is framed in the band between them.
  let band = 1;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    const hr = host.getBoundingClientRect(), sp = document.querySelector(".stage .speedo"), ft = document.querySelector(".stage .stagefoot");
    // split: the speedo hides, so the kart gets the stage below the Done button
    const top = splitTo ? 52 : sp ? sp.getBoundingClientRect().top + sp.offsetHeight * 0.78 - hr.top : 0, bot = ft ? ft.getBoundingClientRect().top - hr.top : h;
    const bh = Math.max(bot - top, h * 0.45); band = bh / h;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.setViewOffset(w, h, 0, -((top + bh / 2) - h / 2), w, h);
    camera.updateProjectionMatrix(); fit(); if (!tween && kart) view(selected || "all", true); need = true;
  }
  function dist() {
    const r = 1.62, t = Math.tan(camera.fov * Math.PI / 360), vf = Math.atan(t * band), hf = Math.atan(t * camera.aspect);
    return r / Math.sin(Math.min(vf, hf)) * 0.9;
  }
  function fit() { const d = dist(); controls.minDistance = d * 0.55; controls.maxDistance = d * 1.35; }
  const HOME = new THREE.Vector3(0, 0.05, -0.2), PART_COMP = Object.fromEntries(LABELS.map(([p, , c]) => [p, c]));
  function view(name, now) {
    const c = splitTo && name !== "all" && comps[PART_COMP[name]];
    const tgt = c ? c.userData.centre.clone().add(c.userData.off) : HOME.clone();     // split: look at where the part has moved to
    const dir = new THREE.Vector3(...(VIEWS[name] || VIEWS.all)).normalize(), d = dist() * (name === "all" ? (splitTo ? 1.36 : 1) : splitTo ? 0.62 : 0.9);
    const to = dir.multiplyScalar(d).add(tgt);
    if (now || reduceMotion) { camera.position.copy(to); controls.target.copy(tgt); controls.update(); need = true; return; }
    tween = { from: camera.position.clone(), to, tFrom: controls.target.clone(), tTo: tgt, t0: performance.now(), dur: 650 };
  }
  new ResizeObserver(resize).observe(host); resize();

  // ---- live state -> zone colours ----
  const tempCol = f => f < 0.5 ? COL.cool.clone().lerp(COL.ok, f / 0.5) : f < 0.8 ? COL.ok.clone().lerp(COL.warn, (f - 0.5) / 0.3) : COL.warn.clone().lerp(COL.crit, Math.min(1, (f - 0.8) / 0.2));
  function applyState(t = 0) {
    if (!kart) return;
    pulse = false;
    boxes.forEach(([p], i) => {
      const z = state && state[p] || {}, sel = selected === p;
      let col = COL.sel, str = 0;
      if (z.sev === "crit") { col = COL.crit; str = reduceMotion ? 1.1 : 0.7 + 0.5 * Math.sin(t / 160); pulse = true; }
      else if (z.sev === "warn") { col = COL.warn; str = 0.7; }
      else if (Number.isFinite(z.temp) && z.temp > 0.5) { col = tempCol(Math.min(1, z.temp)); str = 0.12 + 0.5 * (Math.min(1, z.temp) - 0.5); }   // only warm parts glow
      if (sel) { if (!str) col = COL.sel; str = Math.max(str, 0.5) + 0.2; }
      U.uZCol.value[i].copy(col); U.uZStr.value[i] = str;
    });
    const on = state && state.lamp === 1, auto = state && state.lamp === 0;
    glowMat.opacity = on ? 1 : auto ? 0.35 : 0.08; beamMat.opacity = on ? 0.05 : 0;
    need = true;
  }

  // ---- render loop: only draws when something changed, a fault is pulsing, or the camera is moving ----
  let lastPulse = 0;
  renderer.setAnimationLoop(t => {
    if (tween) { const k = Math.min(1, (t - tween.t0) / tween.dur), e = 1 - Math.pow(1 - k, 3); camera.position.lerpVectors(tween.from, tween.to, e); controls.target.lerpVectors(tween.tFrom, tween.tTo, e); if (k >= 1) tween = null; need = true; }
    if (flight) flyStep(t); else if (controls.update()) need = true;
    if (split !== splitTo) {
      split = reduceMotion ? splitTo : splitTo ? Math.min(1, split + 0.06) : Math.max(0, split - 0.08);
      const e = split * split * (3 - 2 * split);
      for (const g of Object.values(comps)) g.position.copy(g.userData.off).multiplyScalar(e);
      const ghost = split > 0.02;
      if (ghost !== ghosted) { ghosted = ghost; for (const m of comps.chassis.children) if (m.isMesh && m.userData.mat) { m.material = ghost ? ghostOf(m.userData.mat) : m.userData.mat; m.castShadow = !ghost; } }
      need = true;
    }
    if (pulse && t - lastPulse > 50) { lastPulse = t; applyState(t); }
    if (!need || document.hidden || !host.offsetParent) return;
    need = false; renderer.render(scene, camera); placeLabels();
  });

  // ---- labels and the Done button (HTML over the canvas) ----
  const labelBox = document.createElement("div"); labelBox.className = "klabels"; labelBox.setAttribute("aria-label", "Kart parts"); wrap.appendChild(labelBox);
  const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg"); lines.setAttribute("class", "klines"); lines.setAttribute("aria-hidden", "true"); labelBox.appendChild(lines);
  const labelEls = LABELS.map(([part, text, comp]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "klabel"; b.dataset.part = part; b.dataset.sev = "none";
    b.innerHTML = `<span class="dot"></span>${text}`; b.tabIndex = -1; labelBox.appendChild(b); return { b, comp };
  });
  labelBox.addEventListener("click", e => { const b = e.target.closest(".klabel"); if (b) window.dispatchEvent(new CustomEvent("kartpart", { detail: b.dataset.part })); });
  // long-press is invisible to screen readers and keyboards, so a small close button stays as the accessible way back
  const done = document.createElement("button"); done.type = "button"; done.className = "kdone"; done.hidden = true;
  done.setAttribute("aria-label", "Put the kart back together"); done.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  done.onclick = () => explode(false); wrap.appendChild(done);
  const ring = document.createElement("div"); ring.className = "khold"; ring.hidden = true; wrap.appendChild(ring);   // fills while you hold
  const v = new THREE.Vector3();
  function placeLabels() {
    labelBox.style.opacity = split;                                       // the layer never blocks drags; only the chips take taps (CSS)
    if (!split) return;
    const w = host.clientWidth, h = host.clientHeight, hr = host.getBoundingClientRect(), ft = document.querySelector(".stage .stagefoot");
    const top = 60, bot = (ft ? ft.getBoundingClientRect().top - hr.top : h) - 20, gap = 36, pad = 10;
    // anchor of each part on screen
    const items = labelEls.map(L => { const g = comps[L.comp]; v.copy(g.userData.centre).add(g.position).project(camera);
      return { ...L, ax: (v.x + 1) / 2 * w, ay: (1 - v.y) / 2 * h, ok: v.z < 1 }; })
      .filter(i => i.ok && (!selected || i.b.dataset.part === selected));     // a part is open: only its label stays
    // left half of the anchors (by x) goes to the left column, the rest to the right; each column keeps the parts' top-to-bottom order
    items.sort((a, b) => a.ax - b.ax);
    const cols = [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))];
    let svg = "";
    cols.forEach((col, side) => {
      col.sort((a, b) => a.ay - b.ay);
      let y = top; for (const it of col) { it.y = Math.max(it.ay, y); y = it.y + gap; }
      let lim = bot; for (let j = col.length - 1; j >= 0; j--) { col[j].y = Math.max(top, Math.min(col[j].y, lim)); lim = col[j].y - gap; }
      for (const it of col) {
        const bw = it.b.offsetWidth, cx = side ? w - pad - bw / 2 : pad + bw / 2, ex = side ? w - pad - bw : pad + bw;
        it.b.style.transform = `translate(${cx.toFixed(0)}px, ${it.y.toFixed(0)}px) translate(-50%, -50%)`; it.b.style.visibility = "visible";
        svg += `<path d="M${ex.toFixed(0)} ${it.y.toFixed(0)} L${(side ? ex - 14 : ex + 14).toFixed(0)} ${it.y.toFixed(0)} L${it.ax.toFixed(0)} ${it.ay.toFixed(0)}"/><circle cx="${it.ax.toFixed(0)}" cy="${it.ay.toFixed(0)}" r="3.5"/>`;
        if (state && state[it.b.dataset.part]) it.b.dataset.sev = state[it.b.dataset.part].sev || "none";
      }
    });
    const shown = new Set(items.map(i => i.b)); for (const L of labelEls) if (!shown.has(L.b)) L.b.style.visibility = "hidden";
    lines.innerHTML = svg;
  }
  function explode(on) {
    splitTo = on ? 1 : 0; done.hidden = !on; wrap.classList.toggle("split", on);
    for (const { b } of labelEls) b.tabIndex = on ? 0 : -1;
    if (!on) selected = null;
    resize(); view(selected || "all"); applyState(performance.now());
    try { localStorage.setItem("kartSplitSeen", "1"); } catch (e) {}
    const hint = document.getElementById("kHint"); if (hint) hint.hidden = true;
  }

  // ---- taps (not drags) ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null, holdTimer = 0;
  const HOLD_MS = 500;
  function hitsAt(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(kart, true).filter(h => h.object.visible && h.object.isMesh && h.object.material !== glowMat && h.object.material !== beamMat);
  }
  const cancelHold = () => { clearTimeout(holdTimer); ring.hidden = true; };
  renderer.domElement.addEventListener("contextmenu", e => e.preventDefault());   // no long-press menu on phones
  renderer.domElement.addEventListener("pointerdown", e => {
    if (!kart || flight) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), held: false };
    if (!hitsAt(e).length) return;                                          // hold only counts on the kart itself
    const r = wrap.getBoundingClientRect(); ring.style.left = e.clientX - r.left + "px"; ring.style.top = e.clientY - r.top + "px";
    ring.hidden = false; ring.classList.remove("go"); void ring.offsetWidth; ring.classList.add("go");
    holdTimer = setTimeout(() => { if (!down) return; down.held = true; ring.hidden = true; if (navigator.vibrate) navigator.vibrate(15); explode(!splitTo); }, HOLD_MS);
  });
  renderer.domElement.addEventListener("pointermove", e => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) cancelHold(); });
  renderer.domElement.addEventListener("pointercancel", () => { cancelHold(); down = null; });
  renderer.domElement.addEventListener("pointerup", e => {
    cancelHold();
    if (!down || !kart || flight) return; const d = down; down = null;
    if (d.held || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > HOLD_MS) return;
    const hits = hitsAt(e);
    if (!splitTo) { if (hits.length) driverView(); return; }
    const hit = hits.find(h => h.object.userData.part);                   // the see-through chassis never blocks a part behind it
    if (hit) window.dispatchEvent(new CustomEvent("kartpart", { detail: hit.object.userData.part }));
  });

  // ---- tap transition: fly to the driver's eye, then into the dash screen, then open the dashboard (about 0.7 s) ----
  function driverView() {
    if (reduceMotion) { window.dispatchEvent(new CustomEvent("kartopen")); return; }
    tween = null;
    const into = DASH.clone().add(new THREE.Vector3(0, 0.06, 0.075));       // just above and in front of the screen, clear of the wheel hub
    flight = { t0: performance.now(), legs: [
      { from: camera.position.clone(), to: EYE.clone(), via: EYE.clone().add(new THREE.Vector3(0, 0.35, 0.75)), tFrom: controls.target.clone(), tTo: DASH.clone(), dur: 380 },   // arcs down into the open cockpit
      { from: EYE.clone(), to: into, tFrom: DASH.clone(), tTo: DASH.clone(), dur: 300 } ], opened: false };
    wrap.classList.add("flying");
  }
  function flyStep(t) {
    let el = t - flight.t0, leg = flight.legs[0];
    if (el > leg.dur) { el -= leg.dur; leg = flight.legs[1]; }
    const k = Math.min(1, el / leg.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // ease in-out
    if (leg.via) camera.position.copy(leg.from).multiplyScalar((1 - e) * (1 - e)).addScaledVector(leg.via, 2 * (1 - e) * e).addScaledVector(leg.to, e * e);
    else camera.position.lerpVectors(leg.from, leg.to, e);
    controls.target.lerpVectors(leg.tFrom, leg.tTo, e); camera.lookAt(controls.target);
    need = true;
    if (leg === flight.legs[1] && k > 0.55 && !flight.opened) { flight.opened = true; window.dispatchEvent(new CustomEvent("kartopen")); }
    if (leg === flight.legs[1] && k >= 1) { flight = null; wrap.classList.remove("flying"); }
  }
  function home() {                                                         // back to the normal view (after the dashboard closes)
    flight = null; wrap.classList.remove("flying"); view(selected || "all", true);
  }

  window.kart3d = {
    update(s) { state = s; applyState(performance.now()); },
    select(part) { selected = part || null; view(part || "all"); applyState(performance.now()); },
    explode, home,
    redraw() { resize(); },
  };
  if (window.kartState) window.kart3d.update(window.kartState);
}

if (host && webglOk() && lsGet("kart3d") !== "off") start();

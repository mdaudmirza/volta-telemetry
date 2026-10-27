// kart3d.js : the 3D VOLTA kart that fills the Drive screen.
// model/volta.glb is the team website's model split into its CAD parts by ../model-build.mjs,
// one mesh per material (body, frame, rim, tyre, caliper, seat, metal), straightened and scaled to the frame below, with the
// steering wheel moved to the right-hand seat. The kart is painted like the real one (matte charcoal, gunmetal tubes, red calipers,
// PARCO decals) and tints part zones by live state.
// Tap the kart: one smooth camera move into the driver's seat and onto the dash screen, then "kartopen" (the dashboard opens).
// Press and hold half a second: the camera glides to the default angle, then the kart splits into compartments; hold again to glide
// back and reassemble. Tapping a compartment fires "kartpart" with its part name.
// Graphics quality (localStorage "gfx"): auto | high | balanced | smooth | off. Auto starts at High on capable devices and steps down
// if frames get slow. Off (or no WebGL) keeps the flat SVG top view.
// The car is framed inside #carSafe, the part of the screen the overlay gauges leave free.
// API used by app.html: window.kart3d.update(state), .select(part), .explode(on), .home(), .quality.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/three/addons/libs/meshopt_decoder.module.js";
import { toCreasedNormals } from "./vendor/three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "./vendor/three/addons/environments/RoomEnvironment.js";
import { RGBELoader } from "./vendor/three/addons/loaders/RGBELoader.js";
import { OrbitControls } from "./vendor/three/addons/controls/OrbitControls.js";
import { EffectComposer } from "./vendor/three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "./vendor/three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "./vendor/three/addons/postprocessing/OutputPass.js";

// ---- model frame: x = side (+x is the driver's LEFT), y = rear (nose at y = -1.5), z = up, ground at z = -0.487 ----
// Wheels at x = +-0.645, y = -0.87 (front) / +1.08 (rear), radius ~0.25. Seats span y = -0.02 (front) to 0.60 (backs), at x = +-0.2.
const GROUND = -0.487;

// ---- graphics levels ----
const LEVELS = {
  high:     { model: "model/volta.glb",    dpr: 2,   shadow: 2048, ao: false, msaa: 0, physical: true },
  balanced: { model: "model/volta.glb",    dpr: 1.5, shadow: 1024, ao: false, msaa: 0, physical: true },
  smooth:   { model: "model/volta.glb",    dpr: 1,   shadow: 0,    ao: false, msaa: 0, physical: false },
};
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const pref = lsGet("gfx") || (lsGet("kart3d") === "off" ? "off" : "auto");
// Paint (Settings): "app" = the app's studio look, "blender" = the look of the Blender renders. Changing it reloads the app.
const blenderLook = lsGet("paint") === "blender";
const capable = (navigator.deviceMemory || 8) >= 6 && (navigator.hardwareConcurrency || 8) >= 6;
const startLevel = pref === "auto" ? (capable ? "high" : "balanced") : pref;

// ---- parts the website model does not have, drawn here where the team's layout puts them ----
// Battery T (team drawing): the crossbar stands upright right behind the seat backs, almost the full width; the stem runs forward,
// low, between the two seats and out past their front edge.
const PACK = { BAR: { w: 0.6, y0: 0.64, y1: 0.78, z0: -0.44, z1: -0.14 }, STEM: { w: 0.1, y0: -0.5, y1: 0.64, z0: -0.44, z1: -0.24 } };   // drawn smaller than the real pack so it sits in proportion
// Motor controller: on the rear face of the battery crossbar. Motor: across the rear. Cooling: radiator and fan above the motor at the very back.
const CTRL = { y: 0.815, z: -0.2 }, MOTOR = { y: 1.0, z: -0.24 }, RAD = { y: 1.15, z: 0.0 };

// Part zones as boxes [xmin, ymin, zmin, xmax, ymax, zmax] on |x| (mirrored left/right), used for state tints and highlights
const ZONES = {
  brakes:     [[0.62, -1.01, -0.38, 0.74, -0.72, -0.10], [0.62, 0.94, -0.38, 0.74, 1.23, -0.10]],
  tyres:      [[0.48, -1.12, -0.50, 0.80, -0.61, 0.05], [0.48, 0.82, -0.50, 0.80, 1.33, 0.05]],
  headlights: [[0.00, -1.52, -0.32, 0.32, -1.18, 0.05]],
  rearlights: [[0.00, 1.25, -0.45, 0.50, 1.33, 0.15]],
  motor:      [[0.00, 0.87, -0.37, 0.15, 1.13, -0.11]],
  inverter:   [[0.00, 0.785, -0.32, 0.18, 0.88, -0.08]],
  battery:    [[0.00, 0.61, -0.45, 0.41, 0.81, 0.05], [0.00, -0.56, -0.45, 0.08, 0.62, -0.15]],
  cooling:    [[0.00, 1.09, -0.14, 0.23, 1.24, 0.14]],
  driver:     [[0.00, -0.04, -0.30, 0.46, 0.62, 0.40]],
};
const VIEWS = { all: [0.8, -1.1, 0.5], battery: [0.9, -0.9, 1.0], motor: [0.7, 1.3, 0.75], inverter: [0.6, 1.3, 0.9], cooling: [0.7, 1.4, 0.9],
  brakes: [1.25, -0.55, 0.15], tyres: [1.2, -0.8, 0.3], headlights: [0.3, -1.3, 0.3], rearlights: [0.45, 1.35, 0.45], driver: [-0.4, -0.5, 1.2] };

// ---- compartments: every model triangle is sorted into one by where it sits; each moves out along its own offset when the kart splits ----
const WHEELS = [[1, -0.866, "FR"], [-1, -0.866, "FL"], [1, 1.085, "RR"], [-1, 1.085, "RL"]];
function compOf(x, y, z, cls) {
  if (cls === "seat") return "driver";
  for (const [sx, wy, id] of WHEELS) if (Math.sign(x) === sx && Math.abs(x) > 0.45 && Math.hypot(y - wy, z + 0.235) < 0.34) return "wheel" + id;
  const ax = Math.abs(x);
  if (y < -1.18 && ax < 0.32) return "headlights";
  if (y > 1.25 && z < 0.15 && ax < 0.5) return "rearlights";
  return "chassis";
}
// split offsets: wheels out to the sides, nose forward, tail back, inner parts lifted to different heights so nothing overlaps
const COMPS = {
  wheelFR: { part: "tyres", off: [0.46, -0.18, 0] }, wheelFL: { part: "tyres", off: [-0.46, -0.18, 0] },
  wheelRR: { part: "tyres", off: [0.46, 0.18, 0] }, wheelRL: { part: "tyres", off: [-0.46, 0.18, 0] },
  battery: { part: "battery", off: [0, -0.2, 0.55] },
  headlights: { part: "headlights", off: [0, -0.52, 0.04] }, rearlights: { part: "rearlights", off: [0, 0.72, 0.02] },
  driver: { part: "driver", off: [0, -0.35, 0.3] }, controller: { part: "inverter", off: [0, 0.22, 0.75] },
  motor: { part: "motor", off: [0, 0.5, 0.18] }, cooling: { part: "cooling", off: [0, 0.55, 0.62] },
  chassis: { part: null, off: [0, 0, 0] },
};
// labels only on parts you cannot tell by looking; the rest stay tappable without a label
const LABELS = [["battery", "Battery", "battery"], ["inverter", "Motor controller", "controller"], ["motor", "Motor", "motor"], ["cooling", "Cooling", "cooling"]];
const PART_COMP = { battery: "battery", inverter: "controller", motor: "motor", cooling: "cooling", driver: "driver", headlights: "headlights",
  rearlights: "rearlights", tyres: "wheelFR", brakes: "wheelFR" };
const COL = { cool: new THREE.Color(0x5ac8fa), ok: new THREE.Color(0x30d158), warn: new THREE.Color(0xffd60a), crit: new THREE.Color(0xff3b30), sel: new THREE.Color(0xff8a1f) };
const MAXB = 14;

const host = document.getElementById("stage3d");
const wrap = host && host.closest(".kartwrap");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
function webglOk() { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; } }
const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;

// PARCO decals drawn once into canvases (team colours: green word, orange A, orange pinstripe), projected onto the body in the shader
function decal(w, h, draw) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
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

function start(levelName) {
  let L = LEVELS[levelName];
  const renderer = new THREE.WebGLRenderer({ antialias: !L.ao, alpha: true, powerPreference: "high-performance" });
  let dpr = Math.min(window.devicePixelRatio || 1, L.dpr);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (blenderLook) { renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0; }   // Blender paint: the renders' view transform (Khronos PBR Neutral)
  else { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15; }
  renderer.shadowMap.enabled = !!L.shadow; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();                                        // transparent: the stage behind is the backdrop
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environmentIntensity = 0.6;
  // Blender paint: the studio light the Blender renders use (Poly Haven studio_small_01, CC0); the room above stays if it fails to load
  if (blenderLook) new RGBELoader().load("env/studio.hdr", t => {
    t.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(t).texture; t.dispose(); pmrem.dispose();
    scene.environmentRotation.set(Math.PI / 2, 0, 0); scene.environmentIntensity = 1.0; need = true;   // the image is y-up, the kart frame z-up
  }, undefined, () => pmrem.dispose());
  else pmrem.dispose();
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.6, -2.2, 3.4);
  if (L.shadow) { key.castShadow = true; key.shadow.mapSize.set(L.shadow, L.shadow);
    Object.assign(key.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 0.5, far: 9 }); key.shadow.bias = -0.0003; key.shadow.normalBias = 0.012; key.shadow.radius = 3; }
  scene.add(key);
  // back light: app paint keeps the warm PARCO-orange one; Blender paint a soft near-white one (the warm one turns the charcoal copper)
  const rim = blenderLook ? new THREE.DirectionalLight(0xfff0e0, 0.45) : new THREE.DirectionalLight(0xffb070, 0.9); rim.position.set(-2.5, 2.5, 1.6); scene.add(rim);
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5); fill.position.set(-2, -2, 1); scene.add(fill);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.03, 60);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
  controls.minPolarAngle = 0.15; controls.maxPolarAngle = 1.5;
  controls.target.set(0, 0.05, -0.2);
  controls.addEventListener("change", () => need = true);

  // floor: real shadow from the key light, plus a soft contact blur under the kart
  if (L.shadow) { const ground = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.38 }));
    ground.position.z = GROUND; ground.receiveShadow = true; scene.add(ground); }
  const sc = document.createElement("canvas"); sc.width = sc.height = 128;
  const sg = sc.getContext("2d"), grd = sg.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, "rgba(0,0,0,.6)"); grd.addColorStop(.6, "rgba(0,0,0,.22)"); grd.addColorStop(1, "rgba(0,0,0,0)"); sg.fillStyle = grd; sg.fillRect(0, 0, 128, 128);
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 3.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  contact.position.z = GROUND + 0.002; scene.add(contact);

  // High: anti-aliased render target + ground-truth ambient occlusion (soft contact shading where parts meet)
  let composer = null, aoPass = null;
  function setupComposer() {
    if (!L.ao) { composer = null; return; }
    const rt = new THREE.WebGLRenderTarget(1, 1, { samples: L.msaa, type: THREE.HalfFloatType });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    aoPass = new GTAOPass(scene, camera, 1, 1);
    aoPass.updateGtaoMaterial({ radius: 0.18, distanceExponent: 1.5, thickness: 1.2, scale: 1.1, samples: 16 });
    aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    aoPass.blendIntensity = 0.85;
    composer.addPass(aoPass); composer.addPass(new OutputPass());
  }
  setupComposer();

  // headlamps: the lamps themselves glow (no beams); brighter with a soft halo when the lamp setting is On
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0, depthWrite: false });
  const haloMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const lamps = new THREE.Group();
  for (const sx of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), glowMat); g.position.set(0.13 * sx, -1.36, -0.15); lamps.add(g);
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), haloMat); h.position.copy(g.position); lamps.add(h);
  }

  // ---- materials (colours from the kart photo) ----
  const Body = L.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const M = {
    body:    new Body({ color: 0x24272b, metalness: 0.3, roughness: 0.48, ...(L.physical ? { clearcoat: 0.45, clearcoatRoughness: 0.35 } : {}) }),
    frame:   new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.85, roughness: 0.3 }),
    rim:     new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.92, roughness: 0.25 }),
    tyre:    new THREE.MeshStandardMaterial({ color: 0x141416, metalness: 0.0, roughness: 0.92 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xc8161d, metalness: 0.2, roughness: 0.35 }),
    seat:    new THREE.MeshStandardMaterial({ color: 0x18181a, metalness: 0.0, roughness: 0.85 }),
    metal:   new THREE.MeshStandardMaterial({ color: 0x8b8f95, metalness: 1.0, roughness: 0.33 }),
    pack:    new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.7, roughness: 0.34 }),
    alu:     new THREE.MeshStandardMaterial({ color: 0xa9adb3, metalness: 0.9, roughness: 0.42 }),
    hose:    new THREE.MeshStandardMaterial({ color: 0x17191c, metalness: 0.1, roughness: 0.6 }),
  };
  const orange = new THREE.MeshStandardMaterial({ color: 0xff8a1f, metalness: 0.3, roughness: 0.45 });
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
    uSide: { value: sideTex() }, uWing: { value: wingTex() }, uFender: { value: fenderTex() }, uNose: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) },
  };
  for (const [name, mat] of Object.entries(M)) mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vKPos; varying vec3 vKNor;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKPos = position; vKNor = normal;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vKPos; varying vec3 vKNor;
uniform vec3 uZMin[${MAXB}]; uniform vec3 uZMax[${MAXB}]; uniform vec3 uZCol[${MAXB}]; uniform float uZStr[${MAXB}];
uniform sampler2D uSide; uniform sampler2D uWing; uniform sampler2D uFender; uniform sampler2D uNose;
float kIn(vec3 p, vec3 a, vec3 b) { vec3 d = max(a - p, p - b); return 1.0 - smoothstep(0.0, 0.035, max(max(d.x, d.y), d.z)); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 kp = vec3(abs(vKPos.x), vKPos.yz); vec3 kn = normalize(vKNor);
${name === "body" ? `
// sidepod decal: outer faces, projected along x; mirrored so it reads correctly on both sides
if (abs(kn.x) > 0.55 && kp.x > 0.5 && kp.y > 0.14 && kp.y < 0.78 && kp.z > -0.33 && kp.z < -0.11) {
  vec2 uv = vec2((vKPos.y - 0.14) / 0.64, (vKPos.z + 0.33) / 0.22); if (vKPos.x < 0.0) uv.x = 1.0 - uv.x;
  vec4 d = texture2D(uSide, uv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a); }
// spoiler decal: top of the main plane between the endplates, projected along z, reads from the front
if (kn.z > 0.6 && kp.x < 0.45 && vKPos.y > 1.185 && vKPos.y < 1.455 && vKPos.z > 0.33) {
  vec2 uv = vec2((vKPos.x + 0.45) / 0.9, (vKPos.y - 1.185) / 0.27);
  vec4 d = texture2D(uWing, uv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a * 0.95); }
// nose logo (team artwork): top of the nose cone, upright and readable for someone standing in front of the kart
// (their right is +x, "up" on the nose runs away from them towards +y)
if (kn.z > 0.5 && abs(vKPos.x) < 0.12 && vKPos.y > -1.06 && vKPos.y < -0.884 && vKPos.z > -0.05) {
  vec2 uv = vec2((vKPos.x + 0.12) / 0.24, (vKPos.y + 1.06) / 0.176);
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) { vec4 d = texture2D(uNose, uv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a); } }
// mudguard logos: upper faces above each wheel, text running along the mudguard (front to back)
if (kn.z > 0.45 && kp.x > 0.53 && kp.x < 0.79 && vKPos.z > -0.15) {
  float wy = vKPos.y < 0.1 ? -0.866 : 1.085;
  vec2 uv = vec2((wy + 0.15 - vKPos.y) / 0.30, (kp.x - 0.55) / 0.22);
  if (vKPos.x < 0.0) uv = vec2(1.0 - uv.x, uv.y);
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) { vec4 d = texture2D(uFender, uv); diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb, d.a); } }` : ""}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
for (int i = 0; i < ${MAXB}; i++) totalEmissiveRadiance += uZCol[i] * uZStr[i] * kIn(kp, uZMin[i], uZMax[i]);`);
  };
  new THREE.TextureLoader().load("parco-nose.png", t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; U.uNose.value = t; need = true; });

  let kart = null, need = true, state = null, selected = null, pulse = false, tween = null;
  let split = 0, splitTo = 0, ghosted = false, flight = null, busy = false;  // split: 0 = assembled, 1 = apart
  const comps = {};
  for (const [c, { off }] of Object.entries(COMPS)) { comps[c] = new THREE.Group(); comps[c].userData.off = new THREE.Vector3(...off); }
  comps.headlights.add(lamps);
  function addPart(g, cls, mat) {                                           // sort a non-indexed geometry's triangles into compartments
    const P = g.attributes.position.array, N = g.attributes.normal.array, C = g.attributes.color && g.attributes.color.array, n = P.length / 9, which = new Array(n), count = {};
    for (let t = 0; t < n; t++) {
      const i = t * 9, z0 = P[i + 2], z1 = P[i + 5], z2 = P[i + 8];
      // drop the flat floor pan under the seats (1.3 x 1.9 m): it reads as a black slab, worst in the split view
      if (cls === "body" && Math.max(z0, z1, z2) < -0.3 && Math.min(z0, z1, z2) > -0.35 && Math.max(z0, z1, z2) - Math.min(z0, z1, z2) < 0.006) { which[t] = null; continue; }
      const c = compOf((P[i] + P[i + 3] + P[i + 6]) / 3, (P[i + 1] + P[i + 4] + P[i + 7]) / 3, (P[i + 2] + P[i + 5] + P[i + 8]) / 3, cls);
      which[t] = c; count[c] = (count[c] || 0) + 1;
    }
    for (const c of Object.keys(count)) {
      const p = new Float32Array(count[c] * 9), q = new Float32Array(count[c] * 9), r = C && new Float32Array(count[c] * 9); let k = 0;
      for (let t = 0; t < n; t++) if (which[t] === c) { p.set(P.subarray(t * 9, t * 9 + 9), k); q.set(N.subarray(t * 9, t * 9 + 9), k); if (r) r.set(C.subarray(t * 9, t * 9 + 9), k); k += 9; }
      const sub = new THREE.BufferGeometry(); sub.setAttribute("position", new THREE.BufferAttribute(p, 3)); sub.setAttribute("normal", new THREE.BufferAttribute(q, 3));
      if (r) sub.setAttribute("color", new THREE.BufferAttribute(r, 3));
      const m = new THREE.Mesh(sub, mat); m.castShadow = !!L.shadow; m.receiveShadow = !!L.shadow && cls !== "tyre"; m.userData.mat = mat; m.userData.cls = cls;
      m.userData.part = cls === "caliper" ? "brakes" : COMPS[c].part; comps[c].add(m);
    }
  }
  const floats = a => { const f = new Float32Array(a.count * 3); for (let i = 0; i < a.count; i++) { f[i * 3] = a.getX(i); f[i * 3 + 1] = a.getY(i); f[i * 3 + 2] = a.getZ(i); } return f; };
  // soft shadows baked in Blender arrive as vertex colours (COLOR_0): each material gets a twin that multiplies them in
  const baked = new Map();
  const withAO = (mat, key) => {
    if (!baked.has(mat)) { const c = mat.clone(); c.vertexColors = true; c.onBeforeCompile = mat.onBeforeCompile; c.customProgramCacheKey = () => key + ":ao"; baked.set(mat, c); }
    return baked.get(mat);
  };
  // app paint leaves the baked shadows out
  const copyColor = (src, g) => { const c = blenderLook && src.getAttribute("color"); if (c) g.setAttribute("color", new THREE.BufferAttribute(floats(c), 3)); return !!c; };
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // battery, controller, motor and cooling come from model/parts.glb (made in Blender); if it fails to load, the simple ones below are drawn instead
  const PART_MODEL = { battery: ["battery", "battery"], inverter: ["controller", "inverter"], motor: ["motor", "motor"], cooling: ["cooling", "cooling"] };
  function addModelParts(gltf) {
    const got = new Set(); gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      let p = o; while (p && !PART_MODEL[p.name]) p = p.parent; if (!p) return;
      const [comp, part] = PART_MODEL[p.name], name = o.material && o.material.name;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(floats(o.geometry.getAttribute("position")), 3));
      const nrm = o.geometry.getAttribute("normal"); if (nrm) g.setAttribute("normal", new THREE.BufferAttribute(floats(nrm), 3));
      const ao = copyColor(o.geometry, g), base = name === "orange" ? orange : M[name] || M.pack, mat = ao ? withAO(base, name) : base;
      g.setIndex(o.geometry.getIndex()); g.applyMatrix4(o.matrixWorld); if (!nrm) g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.castShadow = !!L.shadow; m.receiveShadow = !!L.shadow; m.userData.part = part; comps[comp].add(m); got.add(comp);
    });
    return got;
  }
  Promise.all([loader.loadAsync(L.model), loader.loadAsync("model/parts.glb").catch(err => { console.warn("parts model unavailable, drawing simple parts:", err); return null; })]).then(([gltf, parts]) => {
    kart = new THREE.Group(); gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      const name = (o.material && o.material.name) || o.name;
      // positions (and normals, in the High model) arrive quantized with a node transform: copy to float and bake the transform
      let g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(floats(o.geometry.getAttribute("position")), 3));
      const nrm = o.geometry.getAttribute("normal"); if (nrm) g.setAttribute("normal", new THREE.BufferAttribute(floats(nrm), 3));
      const mat = copyColor(o.geometry, g) ? withAO(M[name] || M.body, name) : M[name] || M.body;
      g.setIndex(o.geometry.getIndex()); g.applyMatrix4(o.matrixWorld);
      g = nrm ? g.toNonIndexed() : toCreasedNormals(g, name === "tyre" || name === "rim" ? 0.9 : 0.6);   // light model: work out the normals here
      addPart(g, name, mat);
    });
    // brake discs (not in the model file): plain metal discs inside each wheel
    const disc = new THREE.CylinderGeometry(0.135, 0.135, 0.022, 48); disc.rotateZ(Math.PI / 2);
    const discMat = new THREE.MeshStandardMaterial({ color: 0x9a9da2, metalness: 1, roughness: 0.42 });
    for (const [sx, y, id] of WHEELS) { const d = new THREE.Mesh(disc, discMat); d.position.set(0.685 * sx, y, -0.245); d.userData.part = "brakes"; comps["wheel" + id].add(d); }
    const got = parts ? addModelParts(parts) : new Set();
    comps.battery.add(got.has("battery") ? packLabel() : makePack()); comps.controller.add(got.has("controller") ? ctrlPlate() : makeController());
    if (!got.has("motor")) comps.motor.add(makeMotor()); if (!got.has("cooling")) comps.cooling.add(makeCooling());
    comps.chassis.add(makeDash());
    for (const g of Object.values(comps)) { g.userData.centre = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()); kart.add(g); }
    scene.add(kart);
    wrap.classList.add("has3d");
    view("all", true); applyState(); need = true;
  }, err => { console.warn("3D kart unavailable, keeping the top view:", err); renderer.domElement.remove(); });

  const tagger = (g, part) => (m, shadow = true) => { m.castShadow = shadow && !!L.shadow; m.receiveShadow = !!L.shadow; m.userData.part = part; g.add(m); return m; };
  // battery: an upright crossbar behind the seat backs and a low stem between the seats, with an orange HV band and a label on top
  function makePack() {
    const g = new THREE.Group(), add = tagger(g, "battery");
    for (const { w, y0, y1, z0, z1 } of [PACK.BAR, PACK.STEM]) {
      const ln = y1 - y0, yc = (y0 + y1) / 2;
      add(new THREE.Mesh(new THREE.BoxGeometry(w, ln, z1 - z0).translate(0, yc, (z0 + z1) / 2), M.pack));
      add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, ln + 0.02, 0.016).translate(0, yc, z1 - 0.012), orange));   // orange rim
    }
    for (let i = 0; i < 10; i++) add(new THREE.Mesh(new THREE.BoxGeometry(PACK.STEM.w - 0.04, 0.07, 0.01).translate(0, PACK.STEM.y0 + 0.07 + i * 0.105, PACK.STEM.z1 + 0.005), M.pack));
    g.add(packLabel());
    return g;
  }
  function packLabel() {                                                    // HV label on top of the crossbar
    const B = PACK.BAR, tex = decal(512, 256, (c, W, H) => {
      c.fillStyle = "rgba(20,22,25,.92)"; c.beginPath(); c.roundRect(6, 6, W - 12, H - 12, 22); c.fill();
      c.strokeStyle = "#ff8a1f"; c.lineWidth = 6; c.stroke();
      c.fillStyle = "#ffd60a"; c.beginPath(); c.moveTo(70, 60); c.lineTo(120, 150); c.lineTo(20, 150); c.closePath(); c.fill();
      c.fillStyle = "#111"; c.font = "800 64px Inter, Arial, sans-serif"; c.textAlign = "center"; c.fillText("!", 70, 140);
      c.textAlign = "left"; c.fillStyle = "#fff"; c.font = "800 66px Inter, Arial, sans-serif"; c.fillText("HV 336 V", 145, 112);
      c.fillStyle = "#a3a7ae"; c.font = "600 38px Inter, Arial, sans-serif"; c.fillText("LiFePO4 battery", 145, 168);
    });
    const lid = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.12), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    lid.position.set(0, (B.y0 + B.y1) / 2, B.z1 + 0.002); lid.userData.part = "battery";
    return lid;
  }
  // motor: a PMSM can across the rear, with lighter end caps and an orange HV lead
  function makeMotor() {
    const g = new THREE.Group(), add = tagger(g, "motor");
    const can = new THREE.CylinderGeometry(0.12, 0.12, 0.24, 48); can.rotateZ(Math.PI / 2); can.translate(0, MOTOR.y, MOTOR.z); add(new THREE.Mesh(can, M.pack));
    for (const sx of [-1, 1]) { const cap = new THREE.CylinderGeometry(0.1, 0.1, 0.03, 48); cap.rotateZ(Math.PI / 2); cap.translate(0.135 * sx, MOTOR.y, MOTOR.z); add(new THREE.Mesh(cap, M.metal)); }
    for (let i = 0; i < 6; i++) { const fin = new THREE.TorusGeometry(0.121, 0.006, 8, 48); fin.rotateY(Math.PI / 2); fin.translate(-0.09 + i * 0.036, MOTOR.y, MOTOR.z); add(new THREE.Mesh(fin, M.metal)); }
    const lead = new THREE.CylinderGeometry(0.014, 0.014, 0.16, 12); lead.translate(0, MOTOR.y - 0.1, MOTOR.z + 0.12); lead.rotateX(0.5); add(new THREE.Mesh(lead, orange));
    return g;
  }
  // motor controller: a finned box on the rear face of the battery crossbar, with a small plate facing the back
  function makeController() {
    const g = new THREE.Group(), add = tagger(g, "inverter");
    add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.24).translate(0, CTRL.y, CTRL.z), M.pack));
    for (let i = 0; i < 8; i++) add(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.03, 0.13).translate(-0.126 + i * 0.036, CTRL.y + 0.04, CTRL.z - 0.05), M.metal));   // fins, lower rear face
    g.add(ctrlPlate());
    return g;
  }
  function ctrlPlate() {                                                    // name plate on the controller's upper rear face
    const tex = decal(256, 96, (c, W, H) => { c.fillStyle = "rgba(20,22,25,.95)"; c.beginPath(); c.roundRect(4, 4, W - 8, H - 8, 14); c.fill();
      c.strokeStyle = "#ff8a1f"; c.lineWidth = 4; c.stroke(); c.fillStyle = "#fff"; c.font = "800 34px Inter, Arial, sans-serif"; c.textAlign = "center"; c.fillText("INVERTER", W / 2, 46);
      c.fillStyle = "#a3a7ae"; c.font = "600 22px Inter, Arial, sans-serif"; c.fillText("STM32 · 3-phase", W / 2, 76); });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.06), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    plate.position.set(0, CTRL.y + 0.026, CTRL.z + 0.07); plate.up.set(0, 0, 1); plate.lookAt(0, CTRL.y + 1, CTRL.z + 0.07);   // upper rear face, upright
    plate.userData.part = "inverter";
    return plate;
  }
  // active cooling: radiator with an electric fan on its rear face, header tanks, a pump and hoses to the motor and the controller
  function makeCooling() {
    const g = new THREE.Group(), add = tagger(g, "cooling");
    const tilt = new THREE.Matrix4().makeRotationX(-0.25), at = (geo, x, y, z) => geo.applyMatrix4(tilt).translate(x, y, z);
    const finTex = decal(256, 128, (c, W, H) => { c.fillStyle = "#8d9197"; c.fillRect(0, 0, W, H); c.strokeStyle = "#5e6268"; c.lineWidth = 2;
      for (let x = 0; x < W; x += 6) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); } });
    finTex.colorSpace = THREE.SRGBColorSpace;
    const core = new THREE.MeshStandardMaterial({ map: finTex, metalness: 0.8, roughness: 0.5 });
    add(new THREE.Mesh(at(new THREE.BoxGeometry(0.4, 0.04, 0.2), 0, RAD.y, RAD.z), core));
    for (const dz of [-0.115, 0.115]) add(new THREE.Mesh(at(new THREE.BoxGeometry(0.42, 0.05, 0.03).translate(0, 0, dz), 0, RAD.y, RAD.z), M.alu));   // header tanks
    // fan: shroud ring, seven blades, hub
    const fan = new THREE.Group();
    fan.add(new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.008, 10, 48), M.hose));
    for (let i = 0; i < 7; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.004, 0.022), M.hose); b.position.set(Math.cos(i / 7 * 6.283) * 0.042, 0, Math.sin(i / 7 * 6.283) * 0.042);
      b.rotation.set(0, -i / 7 * 6.283, 0.35); fan.add(b); }
    const hub = new THREE.CylinderGeometry(0.02, 0.02, 0.02, 24); fan.add(new THREE.Mesh(hub, orange));
    fan.rotation.x = Math.PI / 2 - 0.25; fan.position.set(0, RAD.y + 0.035, RAD.z - 0.008);
    fan.traverse(o => { if (o.isMesh) { o.castShadow = !!L.shadow; o.userData.part = "cooling"; } }); g.add(fan);
    // pump and hoses (tubes along smooth curves)
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.07, 24).rotateZ(Math.PI / 2).translate(0.17, 1.05, -0.1), M.alu));
    const hose = pts => add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), 40, 0.013, 10), M.hose));
    hose([[0.21, RAD.y, RAD.z - 0.11], [0.2, 1.08, -0.1], [0.17, 1.05, -0.1]]);                              // radiator -> pump
    hose([[0.13, 1.05, -0.1], [0.08, 1.02, -0.11], [0.04, MOTOR.y, MOTOR.z + 0.12]]);                         // pump -> motor jacket
    hose([[-0.21, RAD.y, RAD.z + 0.1], [-0.18, 1.0, 0.06], [-0.12, CTRL.y + 0.05, CTRL.z + 0.06]]);            // radiator -> controller cold plate
    return g;
  }
  // driver's screen on the flap right above the steering wheel (right-hand seat: the driver sits on the right in Pakistan); the tap transition flies into it
  const EYE = new THREE.Vector3(-0.2, 0.2, 0.42), DASH = new THREE.Vector3(-0.198, -0.268, 0.192);
  function makeDash() {
    const tex = decal(512, 320, (c, W, H) => {
      c.fillStyle = "#121417"; c.fillRect(0, 0, W, H); c.strokeStyle = "#ff8a1f"; c.lineWidth = 6; c.strokeRect(8, 8, W - 16, H - 16);
      c.lineWidth = 14; c.strokeStyle = "#24272b"; c.beginPath(); c.arc(W / 2, 200, 120, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
      c.strokeStyle = "#ff8a1f"; c.beginPath(); c.arc(W / 2, 200, 120, Math.PI * 1.1, Math.PI * 1.55); c.stroke();
      c.fillStyle = "#ffffff"; c.font = "800 60px Inter, Arial, sans-serif"; c.textAlign = "center"; c.fillText("VOLTA", W / 2, 222);
      c.fillStyle = "#2fbf4a"; c.font = "600 22px Inter, Arial, sans-serif"; c.fillText("DRIVER DISPLAY", W / 2, 262);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.05), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    m.position.copy(DASH); m.up.set(0, 0, 1); m.lookAt(DASH.x, DASH.y + 1, DASH.z);   // upright, facing the driver
    return m;
  }

  // ---- framing: fit the kart inside #carSafe (the space the overlay gauges leave) ----
  const HOME = new THREE.Vector3(0, 0.05, -0.2);
  let safe = { w: 1, h: 1 };
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    const hr = host.getBoundingClientRect(), el = document.getElementById("carSafe"), sr = el && el.getBoundingClientRect();
    const r = sr && sr.width > 40 && sr.height > 40 ? { x: sr.left - hr.left, y: sr.top - hr.top, w: sr.width, h: sr.height } : { x: 0, y: 0, w, h };
    safe = { w: r.w / w, h: r.h / h };
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.setViewOffset(w, h, -((r.x + r.w / 2) - w / 2), -((r.y + r.h / 2) - h / 2), w, h);   // centre the kart on the safe area
    camera.updateProjectionMatrix();
    if (composer) { composer.setPixelRatio(dpr); composer.setSize(w, h); }
    fit(); if (!tween && !flight && kart) view(selected || "all", true); need = true;
  }
  function dist() {
    // the kart seen from the default angle is about 3 m wide and 1.6 m tall on screen: fit each way separately so it fills the space
    const t = Math.tan(camera.fov * Math.PI / 360), vf = Math.atan(t * safe.h), hf = Math.atan(t * camera.aspect * safe.w);
    return Math.max(1.45 / Math.sin(hf), 0.8 / Math.sin(vf), 2.2) * (camera.aspect > 1 ? 1.38 : 1.12);   // a little air around the kart (less when upright: the width already limits it)
  }
  function fit() { const d = dist(); controls.minDistance = d * 0.5; controls.maxDistance = d * 1.6; }
  function view(name, now, onDone, splitFor = splitTo) {
    const c = splitFor && name !== "all" && comps[PART_COMP[name]];
    const tgt = c ? c.userData.centre.clone().add(c.userData.off) : HOME.clone();     // split: look at where the part has moved to
    const dir = new THREE.Vector3(...(VIEWS[name] || VIEWS.all)).normalize(), d = dist() * (name === "all" ? (splitFor ? 1.3 : 1) : splitFor ? 0.62 : 0.9);
    const to = dir.multiplyScalar(d).add(tgt);
    if (now || reduceMotion) { camera.position.copy(to); controls.target.copy(tgt); controls.update(); need = true; if (onDone) onDone(); return; }
    tween = { from: camera.position.clone(), to, tFrom: controls.target.clone(), tTo: tgt, t0: performance.now(), dur: 620, onDone };
  }
  new ResizeObserver(resize).observe(host); resize();
  window.addEventListener("resize", resize);

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
    glowMat.opacity = on ? 1 : auto ? 0.35 : 0.08; haloMat.opacity = on ? 0.28 : 0;
    need = true;
  }

  // ---- render loop: only draws when something changed, a fault is pulsing, or the camera or parts are moving ----
  let lastPulse = 0, lastFrame = 0, slow = 0, frames = 0;
  renderer.setAnimationLoop(t => {
    if (tween) { const k = Math.min(1, (t - tween.t0) / tween.dur), e = easeInOut(k);
      camera.position.lerpVectors(tween.from, tween.to, e); controls.target.lerpVectors(tween.tFrom, tween.tTo, e); need = true;
      if (k >= 1) { const done = tween.onDone; tween = null; if (done) done(); } }
    if (flight) flyStep(t); else if (controls.update()) need = true;
    if (split !== splitTo) {
      split = reduceMotion ? splitTo : splitTo ? Math.min(1, split + 0.045) : Math.max(0, split - 0.055);
      const e = easeInOut(split);
      for (const g of Object.values(comps)) g.position.copy(g.userData.off).multiplyScalar(e);
      const ghost = split > 0.02;
      if (ghost !== ghosted) { ghosted = ghost; for (const m of comps.chassis.children) if (m.isMesh && m.userData.mat) { m.material = ghost ? ghostOf(m.userData.mat) : m.userData.mat; m.castShadow = !ghost && !!L.shadow; }
        for (const g of Object.values(comps)) for (const m of g.children) if (m.userData.cls === "seat") m.visible = !ghost; }   // seats step aside so the battery reads clearly
      need = true;
      if (split === splitTo) { busy = false; if (!splitTo) document.body.classList.remove("kart-split"); }   // back together: instruments return
    }
    if (pulse && t - lastPulse > 50) { lastPulse = t; applyState(t); }
    if (!need || document.hidden || !host.offsetParent) { lastFrame = 0; return; }
    // Automatic quality: while things move, watch the frame time and step down once if the phone cannot keep up
    if (pref === "auto" && lastFrame && frames < 400) { frames++; slow = (t - lastFrame > 40) ? slow + 1 : Math.max(0, slow - 1); if (slow > 24) stepDown(); }
    lastFrame = t;
    need = false;
    if (composer && !flight) composer.render(); else renderer.render(scene, camera);   // the fly-in skips AO: smoother, and it would be inside the car anyway
    placeLabels(); placeStudio();
  });
  // studio backdrop (CSS on .stage): keep the cove line (floor meets wall) and the light pool under the kart lined up with the camera
  const stage = host.closest(".stage"), hzP = new THREE.Vector3(), fwd = new THREE.Vector3();
  function placeStudio() {
    if (!stage) return;
    camera.getWorldDirection(fwd); fwd.z = 0; if (fwd.lengthSq() < 1e-6) return; fwd.normalize();
    hzP.set(0, 0, GROUND).addScaledVector(fwd, 2.6); hzP.project(camera);   // the cove where floor meets wall, 2.6 m behind the kart
    const fl = new THREE.Vector3(0, 0, GROUND).add(comps.chassis.position).project(camera);
    stage.style.setProperty("--hz", ((1 - hzP.y) / 2 * 100).toFixed(1) + "%");
    stage.style.setProperty("--fx", ((fl.x + 1) / 2 * 100).toFixed(1) + "%");
    stage.style.setProperty("--fy", ((1 - fl.y) / 2 * 100).toFixed(1) + "%");
  }
  function stepDown() {
    slow = 0;
    if (L.ao) { L = { ...L, ao: false }; composer = null; renderer.setPixelRatio(dpr = Math.min(window.devicePixelRatio || 1, 1.5)); resize(); console.info("graphics: AO off"); }
    else if (dpr > 1) { renderer.setPixelRatio(dpr = 1); resize(); console.info("graphics: 1x pixels"); }
    else frames = 400;
  }

  // ---- labels and the small close button (HTML over the canvas) ----
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
    const w = host.clientWidth, h = host.clientHeight, hr = host.getBoundingClientRect(), el = document.getElementById("carSafe");
    const sr = el ? el.getBoundingClientRect() : hr, gap = 36;
    const padL = Math.max(10, sr.left - hr.left), padR = Math.max(10, hr.right - sr.right);
    const items = labelEls.map(Lb => { const g = comps[Lb.comp]; v.copy(g.userData.centre).add(g.position).project(camera);
      return { ...Lb, ax: (v.x + 1) / 2 * w, ay: (1 - v.y) / 2 * h, ok: v.z < 1 }; })
      .filter(i => i.ok && (!selected || i.b.dataset.part === selected));     // a part is open: only its label stays
    items.sort((a, b) => a.ax - b.ax);
    const cols = [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))];
    let svg = "";
    // the instruments step away while the kart is apart, so the labels can use the full height (clear of the close button)
    cols.forEach((col, side) => {
      col.sort((a, b) => a.ay - b.ay);
      const top = 40, bot = h - 30;
      let y = top; for (const it of col) { it.y = Math.max(it.ay, y); y = it.y + gap; }
      let lim = bot; for (let j = col.length - 1; j >= 0; j--) { col[j].y = Math.max(top, Math.min(col[j].y, lim)); lim = col[j].y - gap; }
      for (const it of col) {
        const bw = it.b.offsetWidth, cx = side ? w - padR - bw / 2 : padL + bw / 2, ex = side ? w - padR - bw : padL + bw;
        it.b.style.transform = `translate(${cx.toFixed(0)}px, ${it.y.toFixed(0)}px) translate(-50%, -50%)`; it.b.style.visibility = "visible";
        svg += `<path d="M${ex.toFixed(0)} ${it.y.toFixed(0)} L${(side ? ex - 14 : ex + 14).toFixed(0)} ${it.y.toFixed(0)} L${it.ax.toFixed(0)} ${it.ay.toFixed(0)}"/><circle cx="${it.ax.toFixed(0)}" cy="${it.ay.toFixed(0)}" r="3.5"/>`;
        if (state && state[it.b.dataset.part]) it.b.dataset.sev = state[it.b.dataset.part].sev || "none";
      }
    });
    const shown = new Set(items.map(i => i.b)); for (const Lb of labelEls) if (!shown.has(Lb.b)) Lb.b.style.visibility = "hidden";
    lines.innerHTML = svg;
  }
  // split / reassemble: first glide to the default angle, then move the parts
  function explode(on) {
    if (busy || !!splitTo === !!on) return;
    busy = true; selected = null;
    if (on) document.body.classList.add("kart-split");                    // everything else steps away while the kart is apart
    view("all", false, () => {
      splitTo = on ? 1 : 0; done.hidden = !on; wrap.classList.toggle("split", on);
      for (const { b } of labelEls) b.tabIndex = on ? 0 : -1;
      applyState(performance.now()); need = true;
    }, on ? 1 : 0);
    try { localStorage.setItem("kartSplitSeen", "1"); } catch (e) {}
  }

  // ---- taps (not drags) ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null, holdTimer = 0;
  const HOLD_MS = 500;
  function hitsAt(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(kart, true).filter(h => h.object.visible && h.object.isMesh && h.object.material !== glowMat && h.object.material !== haloMat);
  }
  const cancelHold = () => { clearTimeout(holdTimer); ring.hidden = true; };
  renderer.domElement.addEventListener("contextmenu", e => e.preventDefault());   // no long-press menu on phones
  renderer.domElement.addEventListener("pointerdown", e => {
    if (!kart || flight || busy) return;
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
    if (!down || !kart || flight || busy) return; const d = down; down = null;
    if (d.held || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > HOLD_MS) return;
    const hits = hitsAt(e);
    if (!splitTo) { if (hits.length) driverView(); return; }
    const hit = hits.find(h => h.object.userData.part);                   // the see-through chassis never blocks a part behind it
    if (hit) window.dispatchEvent(new CustomEvent("kartpart", { detail: hit.object.userData.part }));
  });

  // ---- tap transition: one smooth curve over the cockpit, down to the driver's eye and onto the dash screen (0.75 s) ----
  function driverView() {
    if (reduceMotion) { window.dispatchEvent(new CustomEvent("kartopen")); return; }
    tween = null;
    const p0 = camera.position.clone(), p3 = DASH.clone().add(new THREE.Vector3(0, 0.12, 0.012));
    const p1 = EYE.clone().add(new THREE.Vector3(0, 0.45, 0.95)), p2 = EYE.clone();
    flight = { t0: performance.now(), dur: 760, p0, p1, p2, p3, tFrom: controls.target.clone(), opened: false };
    wrap.classList.add("flying"); window.dispatchEvent(new CustomEvent("kartopening"));
  }
  const bez = (a, b, c, d, k) => { const u = 1 - k; return a.clone().multiplyScalar(u * u * u).addScaledVector(b, 3 * u * u * k).addScaledVector(c, 3 * u * k * k).addScaledVector(d, k * k * k); };
  function flyStep(t) {
    const k = Math.min(1, (t - flight.t0) / flight.dur), e = easeInOut(k);
    camera.position.copy(bez(flight.p0, flight.p1, flight.p2, flight.p3, e));
    controls.target.lerpVectors(flight.tFrom, DASH, Math.min(1, e * 1.6)); camera.lookAt(controls.target);
    need = true;
    if (k > 0.78 && !flight.opened) { flight.opened = true; window.dispatchEvent(new CustomEvent("kartopen")); }   // dashboard fades in over the last stretch
    if (k >= 1) { flight = null; }
  }
  function home() {                                                         // back to the normal view (after the dashboard closes)
    flight = null; wrap.classList.remove("flying"); view(selected || "all", true);
  }

  window.kart3d = {
    update(s) { state = s; applyState(performance.now()); },
    select(part) { selected = part || null; view(part || "all"); applyState(performance.now()); },
    explode, home, quality: levelName,
    redraw() { resize(); },
  };
  if (window.kartState) window.kart3d.update(window.kartState);
}

window.kart3dLevel = webglOk() ? startLevel : "off";
if (host && window.kart3dLevel !== "off") start(startLevel);

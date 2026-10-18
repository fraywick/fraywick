// FRAYWICK hero + scroll story: a heavy hand-woven wool tapestry hanging from a wooden rod by leather tabs.
// CPU verlet (PBD) cloth → float textures → GPU Catmull-Rom surface (front, back and edges = real thickness) with a procedural
// twisted-yarn weave, raised weft ridges (one per anchored epoch), fresnel fibre fuzz. Verlet fringe tassels, loose threads
// (changed items) with paper hang-tags, and the 5-step story objects (thread → bead → merkle braid → seal on a block → new row).
// The camera never travels: only a small pointer parallax. Scroll moves the objects.
import * as THREE from 'three'
import { Sys, Links, Tubes, yarnMaterial } from './tapestry.js'

const BG = 0x121212
const C = { wool: 0x67635d, wool2: 0x403d3a, ridge: 0x7a756d, bone: 0xe6dfcf, orange: 0xff5a1f, muted: 0xc88a5a, rod: 0x3a2a1e, leather: 0x4a2e1d, brass: 0xa4824a }
const W = 3.0, H = 3.3            // woven size (local units)
const ROD_Y = 2.12, TOP_Y = 1.94  // rod and cloth top in local space
const MAX_RIDGES = 9

const hash = (x) => { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s) }
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (x) => Math.max(0, Math.min(1, x))

// ── GLSL: cloth surface from the simulation textures ─────────────────────────────
const CLOTH_VERT_HEAD = /* glsl */`
uniform sampler2D uPos, uNrm;
uniform vec2 uSz;
uniform float uThick, uRidgeH, uRidgeW, uRidgeN, uGrow, uGrowV;
uniform float uRidges[${MAX_RIDGES}];
attribute vec3 aGrid;
attribute vec2 aEdge;
varying vec2 vG;
varying float vSide;
vec3 tf(sampler2D t, ivec2 p) { p = clamp(p, ivec2(0), ivec2(uSz) - 1); return texelFetch(t, p, 0).xyz; }
vec3 crm(vec3 a, vec3 b, vec3 c, vec3 d, float t) { return 0.5 * ((2.0 * b) + (-a + c) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t * t + (-a + 3.0 * b - 3.0 * c + d) * t * t * t); }
vec3 sCR(sampler2D t, vec2 uv) {
  vec2 g = clamp(uv, 0.0, 1.0) * (uSz - 1.0);
  ivec2 i = ivec2(min(floor(g), uSz - 2.0));
  vec2 f = g - vec2(i);
  vec3 r0 = crm(tf(t, i + ivec2(-1, -1)), tf(t, i + ivec2(0, -1)), tf(t, i + ivec2(1, -1)), tf(t, i + ivec2(2, -1)), f.x);
  vec3 r1 = crm(tf(t, i + ivec2(-1, 0)), tf(t, i + ivec2(0, 0)), tf(t, i + ivec2(1, 0)), tf(t, i + ivec2(2, 0)), f.x);
  vec3 r2 = crm(tf(t, i + ivec2(-1, 1)), tf(t, i + ivec2(0, 1)), tf(t, i + ivec2(1, 1)), tf(t, i + ivec2(2, 1)), f.x);
  vec3 r3 = crm(tf(t, i + ivec2(-1, 2)), tf(t, i + ivec2(0, 2)), tf(t, i + ivec2(1, 2)), tf(t, i + ivec2(2, 2)), f.x);
  return crm(r0, r1, r2, r3, f.y);
}
float ridgeH(float v) {
  float h = 0.0;
  for (int k = 0; k < ${MAX_RIDGES}; k++) {
    if (float(k) >= uRidgeN) break;
    float d = (v - uRidges[k]) / uRidgeW;
    h = max(h, exp(-d * d * 2.2));
  }
  float dg = (v - uGrowV) / uRidgeW;
  h = max(h, exp(-dg * dg * 2.2) * uGrow);
  return h * uRidgeH;
}
void clothVert(out vec3 P, out vec3 Nn) {
  vec2 uv = aGrid.xy; float side = aGrid.z;
  vec3 p = sCR(uPos, uv);
  vec3 n = normalize(sCR(uNrm, uv) + 1e-5);
  float r = ridgeH(uv.y);
  float off;
  if (aEdge.x != 0.0 || aEdge.y != 0.0) {
    off = side * uThick * 0.5 + (side > 0.0 ? r : -r * 0.35) * abs(side);
    vec3 q = sCR(uPos, uv - aEdge * vec2(1.5 / (uSz.x - 1.0), 1.5 / (uSz.y - 1.0)));
    Nn = normalize(p - q);
  } else {
    off = side > 0.0 ? uThick * 0.5 + r : -uThick * 0.5 - r * 0.35;
    Nn = n * sign(side);
  }
  P = p + n * off;
  vG = uv; vSide = side;
}`

const CLOTH_FRAG_HEAD = /* glsl */`
uniform float uN, uPicks, uWw, uHh, uRidgeW, uRidgeN, uGrow, uGrowV, uDim, uFuzz, uAA;
uniform float uRidges[${MAX_RIDGES}];
uniform vec3 cWool, cWool2, cRidge, cBone, cRim;
varying vec2 vG;
varying float vSide;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), f.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), f.x), f.y); }
// weft-faced plain weave of 2-ply yarn: picks dominate, every warp end (one per tracked item) shows as a rib
float baseH(vec2 c) {
  float pj = floor(c.y);
  vec2 f = fract(c);
  float py = (f.y - 0.5) * 2.0;
  float pick = sqrt(max(0.0, 1.0 - py * py * 0.92));
  float over = mod(floor(c.x) + pj, 2.0);
  float rib = mix(0.8 + 0.2 * cos(6.2831 * (f.x - 0.5)), 1.0 - 0.18 * cos(6.2831 * (f.x - 0.5)), over);
  float tw = 0.5 + 0.5 * sin(6.2831 * (c.x * 0.55 + f.y * 0.9) + pj * 2.1);
  return pick * rib * (0.84 + 0.16 * tw);
}
// soumak-like rope ridge: coils that lean one way per ridge
float ropeH(float x, float v, out float inR) {
  float best = 0.0; inR = 0.0;
  for (int k = 0; k < ${MAX_RIDGES} + 1; k++) {
    float rv = k < ${MAX_RIDGES} ? uRidges[k] : uGrowV;
    float amp = k < ${MAX_RIDGES} ? (float(k) < uRidgeN ? 1.0 : 0.0) : uGrow;
    if (amp <= 0.0) continue;
    float d = (v - rv) / uRidgeW;
    if (abs(d) > 1.25) continue;
    float prof = sqrt(max(0.0, 1.0 - d * d / 1.5625));
    float dir = mod(float(k), 2.0) * 2.0 - 1.0;
    float ph = fract(x * 30.0 + d * 0.7 * dir);
    float coil = 0.55 + 0.45 * sin(3.1416 * ph);
    float h = prof * coil * amp;
    if (h > best) { best = h; inR = prof * amp; }
  }
  return best;
}
float clothH(vec2 g, out float inR, out vec2 cw) {
  float X = g.x * uWw, Y = g.y * uHh;
  cw = vec2(g.x * uN, Y * uPicks);
  float b = baseH(cw) * 0.35;
  float r = ropeH(X, g.y, inR) * 1.15;
  return max(b, r);
}`

function clothMaterial(uni, { physical }) {
  const Mat = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial
  const m = new Mat({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide, ...(physical ? { sheen: 0.4, sheenRoughness: 0.9, sheenColor: new THREE.Color(0x6e665c) } : {}) })
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + CLOTH_VERT_HEAD)
      .replace('#include <beginnormal_vertex>', 'vec3 clothP, clothN; clothVert(clothP, clothN);\nvec3 objectNormal = clothN;')
      .replace('#include <begin_vertex>', 'vec3 transformed = clothP;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CLOTH_FRAG_HEAD)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float inR; vec2 cw;
        float hC = clothH(vG, inR, cw);
        float aa = clamp(2.0 - max(fwidth(cw.x), fwidth(cw.y)) * 3.2, 0.2, 1.0);
        float pj = floor(cw.y);
        vec3 col = mix(cWool2, cWool, 0.35 + 0.65 * h12(vec2(pj, 4.1)));
        col *= 0.88 + 0.24 * vnoise(vec2(vG.x * 9.0, vG.y * 5.0));                 // hand-dyed lots
        col *= 0.9 + 0.2 * h12(vec2(floor(cw.x * 1.7), pj)) * aa;                    // heather fibres
        col = mix(col, cRidge * (0.9 + 0.2 * h12(vec2(floor(vG.x * uWw * 13.0), 2.0))), clamp(inR * 1.4, 0.0, 1.0));
        float dg = abs(vG.y - uGrowV) / uRidgeW;
        col = mix(col, cBone * 0.75, uGrow * (1.0 - smoothstep(0.0, 1.2, dg)) * 0.55);
        float ao = mix(0.52, 1.0, smoothstep(0.0, 0.55, hC));
        diffuseColor.rgb = col * mix(1.0, ao, aa) * uDim;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (vSide != 0.0 && abs(vSide) > 0.99) {
          float e = 0.0016, ir; vec2 cc;
          float h0 = clothH(vG, ir, cc);
          float hx = clothH(vG + vec2(e / uWw, 0.0), ir, cc);
          float hy = clothH(vG + vec2(0.0, e / uHh), ir, cc);
          float A = 0.01 * aa;
          vec3 mapN = normalize(vec3(-(hx - h0) / e * A, -(hy - h0) / e * A, 1.0));
          vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
          vec2 s0 = dFdx(vG * vec2(uWw, uHh)), s1 = dFdy(vG * vec2(uWw, uHh));
          vec3 N0 = normal;
          vec3 q1p = cross(q1, N0), q0p = cross(N0, q0);
          vec3 T = q1p * s0.x + q0p * s1.x, B = q1p * s0.y + q0p * s1.y;
          float det = max(dot(T, T), dot(B, B));
          float sc = det == 0.0 ? 0.0 : inversesqrt(det);
          normal = normalize(mat3(T * sc, B * sc, N0) * mapN);
        }`)
      .replace('#include <opaque_fragment>', `
        float nv = abs(dot(normal, normalize(vViewPosition)));
        float fz = pow(1.0 - nv, 3.0) * (0.6 + 0.4 * vnoise(vG * vec2(70.0, 80.0)));
        outgoingLight += cRim * fz * uFuzz * uDim + diffuseColor.rgb * fz * 0.25;
        #include <opaque_fragment>`)
  }
  m.customProgramCacheKey = () => 'fw-cloth-' + (physical ? 'p' : 's')
  return m
}
function clothDepth(uni) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + CLOTH_VERT_HEAD)
      .replace('#include <begin_vertex>', 'vec3 clothP, clothN; clothVert(clothP, clothN);\nvec3 transformed = clothP;')
  }
  m.customProgramCacheKey = () => 'fw-cloth-depth'
  return m
}

// cloth render geometry: front + back grids and the four edges (each edge strip spans back → front)
function clothGeometry(RC, RR) {
  const grid = [], edge = [], idx = []
  const add = (u, v, s, ex = 0, ey = 0) => { grid.push(u, v, s); edge.push(ex, ey); return grid.length / 3 - 1 }
  for (const s of [1, -1]) {
    const base = grid.length / 3
    for (let r = 0; r < RR; r++) for (let c = 0; c < RC; c++) add(c / (RC - 1), r / (RR - 1), s)
    for (let r = 0; r < RR - 1; r++) for (let c = 0; c < RC - 1; c++) {
      const a = base + r * RC + c, b = a + 1, d = a + RC, e = d + 1
      if (s > 0) idx.push(a, d, b, b, d, e); else idx.push(a, b, d, b, e, d)
    }
  }
  const strip = (n, at, ex, ey, flip) => {
    const base = grid.length / 3
    for (let i = 0; i < n; i++) { const [u, v] = at(i / (n - 1)); add(u, v, -1, ex, ey); add(u, v, 1, ex, ey) }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3
      if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c)
    }
  }
  strip(RR, (t) => [0, t], -1, 0, false)
  strip(RR, (t) => [1, t], 1, 0, true)
  strip(RC, (t) => [t, 1], 0, 1, false)
  strip(RC, (t) => [t, 0], 0, -1, true)
  const g = new THREE.BufferGeometry()
  const n = grid.length / 3
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('aGrid', new THREE.BufferAttribute(new Float32Array(grid), 3))
  g.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(edge), 2))
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 6)
  return g
}

// canvas text helpers (hash rings, block tiles, tags)
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  draw(ctx, w, h)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4
  return t
}
const MONO = '"Geist Mono", ui-monospace, Menlo, monospace'

// yarn ball: a long tube wound around a sphere
function yarnBall(radius, turns = 26, seed = 1) {
  const pts = []
  const n = turns * 24
  for (let i = 0; i < n; i++) {
    const t = i / n
    const a = t * turns * Math.PI * 2
    const tilt = (Math.floor(t * 5 + seed) * 1.7) % Math.PI
    const v = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.95, Math.sin(a * 0.07 + seed) * 0.3).normalize()
    v.applyAxisAngle(new THREE.Vector3(Math.sin(tilt), Math.cos(tilt), 0.3).normalize(), t * 9 + seed)
    pts.push(v.multiplyScalar(radius))
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, radius * 0.09, 5, false)
}

export function tagGeometry(w, h, depth, cutH = h) {
  const s = new THREE.Shape()
  const r = cutH * 0.18, cut = cutH * 0.32
  s.moveTo(-w / 2 + cut, h / 2); s.lineTo(w / 2 - r, h / 2); s.quadraticCurveTo(w / 2, h / 2, w / 2, h / 2 - r)
  s.lineTo(w / 2, -h / 2 + r); s.quadraticCurveTo(w / 2, -h / 2, w / 2 - r, -h / 2); s.lineTo(-w / 2 + cut, -h / 2); s.lineTo(-w / 2, -h / 2 + cut)
  s.lineTo(-w / 2, h / 2 - cut); s.lineTo(-w / 2 + cut, h / 2)
  const hole = new THREE.Path(); hole.absarc(-w / 2 + cut * 0.95, 0, cutH * 0.09, 0, Math.PI * 2, true); s.holes.push(hole)
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 6 })
  g.translate(w / 2 - cut * 0.95, 0, -depth / 2) // hole at the origin
  // planar uv for a printed face
  const p = g.attributes.position, uv = g.attributes.uv
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + cut * 0.95) / w, (p.getY(i) + h / 2) / h)
  return g
}

export function createScene(canvas, opts = {}) {
  const tier = opts.tier || 'high'
  const low = tier === 'low'
  const reduced = !!opts.reduced
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, low ? 1.5 : 2))
  renderer.setClearColor(BG, 1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(BG, 11, 22)
  const camera = new THREE.PerspectiveCamera(32, 1, 0.3, 60)
  const target = new THREE.Vector3(0, 0.15, 0)

  // lights: warm raking key from the left, cool rim from behind, low hemisphere fill
  scene.add(new THREE.HemisphereLight(0xa9acb0, 0x1c1814, 0.36))
  const key = new THREE.DirectionalLight(0xffdcb8, 4.6)
  key.position.set(-7.5, 3.2, 2.4)
  key.castShadow = true
  key.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048)
  Object.assign(key.shadow.camera, { left: -3.6, right: 3.6, top: 3.6, bottom: -3.8, near: 1, far: 20 })
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02; key.shadow.radius = 4
  scene.add(key, key.target)
  const rim = new THREE.DirectionalLight(0xbfd4ff, low ? 0.8 : 1.5)
  rim.position.set(3.5, 2.5, -5)
  scene.add(rim, rim.target)
  const fill = new THREE.DirectionalLight(0xc8d0dc, 0.8)
  fill.position.set(4, -1, 5)
  scene.add(fill)

  // floor: lit faintly under the tapestry, fades into the background by fog
  const floorY = -2.85
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.55 }))
  floor.rotation.x = -Math.PI / 2; floor.position.y = floorY; floor.receiveShadow = true
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(5.0, 2.2), new THREE.MeshBasicMaterial({ map: canvasTex(256, 128, (x, w, h) => {
    const g = x.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2); g.addColorStop(0, 'rgba(0,0,0,.7)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h)
  }), transparent: true, depthWrite: false }))
  blob.rotation.x = -Math.PI / 2; blob.position.set(0.1, floorY + 0.005, 0.15)
  scene.add(blob)

  // ── tapestry group ────────────────────────────────────────────────────────
  const tap = new THREE.Group()
  tap.rotation.y = 0.12
  scene.add(tap)
  const rodGeo = new THREE.CylinderGeometry(0.035, 0.035, W + 0.75, 20)
  const rod = new THREE.Mesh(rodGeo, new THREE.MeshStandardMaterial({ color: C.rod, roughness: 0.62, metalness: 0 }))
  rod.rotation.z = Math.PI / 2; rod.position.set(0, ROD_Y, 0); rod.castShadow = true
  tap.add(rod)
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshStandardMaterial({ color: C.brass, roughness: 0.38, metalness: 0.85 }))
    cap.position.set(s * (W / 2 + 0.38), ROD_Y, 0); cap.castShadow = true
    tap.add(cap)
  }

  // simulation grid
  const SC = low ? 22 : 34, SR = low ? 26 : 40
  const sys = new Sys(SC * SR + 6000)
  const links = new Links()
  let ropeLinks = new Links()
  const tasselLinks = []
  const dx = W / (SC - 1), dy = H / (SR - 1)
  const tabCols = []
  for (let k = 0; k < 7; k++) tabCols.push(Math.round((k * (SC - 1)) / 6))
  for (let r = 0; r < SR; r++) for (let c = 0; c < SC; c++) {
    const pinned = r === 0 && tabCols.includes(c)
    sys.add(-W / 2 + c * dx, TOP_Y - r * dy, 0, pinned ? 0 : 1)
  }
  const id = (c, r) => r * SC + c
  for (let r = 0; r < SR; r++) for (let c = 0; c < SC; c++) {
    if (c < SC - 1) links.add(sys, id(c, r), id(c + 1, r), 1)
    if (r < SR - 1) links.add(sys, id(c, r), id(c, r + 1), 1)
    if (c < SC - 1 && r < SR - 1) { links.add(sys, id(c, r), id(c + 1, r + 1), 0.7); links.add(sys, id(c + 1, r), id(c, r + 1), 0.7) }
    if (c < SC - 2) links.add(sys, id(c, r), id(c + 2, r), 0.5)
    if (r < SR - 2) links.add(sys, id(c, r), id(c, r + 2), 0.5)
  }
  links.freeze()
  // long-range tethers to the nearest tab
  const tethers = []
  for (let r = 1; r < SR; r++) for (let c = 0; c < SC; c++) {
    let best = tabCols[0]; for (const t of tabCols) if (Math.abs(t - c) < Math.abs(best - c)) best = t
    const a = id(c, r), b = id(best, 0)
    tethers.push(a, b, Math.hypot((c - best) * dx, r * dy) * 1.01)
  }
  const teth = Float32Array.from(tethers)
  const NCL = SC * SR

  const posTex = new THREE.DataTexture(new Float32Array(NCL * 4), SC, SR, THREE.RGBAFormat, THREE.FloatType)
  const nrmTex = new THREE.DataTexture(new Float32Array(NCL * 4), SC, SR, THREE.RGBAFormat, THREE.FloatType)
  for (const t of [posTex, nrmTex]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true }
  const uni = {
    uPos: { value: posTex }, uNrm: { value: nrmTex }, uSz: { value: new THREE.Vector2(SC, SR) },
    uThick: { value: 0.05 }, uRidgeH: { value: 0.06 }, uRidgeW: { value: 0.019 }, uRidgeN: { value: 0 }, uGrow: { value: 0 }, uGrowV: { value: 0.035 },
    uRidges: { value: new Array(MAX_RIDGES).fill(-1) },
    uN: { value: 96 }, uPicks: { value: 27 }, uWw: { value: W }, uHh: { value: H }, uDim: { value: 1 }, uFuzz: { value: low ? 0 : 1 }, uAA: { value: 1 },
    cWool: { value: new THREE.Color(C.wool) }, cWool2: { value: new THREE.Color(C.wool2) }, cRidge: { value: new THREE.Color(C.ridge) },
    cBone: { value: new THREE.Color(C.bone) }, cRim: { value: new THREE.Color(0xb8ccf0).multiplyScalar(0.32) },
  }
  const RC = low ? 54 : 120, RR = low ? 64 : 150
  const cloth = new THREE.Mesh(clothGeometry(RC, RR), clothMaterial(uni, { physical: !low }))
  cloth.customDepthMaterial = clothDepth(uni)
  cloth.castShadow = true; cloth.receiveShadow = true
  cloth.frustumCulled = false
  tap.add(cloth)

  // leather tabs around the rod, following their pinned cloth points
  const tabGeo = new THREE.TorusGeometry(0.085, 0.024, 8, 20, Math.PI * 1.3)
  const tabMat = new THREE.MeshStandardMaterial({ color: C.leather, roughness: 0.7, metalness: 0 })
  for (const t of tabCols) {
    const m = new THREE.Mesh(tabGeo, tabMat)
    m.scale.set(1, 1.5, 2.6)
    m.rotation.set(0, Math.PI / 2, Math.PI * 1.37)
    m.position.set(-W / 2 + t * dx, ROD_Y - 0.035, 0)
    m.castShadow = true
    tap.add(m)
  }

  // fringe tassels: verlet ropes hanging from the bottom edge, three strands each
  const TS = low ? 22 : 44, TP = 9, tLen = 0.85
  const tassels = []
  for (let k = 0; k < TS; k++) {
    const u = (k + 0.5) / TS
    const s0 = sys.n
    const len = tLen * (0.85 + 0.3 * hash(k * 3.3))
    for (let p = 0; p < TP; p++) sys.add(-W / 2 + u * W, TOP_Y - H - (len * p) / (TP - 1), 0, p === 0 ? 0 : 1)
    const L1 = len / (TP - 1)
    for (let p = 1; p < TP; p++) { tasselLinks.push([s0 + p - 1, s0 + p, L1, 1]); if (p > 1) tasselLinks.push([s0 + p - 2, s0 + p, 2 * L1, 0.3]) }
    tassels.push({ s0, u })
  }
  const baseN = sys.n
  const tasselTubes = new Tubes(TS * 3, TP, low ? 3 : 4, 0.011)
  for (let i = 0; i < TS * 3; i++) for (let p = 0; p < TP; p++) tasselTubes.rad[i * TP + p] = 1 - (p / (TP - 1)) * 0.45
  const fringeMat = yarnMaterial(0x45413c, { twist: 0.9 })
  const fringe = new THREE.Mesh(tasselTubes.geo, fringeMat)
  fringe.castShadow = true; fringe.receiveShadow = true; fringe.frustumCulled = false
  tap.add(fringe)

  // ── loose threads (changed items) with paper hang-tags ─────────────────────
  const looseGroup = new THREE.Group(); tap.add(looseGroup)
  let loose = []
  const LP = low ? 14 : 22
  const tagGeo = tagGeometry(0.17, 0.095, 0.006)
  const hairMat = new THREE.MeshStandardMaterial({ color: 0xd9d2c4, roughness: 1 })

  function setLoose(list) {
    for (const l of loose) { looseGroup.remove(l.mesh, l.tag, l.hair); l.tubes.geo.dispose(); l.tag.material.map?.dispose(); l.tag.material.dispose() }
    loose = []
    sys.n = baseN
    ropeLinks = new Links()
    for (const [a, b, L, st] of tasselLinks) ropeLinks.addRest(a, b, L, st)
    list.forEach((d, i) => {
      const s0 = sys.n
      const len = (d.label === 'suspicious' ? 1.05 : 0.8) * (0.85 + 0.3 * hash(i * 4.7))
      const dir = hash(i * 9.1) > 0.5 ? 1 : -1
      const shape = []
      const turns = 1.4 + hash(i * 2.2) * 1.4
      for (let k = 0; k < LP; k++) {
        const t = k / (LP - 1), a = t * turns * Math.PI * 2 + hash(i) * 6
        const amp = 0.07 * Math.min(1, t * 3)
        shape.push([dir * (Math.sin(a) * amp + t * 0.22), -t * len * 0.62, 0.08 + Math.sin(Math.min(1, t * 1.6) * 1.57) * 0.62 + Math.cos(a) * amp * 0.8])
      }
      const root = clothPoint(d.u, d.v, new THREE.Vector3())
      for (let k = 0; k < LP; k++) sys.add(root.x + shape[k][0] * 0.1, root.y + shape[k][1], root.z + 0.02, k === 0 ? 0 : 1)
      const dd = (a, b) => Math.hypot(shape[a][0] - shape[b][0], shape[a][1] - shape[b][1], shape[a][2] - shape[b][2])
      for (let k = 1; k < LP; k++) {
        ropeLinks.addRest(s0 + k - 1, s0 + k, dd(k - 1, k), 1)
        if (k > 1) ropeLinks.addRest(s0 + k - 2, s0 + k, dd(k - 2, k), 0.8)
        if (k > 3) ropeLinks.addRest(s0 + k - 4, s0 + k, dd(k - 4, k), 0.35)
      }
      // tag: hairline anchor + tag top, hanging from the thread end
      const tA = sys.add(root.x, root.y - len * 0.8, root.z + 0.4)
      const tB = sys.add(root.x, root.y - len * 0.8 - 0.1, root.z + 0.4)
      ropeLinks.addRest(s0 + LP - 1, tA, 0.07, 1)
      ropeLinks.addRest(tA, tB, 0.1, 1)
      const tubes = new Tubes(1, LP, low ? 5 : 7, d.label === 'suspicious' ? 0.017 : 0.014)
      for (let k = 0; k < LP; k++) tubes.rad[k] = 1 - Math.max(0, (k - LP * 0.75) / LP) * 1.6
      const col = d.label === 'suspicious' ? C.orange : C.muted
      const mesh = new THREE.Mesh(tubes.geo, yarnMaterial(col, { emissive: d.label === 'suspicious' ? 0.35 : 0.08, twist: 0.45 }))
      mesh.castShadow = true; mesh.frustumCulled = false
      const hair = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 1, 4, 1, true), hairMat)
      hair.castShadow = true
      const tagTex = canvasTex(256, 144, (x, w, h) => {
        x.fillStyle = '#e8e0cf'; x.fillRect(0, 0, w, h)
        if (opts.blankTags) { x.fillStyle = d.label === 'suspicious' ? '#d4461a' : '#8a5a36'; x.fillRect(70, 52, 120, 8); return }
        x.fillStyle = d.label === 'suspicious' ? '#d4461a' : '#8a5a36'; x.font = `600 30px ${MONO}`; x.fillText(d.label || 'changed', 70, 62)
        x.fillStyle = '#3a3630'; x.font = `22px ${MONO}`; x.fillText(d.short || '', 70, 100)
      })
      const tag = new THREE.Mesh(tagGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, map: tagTex, roughness: 0.95, metalness: 0 }))
      tag.castShadow = true; tag.receiveShadow = true
      looseGroup.add(mesh, hair, tag)
      loose.push({ ...d, s0, n: LP, tA, tB, tubes, mesh, tag, hair, delay: simT + 0.35 + i * 0.12, released: reduced, dir })
    })
    ropeLinks.freeze()
  }
  setLoose([])

  // cloth point at (u, v) in [0,1]², local space, bilinear over the sim grid (+ a little out along the normal)
  const nTmp = new Float32Array(NCL * 3)
  function clothPoint(u, v, out, nOut) {
    const gx = clamp01(u) * (SC - 1), gy = clamp01(v) * (SR - 1)
    const c0 = Math.min(SC - 2, Math.floor(gx)), r0 = Math.min(SR - 2, Math.floor(gy)), fx = gx - c0, fy = gy - r0
    const P = sys.p
    const at = (arr, c, r, k) => arr[(r * SC + c) * 3 + k]
    const v3 = [0, 0, 0], n3 = [0, 0, 0]
    for (let k = 0; k < 3; k++) {
      v3[k] = lerp(lerp(at(P, c0, r0, k), at(P, c0 + 1, r0, k), fx), lerp(at(P, c0, r0 + 1, k), at(P, c0 + 1, r0 + 1, k), fx), fy)
      n3[k] = lerp(lerp(at(nTmp, c0, r0, k), at(nTmp, c0 + 1, r0, k), fx), lerp(at(nTmp, c0, r0 + 1, k), at(nTmp, c0 + 1, r0 + 1, k), fx), fy)
    }
    const nl = Math.hypot(...n3) || 1
    out.set(v3[0] + (n3[0] / nl) * 0.03, v3[1] + (n3[1] / nl) * 0.03, v3[2] + (n3[2] / nl) * 0.03)
    if (nOut) nOut.set(n3[0] / nl, n3[1] / nl, n3[2] / nl)
    return out
  }

  function computeNormals() {
    const P = sys.p
    for (let r = 0; r < SR; r++) for (let c = 0; c < SC; c++) {
      const cl = Math.max(0, c - 1), cr = Math.min(SC - 1, c + 1), ru = Math.max(0, r - 1), rd = Math.min(SR - 1, r + 1)
      const a = id(cl, r) * 3, b = id(cr, r) * 3, u = id(c, ru) * 3, d = id(c, rd) * 3
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
      const vx = P[d] - P[u], vy = P[d + 1] - P[u + 1], vz = P[d + 2] - P[u + 2]
      // n = v × u (front faces +z at rest)
      let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux
      const l = Math.hypot(nx, ny, nz) || 1
      const k = (r * SC + c) * 3
      nTmp[k] = nx / l; nTmp[k + 1] = ny / l; nTmp[k + 2] = nz / l
    }
  }
  function uploadCloth() {
    const pa = posTex.image.data, na = nrmTex.image.data, P = sys.p
    for (let i = 0; i < NCL; i++) {
      pa[i * 4] = P[i * 3]; pa[i * 4 + 1] = P[i * 3 + 1]; pa[i * 4 + 2] = P[i * 3 + 2]
      na[i * 4] = nTmp[i * 3]; na[i * 4 + 1] = nTmp[i * 3 + 1]; na[i * 4 + 2] = nTmp[i * 3 + 2]
    }
    posTex.needsUpdate = true; nrmTex.needsUpdate = true
  }

  // ── story objects (world space, in front of the tapestry) ─────────────────
  const story = new THREE.Group(); scene.add(story)
  const ST = { p: -1, data: {} }
  const ballGeo = yarnBall(0.24, 22, 1.3), ballGeoS = yarnBall(0.13, 16, 2.1)
  const orangeYarn = yarnMaterial(C.orange, { emissive: 0.3, twist: 0.5 })
  const boneYarn = yarnMaterial(0xcfc6b5, { twist: 0.5 })
  const woolYarn = yarnMaterial(0x6a645c, { twist: 0.5 })
  // the single thread (step 1) as a tube driven by procedural points
  const SP = 40
  const sThread = new Tubes(1, SP, 7, 0.018)
  for (let k = 0; k < SP; k++) sThread.rad[k] = 1 - Math.max(0, (k - SP * 0.85) / SP) * 3
  const sThreadMesh = new THREE.Mesh(sThread.geo, orangeYarn); sThreadMesh.castShadow = true; sThreadMesh.frustumCulled = false
  story.add(sThreadMesh)
  const bead = new THREE.Mesh(ballGeo, orangeYarn); bead.castShadow = true
  story.add(bead)
  let ringMat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false })
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.11, 72, 1, true), ringMat)
  story.add(ring)
  // merkle braid: 8 leaves → 4 → 2 → 1
  const LEAVES = 8
  const tree = []
  const treeLinks = []
  const levelY = [-0.85, -0.2, 0.42, 1.0]
  for (let lv = 0, n = LEAVES; lv < 4; lv++, n /= 2) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n - 0.5) * 2.6
      const m = new THREE.Mesh(lv === 3 ? ballGeo : ballGeoS, lv === 3 ? orangeYarn : i === 0 && lv === 0 ? orangeYarn : boneYarn)
      m.castShadow = true
      const from = new THREE.Vector3((hash(lv * 10 + i) - 0.5) * 2.6, (hash(lv * 7 + i * 3) - 0.3) * 2.2, -1.2)
      tree.push({ m, lv, i, to: new THREE.Vector3(x, levelY[lv], 0.9), from })
      story.add(m)
    }
  }
  const treeIdx = (lv, i) => [0, 8, 12, 14][lv] + i
  const linkMat = boneYarn
  for (let lv = 0, n = LEAVES; lv < 3; lv++, n /= 2) {
    for (let i = 0; i < n; i++) {
      const a = tree[treeIdx(lv, i)].to, b = tree[treeIdx(lv + 1, Math.floor(i / 2))].to
      const mid = new THREE.Vector3((a.x + b.x) / 2 + (i % 2 ? -0.08 : 0.08), (a.y + b.y) / 2, a.z + 0.05)
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, mid, b]), 24, 0.022, 6, false)
      const m = new THREE.Mesh(g, i === 0 || (lv > 0 && i === 0) ? orangeYarn : linkMat)
      m.castShadow = true
      m.geometry.setDrawRange(0, 0)
      story.add(m)
      treeLinks.push({ m, lv, total: g.index.count })
    }
  }
  const rootRing = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.09, 64, 1, true), new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }))
  story.add(rootRing)
  // block tiles linked like a chain + the wax seal
  const tileShape = new THREE.Shape(); { const w = 1.5, h = 0.62, r = 0.08; tileShape.moveTo(-w / 2 + r, -h / 2); tileShape.lineTo(w / 2 - r, -h / 2); tileShape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); tileShape.lineTo(w / 2, h / 2 - r); tileShape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); tileShape.lineTo(-w / 2 + r, h / 2); tileShape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); tileShape.lineTo(-w / 2, -h / 2 + r); tileShape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2) }
  const tileGeo = new THREE.ExtrudeGeometry(tileShape, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 })
  tileGeo.translate(0, 0, -0.08)
  { const p = tileGeo.attributes.position, uv = tileGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + 0.77) / 1.54, (p.getY(i) + 0.33) / 0.66) }
  const tiles = []
  let tileTex = null
  for (let k = -1; k <= 1; k++) {
    const mat = new THREE.MeshStandardMaterial({ color: k === 0 ? 0xffffff : 0x2a2826, roughness: 0.85, metalness: 0 })
    const m = new THREE.Mesh(tileGeo, mat)
    m.castShadow = true; m.receiveShadow = true
    m.position.set(0.25 + k * 1.3, -1.05, 0.8); m.scale.setScalar(0.72)
    story.add(m); tiles.push(m)
  }
  const chainLinks = []
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 10, 24), new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.6 }))
    m.position.set(0.25 + s * 0.65, -1.05, 0.8); m.rotation.y = Math.PI / 2; m.scale.set(0.8, 0.6, 1.3)
    m.castShadow = true
    story.add(m); chainLinks.push(m)
  }
  const sealMat = new THREE.MeshStandardMaterial({ color: 0xe0531c, roughness: 0.55, metalness: 0 })
  const seal = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.06, 40), sealMat)
  seal.rotation.x = Math.PI / 2; seal.castShadow = true
  story.add(seal)
  story.visible = false

  function ringTexture(text, color = '#ece6da') {
    return canvasTex(2048, 96, (x, w, h) => {
      x.clearRect(0, 0, w, h)
      x.fillStyle = color; x.font = `500 52px ${MONO}`; x.textBaseline = 'middle'
      const t = (text + '   ·   ').repeat(3)
      x.fillText(t, 0, h / 2)
    })
  }
  function setStoryData(d) {
    ST.data = d
    ring.material.map?.dispose(); ring.material.map = ringTexture(d.hash ? d.hash : 'keccak256(JCS(tool))'); ring.material.needsUpdate = true
    rootRing.material.map?.dispose(); rootRing.material.map = ringTexture(d.root ? d.root : 'root of this hour', '#ffd2bd'); rootRing.material.needsUpdate = true
    tileTex?.dispose()
    tileTex = canvasTex(1024, 420, (x, w, h) => {
      x.fillStyle = '#e9e2d3'; x.fillRect(0, 0, w, h)
      x.fillStyle = '#1b1a19'; x.font = `600 44px ${MONO}`; x.fillText('ROBINHOOD CHAIN', 60, 90)
      x.font = `34px ${MONO}`; x.fillStyle = '#4a453e'
      if (d.tx) { x.fillText(`epoch ${d.epoch}`, 60, 170); x.fillText(`tx ${d.tx.slice(0, 18)}…`, 60, 225); x.fillText(`root ${String(d.root || '').slice(0, 16)}…`, 60, 280) }
      else { x.fillText('next stamp', 60, 170); x.fillText(d.nextStamp || '', 60, 225) }
      x.fillStyle = '#d24a1a'; x.fillRect(60, 330, 120, 10)
    })
    tiles[1].material.map = tileTex; tiles[1].material.needsUpdate = true
  }

  // ── simulation step ───────────────────────────────────────────────────────
  let simT = 0
  const V3 = new THREE.Vector3()
  const gust = { x: 0, y: 0, z: 0, s: 0, vx: 0 }
  let grabbed = -1
  const grabT = new THREE.Vector3()
  function step(dt) {
    const P = sys.p, Q = sys.q, Wt = sys.w, n = sys.n
    simT += dt
    const t = simT
    const g = 4.2 * dt * dt
    const wA = dt * dt * (0.55 + 0.35 * Math.sin(t * 0.31) + 0.25 * Math.sin(t * 0.83 + 1))
    for (let i = 0; i < n; i++) {
      if (Wt[i] === 0) continue
      const k = i * 3, x = P[k], y = P[k + 1], z = P[k + 2]
      const isCloth = i < NCL
      let az = (Math.sin(t * 0.8 + x * 0.6 + y * 0.55) + 0.6 * Math.sin(t * 1.45 - x * 1.1 + y * 1.2) + 0.3 * Math.sin(t * 2.9 + y * 2.3 + x * 0.7)) * wA * 1.5
      let ax = Math.sin(t * 0.7 + y * 0.9) * wA * 0.12
      if (isCloth) { const R = sys.r; ax += (R[k] - x) * 10 * dt * dt; az += (R[k + 2] - z) * 0.9 * dt * dt }
      P[k] = x + (x - Q[k]) * 0.986 + ax
      P[k + 1] = y + (y - Q[k + 1]) * 0.986 - g
      P[k + 2] = z + (z - Q[k + 2]) * 0.986 + az * (isCloth ? 1 : 0.6)
      Q[k] = x; Q[k + 1] = y; Q[k + 2] = z
    }
    gust.s *= 0.93
    // kinematic roots: tassels and loose threads ride on the cloth
    const v3 = V3
    for (const ts of tassels) { clothPoint(ts.u, 1, v3); const k = ts.s0 * 3; P[k] = v3.x; P[k + 1] = v3.y + 0.01; P[k + 2] = v3.z - 0.03 }
    for (const l of loose) {
      clothPoint(l.u, l.v, v3); const k = l.s0 * 3; P[k] = v3.x; P[k + 1] = v3.y; P[k + 2] = v3.z
      if (!l.released) {
        if (simT > l.delay) { l.released = true; for (let j = 1; j < l.n; j++) Q[(l.s0 + j) * 3 + 2] -= 0.012 * (j / l.n) }
        else for (let j = 1; j < l.n; j++) { const q = (l.s0 + j) * 3; Q[q] = P[q]; Q[q + 1] = P[q + 1]; Q[q + 2] = P[q + 2] }
      }
    }
    if (grabbed >= 0) { const k = grabbed * 3; P[k] += (grabT.x - P[k]) * 0.45; P[k + 1] += (grabT.y - P[k + 1]) * 0.45; P[k + 2] += (grabT.z - P[k + 2]) * 0.45 }
    const gw = grabbed >= 0 ? Wt[grabbed] : 0
    if (grabbed >= 0) Wt[grabbed] = 0
    const it = low ? 4 : 6
    for (let s = 0; s < it; s++) {
      links.solve(sys)
      for (let c = 0; c < teth.length; c += 3) {
        const a = teth[c], b = teth[c + 1], L = teth[c + 2]
        if (Wt[a] === 0) continue
        const i = a * 3, j = b * 3
        const ex = P[i] - P[j], ey = P[i + 1] - P[j + 1], ez = P[i + 2] - P[j + 2]
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
        if (d > L) { const f = L / d; P[i] = P[j] + ex * f; P[i + 1] = P[j + 1] + ey * f; P[i + 2] = P[j + 2] + ez * f }
      }
      ropeLinks.solve(sys)
    }
    if (grabbed >= 0) Wt[grabbed] = gw
    // loose threads and tags stay in front of the cloth (cheap: local z vs the cloth near them)
    for (const l of loose) for (let j = 1; j < l.n; j++) {
      const k = (l.s0 + j) * 3
      const u = (P[k] + W / 2) / W, v = (TOP_Y - P[k + 1]) / H
      if (u < 0 || u > 1 || v < 0 || v > 1) continue
      clothPoint(u, v, v3)
      if (P[k + 2] < v3.z + 0.075) P[k + 2] = v3.z + 0.075
    }
    for (const l of loose) for (const q of [l.tA, l.tB]) {
      const k = q * 3, u = (P[k] + W / 2) / W, v = (TOP_Y - P[k + 1]) / H
      if (u < 0 || u > 1 || v < 0 || v > 1) continue
      clothPoint(u, v, v3); if (P[k + 2] < v3.z + 0.09) P[k + 2] = v3.z + 0.09
    }
  }

  const up = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpQ = new THREE.Quaternion()
  function sync() {
    computeNormals(); uploadCloth()
    const P = sys.p
    // tassels: 3 strands per rope, spreading toward the tip
    for (let k = 0; k < tassels.length; k++) {
      const s0 = tassels[k].s0
      for (let s = 0; s < 3; s++) {
        const a = ((s / 3) + hash(k)) * Math.PI * 2
        for (let p = 0; p < TP; p++) {
          const spread = 0.008 + (p / (TP - 1)) * 0.03
          const o = ((k * 3 + s) * TP + p) * 3, q = (s0 + p) * 3
          tasselTubes.src[o] = P[q] + Math.cos(a) * spread; tasselTubes.src[o + 1] = P[q + 1]; tasselTubes.src[o + 2] = P[q + 2] + Math.sin(a) * spread
        }
      }
    }
    tasselTubes.update()
    for (const l of loose) {
      l.tubes.src.set(P.subarray(l.s0 * 3, (l.s0 + l.n) * 3)); l.tubes.update()
      const e = (l.s0 + l.n - 1) * 3
      tmpA.set(P[l.tA * 3], P[l.tA * 3 + 1], P[l.tA * 3 + 2]); tmpB.set(P[l.tB * 3], P[l.tB * 3 + 1], P[l.tB * 3 + 2])
      // hairline from the thread end to the tag hole
      const end = new THREE.Vector3(P[e], P[e + 1], P[e + 2])
      l.hair.position.copy(end).add(tmpA).multiplyScalar(0.5)
      up.copy(tmpA).sub(end); const hl = up.length() || 0.01
      l.hair.scale.set(1, hl, 1); l.hair.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up.normalize())
      // the tag hangs from its hole, long side pointing down
      l.tag.position.copy(tmpA)
      up.copy(tmpA).sub(tmpB).normalize()
      tmpQ.setFromUnitVectors(new THREE.Vector3(1, 0, 0), up.clone().negate())
      l.tag.quaternion.copy(tmpQ)
      l.tag.rotateX(Math.sin(simT * 0.7 + l.s0) * 0.35 + 0.4 * l.dir)
    }
  }

  // ── camera, layout, parallax ──────────────────────────────────────────────
  let VW = 1, VH = 1, mobile = false
  const par = { x: 0, y: 0, tx: 0, ty: 0 }
  function layout(w, h, isMobile) {
    VW = w; VH = h; mobile = isMobile
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    story.scale.setScalar(mobile ? 0.72 : 1); story.position.set(mobile ? 0.35 : 0, mobile ? 1.3 : 0, 0)
    if (mobile) { target.set(0.05, 1.0, 0); camera.fov = 34 }
    else { target.set(0.0, 0.05, 0); camera.fov = 32 }
    camera.updateProjectionMatrix()
    placeCamera()
  }
  function placeCamera() {
    const yaw = -0.3 + par.x * 0.085, pitch = -0.1 + par.y * 0.06
    const D = mobile ? 10.6 : 9.4
    camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * D, target.y + Math.sin(pitch) * D, target.z + Math.cos(yaw) * Math.cos(pitch) * D)
    camera.lookAt(target)
    if (mobile) camera.clearViewOffset()
    else {
      // put the tapestry in the right ~60%: shift the frustum so the target sits at 64% of the width
      const shift = -(0.66 - 0.5) * VW
      camera.setViewOffset(VW, VH, shift, 0, VW, VH)
    }
  }

  // ── story choreography ─────────────────────────────────────────────────────
  const restPos = new THREE.Vector3(0, 0, 0)
  const sp = (p, a, b) => sstep(a, b, p)
  function storyPose(p, time) {
    const on = p > -0.05 && p < 5.2
    story.visible = on
    // tapestry backs away while the story plays in front of it
    const away = sp(p, 0, 0.8) * (1 - sp(p, 4.0, 4.7))
    tap.position.set(restPos.x + away * 2.2, restPos.y + away * 0.25, restPos.z - away * 3.4)
    uni.uDim.value = 1 - away * 0.72
    looseGroup.visible = away < 0.35
    if (!on) return
    // step 1: one thread slides out and hangs alone in front
    const s1 = sp(p, 0.05, 0.9), s2 = sp(p, 1.0, 1.85), s3 = sp(p, 2.0, 2.9), s4 = sp(p, 3.0, 3.8), s5 = sp(p, 4.0, 4.8)
    const hang = new THREE.Vector3(-0.95, 1.45, 1.9)
    const beadC = new THREE.Vector3(-0.35, 0.3, 1.7)
    const src = new THREE.Vector3(0.6, 0.9, -1.0)
    for (let k = 0; k < SP; k++) {
      const t = k / (SP - 1)
      // embedded: vertical along a column of the (receded) cloth
      const ex = src.x, ey = src.y - t * 2.2, ez = src.z
      // hanging: a soft S curve in front
      const sway = Math.sin(time * 0.9 + t * 3) * 0.04 * t
      const hx = hang.x + Math.sin(t * 5.5) * 0.12 * t + sway, hy = hang.y - t * 2.0, hz = hang.z + Math.sin(t * 3.3) * 0.15
      // coiled: wound into the bead
      const a = t * 18 * Math.PI, rr = 0.25 * Math.sqrt(1 - Math.pow(t * 2 - 1, 2) * 0.9)
      const cx = beadC.x + Math.cos(a) * rr, cy = beadC.y + (t * 2 - 1) * 0.24, cz = beadC.z + Math.sin(a) * rr
      let x = lerp(ex, hx, s1), y = lerp(ey, hy, s1), z = lerp(ez, hz, s1)
      x = lerp(x, cx, s2); y = lerp(y, cy, s2); z = lerp(z, cz, s2)
      sThread.src[k * 3] = x; sThread.src[k * 3 + 1] = y; sThread.src[k * 3 + 2] = z
    }
    sThread.update()
    sThreadMesh.visible = p < 2.1
    // step 2: the bead with its keccak ring
    bead.visible = s2 > 0.02 && p < 2.15
    bead.position.copy(beadC); bead.scale.setScalar(Math.max(0.001, s2) * 1.7); bead.rotation.y = time * 0.4 + s2 * 3
    ring.visible = s2 > 0.3 && p < 2.15
    ring.position.copy(beadC); ring.rotation.set(0.25, -time * 0.35, 0.1); ring.material.opacity = sp(p, 1.3, 1.8) * (1 - sp(p, 1.95, 2.15))
    // step 3: beads fly in and braid upward into a tree; the root glows
    for (const n of tree) {
      const delay = n.lv * 0.18
      const f = sp(p, 2.0 + delay, 2.55 + delay)
      const show = p > 1.95 && (n.lv === 3 ? p < 4.1 : p < 3.35)
      n.m.visible = show && f > 0.01
      const from = n.lv === 0 && n.i === 0 ? beadC : n.from
      n.m.position.lerpVectors(from, n.to, f)
      n.m.scale.setScalar(n.lv === 3 ? 0.75 + 0.25 * sp(p, 2.7, 2.9) : 1)
      n.m.rotation.y = time * (0.3 + n.i * 0.05)
    }
    for (const l of treeLinks) {
      const f = sp(p, 2.15 + l.lv * 0.2, 2.5 + l.lv * 0.2)
      l.m.visible = p > 1.95 && p < 3.3
      l.m.geometry.setDrawRange(0, Math.floor((l.total * f) / 3) * 3)
    }
    const root = tree[tree.length - 1]
    rootRing.visible = s3 > 0.6 && p < 3.4
    rootRing.position.copy(root.m.position); rootRing.rotation.set(0.2, -time * 0.4, 0); rootRing.material.opacity = sp(p, 2.6, 2.9) * (1 - sp(p, 3.1, 3.4))
    // step 4: the root presses onto the block tile as a seal; neighbours link like a chain
    const tileIn = sp(p, 2.95, 3.4) * (1 - sp(p, 4.05, 4.5))
    tiles.forEach((m) => { m.visible = tileIn > 0.01; m.position.y = -1.05 - (1 - tileIn) * 0.6; m.scale.setScalar(0.72 * (0.7 + 0.3 * tileIn)); m.rotation.x = -0.12 })
    chainLinks.forEach((m) => { m.visible = tileIn > 0.01; m.position.y = -1.05 - (1 - tileIn) * 0.6 })
    if (p > 3.0) {
      root.m.visible = p < 3.75 && p < 4.1
      const press = sp(p, 3.25, 3.7)
      root.m.position.lerpVectors(root.to, new THREE.Vector3(0.62, -0.98, 0.98), press)
    }
    seal.visible = s4 > 0.55 && p < 4.4
    seal.position.set(0.62, -0.98, 0.9 + 0.08 + (1 - sp(p, 3.6, 3.8)) * 0.2)
    seal.scale.set(0.62, 0.62 * (1 - 0.35 * sp(p, 3.65, 3.8)), 0.62)
    seal.rotation.set(Math.PI / 2 - 0.12, 0, 0)
    // step 5: everything clears; a new row grows at the top edge of the tapestry
    uni.uGrow.value = sp(p, 4.3, 4.95) * (p < 5.6 ? 1 : 0)
    void s5
  }

  // ── frame loop ──────────────────────────────────────────────────────────────
  let raf = 0, last = 0, acc = 0, running = false, storyP = -1, dirty = true, visible = true
  const stats = { fps: 0, frames: 0, t0: performance.now(), simMs: 0 }
  function frame(now) {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now
    if (!visible) return
    par.x += (par.tx - par.x) * 0.06; par.y += (par.ty - par.y) * 0.06
    if (!reduced) {
      const t0 = performance.now()
      acc += dt
      let n = 0
      while (acc >= 1 / 60 && n < 2) { step(1 / 60); acc -= 1 / 60; n++ }
      if (n === 2) acc = 0
      if (n) sync()
      stats.simMs = stats.simMs * 0.95 + (performance.now() - t0) * 0.05
    } else if (!dirty && Math.abs(par.tx - par.x) < 0.001) { tick(now); return }
    dirty = false
    placeCamera()
    storyPose(storyP, now / 1000)
    renderer.render(scene, camera)
    opts.onFrame && opts.onFrame()
    tick(now)
  }
  function tick(now) { stats.frames++; if (now - stats.t0 > 1000) { stats.fps = (stats.frames * 1000) / (now - stats.t0); stats.frames = 0; stats.t0 = now } }

  function settle(n) { for (const l of loose) l.released = true; const s = simT; for (let i = 0; i < n; i++) step(1 / 60); simT = s; sync() }
  settle(reduced ? 260 : 90)

  // pointer → tapestry local point on the cloth plane
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane()
  function localHit(x, y) {
    ndc.set((x / VW) * 2 - 1, -(y / VH) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    tap.updateMatrixWorld()
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(tap.quaternion)
    plane.setFromNormalAndCoplanarPoint(n, tap.position)
    const hit = new THREE.Vector3()
    if (!ray.ray.intersectPlane(plane, hit)) return null
    return tap.worldToLocal(hit)
  }
  const pv = new THREE.Vector3()
  function screenOf(i) {
    pv.set(sys.p[i * 3], sys.p[i * 3 + 1], sys.p[i * 3 + 2]); tap.localToWorld(pv); pv.project(camera)
    return { x: (pv.x * 0.5 + 0.5) * VW, y: (-pv.y * 0.5 + 0.5) * VH, z: pv.z }
  }

  return {
    renderer, scene, camera, stats, uni, get sys() { return sys },
    get loose() { return loose },
    layout, setLoose(list) { setLoose(list); if (reduced) settle(220); else sync(); dirty = true },
    setRidges(n) {
      const k = Math.max(0, Math.min(MAX_RIDGES, n))
      const arr = []
      for (let i = 0; i < MAX_RIDGES; i++) arr.push(0.12 + i * 0.098)
      uni.uRidges.value = arr; uni.uRidgeN.value = k; dirty = true
    },
    setWarp(n) { uni.uN.value = Math.max(40, Math.min(160, n || 90)); dirty = true },
    setStory(p) { if (p !== storyP) { storyP = p; dirty = true } },
    setStoryData,
    setVisible(v) { visible = v },
    pointer(x, y) { par.tx = (x / VW) * 2 - 1; par.ty = -((y / VH) * 2 - 1); dirty = true },
    gustAt(x, y, vx) {
      if (reduced) return
      const h = localHit(x, y); if (!h) return
      gust.x = h.x; gust.y = h.y; gust.s = Math.min(1.4, gust.s + 0.25); gust.vx = Math.max(-3, Math.min(3, vx / 300))
    },
    pickLoose(x, y, r = 22) {
      let best = null, bd = r * r
      for (const l of loose) for (let j = 2; j < l.n; j++) {
        const s = screenOf(l.s0 + j), d = (s.x - x) ** 2 + (s.y - y) ** 2
        if (d < bd) { bd = d; best = { l, i: l.s0 + j } }
      }
      for (const l of loose) for (const q of [l.tA, l.tB]) { const s = screenOf(q), d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd * 1.6) { bd = d; best = { l, i: q } } }
      return best
    },
    grab(i) { grabbed = i; grabT.set(sys.p[i * 3], sys.p[i * 3 + 1], sys.p[i * 3 + 2] + 0.15) },
    grabCloth(x, y) {
      const h = localHit(x, y); if (!h) return false
      const u = (h.x + W / 2) / W, v = (TOP_Y - h.y) / H
      if (u < 0 || u > 1 || v < 0.04 || v > 1) return false
      const c = Math.round(u * (SC - 1)), r = Math.max(1, Math.round(v * (SR - 1)))
      grabbed = id(c, r); grabT.set(sys.p[grabbed * 3], sys.p[grabbed * 3 + 1], sys.p[grabbed * 3 + 2] + 0.35)
      return true
    },
    drag(x, y) {
      if (grabbed < 0) return
      const h = localHit(x, y); if (!h) return
      grabT.x = h.x; grabT.y = h.y; grabT.z = Math.max(grabT.z, sys.p[grabbed * 3 + 2])
      if (grabbed < NCL) { const r = sys.r; grabT.x = r[grabbed * 3] + Math.max(-0.5, Math.min(0.5, h.x - r[grabbed * 3])); grabT.y = r[grabbed * 3 + 1] + Math.max(-0.4, Math.min(0.4, h.y - r[grabbed * 3 + 1])); grabT.z = 0.45 }
      else grabT.z = 0.55
    },
    release() { grabbed = -1 },
    get grabbing() { return grabbed >= 0 },
    // screen position of a loose thread's tag (for the DOM label)
    tagScreen(l) { return screenOf(l.tA) },
    start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame) },
    stop() { running = false; cancelAnimationFrame(raf) },
    renderOnce() { placeCamera(); storyPose(storyP, performance.now() / 1000); sync(); renderer.render(scene, camera) },
    settle,
    dispose() { cancelAnimationFrame(raf); renderer.dispose() },
  }
}

// The living tapestry: a CPU verlet cloth (woven rows = anchored epochs) hanging from the fell, warp threads (one per tracked
// item) strung from the beam, a fringe under the oldest row, and loose threads (changed items) that dangle in front.
// World units: 1 unit = 100 css px at the cloth plane (z = 0). The camera looks straight down -z and follows page scroll,
// so page px map 1:1 to the cloth and DOM labels line up with the rows.
import * as THREE from 'three'

const PX = 100
const FOV = 28
const Z_WALL = -0.08
const Z_CLOTH = -0.02
const Z_CLOTH_MIN = -0.045
const Z_WARP_FELL = -0.068

const COLORS = {
  bg: 0x111111,
  weft: 0x3a3936,
  weft2: 0x2c2b29,
  warp: 0x7a766e,
  bone: 0xd8d1c3,
  suspicious: 0xff5a1f,
  behavior: 0xc88a5a,
  cosmetic: 0xb9b2a5,
}
const LABEL_CODE = { cosmetic: 1, behavior: 2, suspicious: 3 }

// ── particle system ────────────────────────────────────────────────────────
export class Sys {
  constructor(n) {
    this.n = 0
    this.p = new Float32Array(n * 3)
    this.q = new Float32Array(n * 3) // previous
    this.w = new Float32Array(n) // inverse mass (0 = pinned / kinematic)
    this.r = new Float32Array(n * 3) // rest
    this.zmin = new Float32Array(n).fill(Z_WALL)
  }
  add(x, y, z, w = 1, zmin = Z_WALL) {
    const i = this.n++, k = i * 3
    this.zmin[i] = zmin
    this.p[k] = this.q[k] = this.r[k] = x
    this.p[k + 1] = this.q[k + 1] = this.r[k + 1] = y
    this.p[k + 2] = this.q[k + 2] = this.r[k + 2] = z
    this.w[i] = w
    return i
  }
}
export class Links {
  constructor() { this.a = []; this.b = []; this.l = []; this.s = [] }
  add(sys, a, b, s = 1, scale = 1) {
    const P = sys.p, i = a * 3, j = b * 3
    this.a.push(a); this.b.push(b); this.s.push(s)
    this.l.push(Math.hypot(P[i] - P[j], P[i + 1] - P[j + 1], P[i + 2] - P[j + 2]) * scale)
  }
  addRest(a, b, l, s = 1) { this.a.push(a); this.b.push(b); this.l.push(l); this.s.push(s) }
  freeze() { this.a = Int32Array.from(this.a); this.b = Int32Array.from(this.b); this.l = Float32Array.from(this.l); this.s = Float32Array.from(this.s) }
  solve(sys) {
    const P = sys.p, W = sys.w, A = this.a, B = this.b, L = this.l, S = this.s
    for (let c = 0, n = A.length; c < n; c++) {
      const a = A[c], b = B[c], wa = W[a], wb = W[b], ws = wa + wb
      if (ws === 0) continue
      const i = a * 3, j = b * 3
      const dx = P[j] - P[i], dy = P[j + 1] - P[i + 1], dz = P[j + 2] - P[i + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6
      const k = ((d - L[c]) / (d * ws)) * S[c]
      P[i] += dx * k * wa; P[i + 1] += dy * k * wa; P[i + 2] += dz * k * wa
      P[j] -= dx * k * wb; P[j + 1] -= dy * k * wb; P[j + 2] -= dz * k * wb
    }
  }
}

// ── tube geometry for threads (rings around a polyline) ──────────────────────
export class Tubes {
  constructor(count, pts, radial, radius) {
    this.count = count; this.pts = pts; this.radial = radial; this.radius = radius
    const nv = count * pts * radial
    this.src = new Float32Array(count * pts * 3)
    this.rad = new Float32Array(count * pts).fill(1)
    this.geo = new THREE.BufferGeometry()
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.nor = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage)
    const uv = new Float32Array(nv * 2), idx = []
    for (let t = 0; t < count; t++) for (let k = 0; k < pts; k++) for (let r = 0; r < radial; r++) {
      const v = (t * pts + k) * radial + r
      uv[v * 2] = k; uv[v * 2 + 1] = t + r / radial
      if (k < pts - 1) {
        const r2 = (r + 1) % radial, a = v, b = (t * pts + k) * radial + r2, c = (t * pts + k + 1) * radial + r, d = (t * pts + k + 1) * radial + r2
        idx.push(a, c, b, b, c, d)
      }
    }
    this.geo.setAttribute('position', this.pos)
    this.geo.setAttribute('normal', this.nor)
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    this.geo.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
  }
  update() {
    const S = this.src, P = this.pos.array, N = this.nor.array, R = this.radial, n = this.pts
    for (let t = 0; t < this.count; t++) {
      for (let k = 0; k < n; k++) {
        const i = (t * n + k) * 3
        const a = (t * n + Math.max(0, k - 1)) * 3, b = (t * n + Math.min(n - 1, k + 1)) * 3
        let tx = S[b] - S[a], ty = S[b + 1] - S[a + 1], tz = S[b + 2] - S[a + 2]
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl
        // side = t × z, up = side × t
        let sx = ty, sy = -tx, sz = 0
        let sl = Math.hypot(sx, sy)
        if (sl < 1e-4) { sx = 1; sy = 0; sl = 1 }
        sx /= sl; sy /= sl
        const ux = sy * tz - sz * ty, uy = sz * tx - sx * tz, uz = sx * ty - sy * tx
        const rad = this.radius * this.rad[t * n + k]
        for (let r = 0; r < R; r++) {
          const ang = ((r + 0.5) / R) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang)
          const nx = sx * c + ux * s, ny = sy * c + uy * s, nz = sz * c + uz * s
          const v = ((t * n + k) * R + r) * 3
          P[v] = S[i] + nx * rad; P[v + 1] = S[i + 1] + ny * rad; P[v + 2] = S[i + 2] + nz * rad
          N[v] = nx; N[v + 1] = ny; N[v + 2] = nz
        }
      }
    }
    this.pos.needsUpdate = true; this.nor.needsUpdate = true
  }
}

// yarn look on tubes: ply twist stripes + fuzz sheen; emissive for loose threads
export function yarnMaterial(color, { emissive = 0, twist = 2.2, rough = 1, flat = 0 } = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, emissive: new THREE.Color(color).multiplyScalar(emissive) })
  m.defines = { USE_UV: '' }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTwist = { value: twist }
    sh.uniforms.uFlat = { value: flat }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTwist, uFlat;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, vec3(0.0, 0.0, 1.0), uFlat));')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 0.72 + 0.56 * fract(sin(floor(vUv.y) * 91.7) * 4375.85);
        if (uTwist > 0.0) {
          float ply = sin((vUv.x * uTwist + vUv.y * 2.0) * 6.2831);
          diffuseColor.rgb *= 0.78 + 0.22 * smoothstep(-0.6, 0.9, ply);
        }`)
      .replace('#include <opaque_fragment>', `
        float fz = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.5);
        outgoingLight += diffuseColor.rgb * fz * 0.35;
        #include <opaque_fragment>`)
  }
  return m
}

// woven cloth: procedural plain weave (weft-faced), per-cell status (pulled / kinked threads), pending row being woven
export function clothMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide })
  m.defines = { USE_UV: '' }
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uWarpN, uPicks, uRowH, uPPR, uProgress, uClothW, uAA, uRows, uPend, uUnravel, uClothH;
        uniform vec3 cWeft, cWeft2, cWarp, cBone, cSus, cBeh;
        uniform sampler2D uStatus;
        float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        // height + which yarn is on top (x: height, y: 1 = warp on top)
        vec2 weave(vec2 c, float pulled, float kink) {
          c.y += 0.16 * sin(c.x * 0.37 + floor(c.y) * 1.7) + 0.08 * sin(c.x * 1.9 + floor(c.y) * 0.3);
          c.x += 0.12 * sin(c.y * 0.53 + floor(c.x) * 2.3);
          float wi = floor(c.x), pj = floor(c.y);
          vec2 f = fract(c);
          f.x += kink * 0.35 * sin(f.y * 3.1416 * 2.0);
          float zw = 0.5 * cos(3.1416 * (c.y - 0.5 + wi));
          float zf = -0.5 * cos(3.1416 * (c.x - 0.5 + pj));
          float dw = (f.x - 0.5) / 0.36;
          float df = (f.y - 0.5) / 0.56;
          float hw = (1.0 - pulled) * (sqrt(max(0.0, 1.0 - dw * dw)) * 0.8 + zw * 0.5) - pulled * 2.0;
          float hf = sqrt(max(0.0, 1.0 - df * df)) * 1.05 + zf * 0.4;
          float lo = -0.5;
          float hgt = max(max(hw, hf), lo);
          return vec2(hgt, hw > hf ? 1.0 : 0.0);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float rowF = vUv.y / uRowH;
        int row = min(int(floor(rowF)), int(uRows) - 1);
        float inRow = fract(rowF) * uPPR;          // pick index inside the row, 0 at the row top
        vec2 cw = vec2(vUv.x * uWarpN, vUv.y * uPicks);
        int wi = int(floor(cw.x));
        vec4 st = texelFetch(uStatus, ivec2(clamp(wi, 0, int(uWarpN * uClothW + 0.5) - 1), row), 0);
        float code = floor(st.r * 255.0 + 0.5);
        float cellY = fract(rowF);
        float pulled = code >= 2.0 ? smoothstep(0.15, 0.3, cellY) : 0.0;
        float kink = code == 1.0 ? 1.0 : 0.0;
        // pending row (row 0): picks laid bottom-up, the current pick crosses the width (shuttle)
        if (uUnravel > 0.0 && vUv.y > uClothH * (1.0 - uUnravel) + 0.04 * sin(vUv.x * 40.0)) discard;
        if (row == 0 && uPend > 0.5) {
          float fromBottom = uPPR - 1.0 - floor(inRow);
          float done = floor(uProgress * uPPR);
          float sx = fract(uProgress * uPPR);
          float xr = vUv.x / uClothW;
          if (mod(done, 2.0) > 0.5) xr = 1.0 - xr;
          if (fromBottom > done || (fromBottom == done && xr > sx)) discard;
        }
        vec2 W0 = weave(cw, pulled, kink);
        float aa = clamp(2.0 - max(fwidth(cw.x), fwidth(cw.y)) * 4.0, 0.2, 1.0);
        float pj = floor(cw.y);
        float lot = 0.86 + 0.28 * h12(vec2(float(row), 3.7));
        vec3 weftC = mix(cWeft2, cWeft, h12(vec2(pj, 1.3))) * lot;
        weftC *= 0.85 + 0.3 * (0.5 + 0.5 * sin(vUv.x * 3.1 + vUv.y * 1.3) * sin(vUv.x * 1.3 - vUv.y * 2.2));
        weftC *= 0.9 + 0.2 * h12(vec2(floor(cw.x * 2.0), pj)) * aa;
        if (floor(inRow) < 0.5) weftC *= 0.62;                       // seam between epochs
        if (st.g > 0.5 && floor(inRow) >= 1.0 && floor(inRow) < 2.5) weftC = cBone * (0.8 + 0.2 * h12(vec2(pj, 9.1)));  // 00:00 UTC
        vec3 warpC = cWarp * (0.8 + 0.4 * h12(vec2(float(wi), 7.1)));
        vec3 col = mix(weftC, warpC, W0.y);
        // around a pulled thread: fibres of its label colour + a dark gap
        if (code >= 2.0) {
          float fx = abs(fract(cw.x) - 0.5);
          vec3 lc = code >= 3.0 ? cSus : cBeh;
          col = mix(col, lc * 0.7, (1.0 - smoothstep(0.0, 1.4, fx * 2.0)) * smoothstep(0.1, 0.32, cellY) * (1.0 - smoothstep(0.55, 0.95, cellY)) * 0.45);
        }
        float shade = mix(0.62, 1.0, smoothstep(-0.5, 0.8, W0.x));
        diffuseColor.rgb = col * mix(1.0, shade, aa);
        float wHeight = W0.x;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float e = 0.07;
          float h0 = W0.x;
          float hx = weave(cw + vec2(e, 0.0), pulled, kink).x;
          float hy = weave(cw + vec2(0.0, e), pulled, kink).x;
          float A = 0.5 / uWarpN;
          vec3 mapN = normalize(vec3(-(hx - h0) / e * uWarpN * A * aa, -(hy - h0) / e * uPicks * A * aa, 1.0));
          vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
          vec2 s0 = dFdx(vUv), s1 = dFdy(vUv);
          vec3 N0 = normal;
          vec3 q1p = cross(q1, N0), q0p = cross(N0, q0);
          vec3 T = q1p * s0.x + q0p * s1.x, B = q1p * s0.y + q0p * s1.y;
          float det = max(dot(T, T), dot(B, B));
          float sc = det == 0.0 ? 0.0 : inversesqrt(det);
          normal = normalize(mat3(T * sc, B * sc, N0) * mapN);
        }`)
      .replace('#include <opaque_fragment>', `
        float fz = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        outgoingLight += diffuseColor.rgb * fz * 0.9;
        #include <opaque_fragment>`)
  }
  return m
}

export function webglOk() {
  try {
    const c = document.createElement('canvas')
    return !!c.getContext('webgl2')
  } catch { return false }
}

export function createTapestry(canvas, opts = {}) {
  const tier = opts.tier || 'high'
  const reduced = !!opts.reduced
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier === 'high', alpha: false, powerPreference: 'default' })
  renderer.setClearColor(COLORS.bg, 1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  const shadows = tier !== 'low'
  renderer.shadowMap.enabled = shadows
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 200)
  const hemi = new THREE.HemisphereLight(0xcfd2d6, 0x1a1816, 0.32)
  scene.add(hemi)
  const key = new THREE.DirectionalLight(0xfff3e4, 4.4)
  key.castShadow = shadows
  key.shadow.mapSize.set(tier === 'high' ? 2048 : 1024, tier === 'high' ? 2048 : 1024)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.01
  key.shadow.radius = 3
  scene.add(key, key.target)
  const rim = new THREE.DirectionalLight(0xb8c4d6, 0.35)
  scene.add(rim, rim.target)

  // wall behind the cloth: only shows shadows
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.55 }))
  wall.position.z = Z_WALL - 0.01
  wall.receiveShadow = true
  scene.add(wall)

  const uni = {
    uPend: { value: 1 }, uUnravel: { value: 0 }, uClothH: { value: 1 }, uRows: { value: 1 }, uWarpN: { value: 1 }, uPicks: { value: 1 }, uRowH: { value: 1 }, uPPR: { value: 10 }, uProgress: { value: 0.5 }, uClothW: { value: 1 }, uAA: { value: 1 },
    cWeft: { value: new THREE.Color(COLORS.weft) }, cWeft2: { value: new THREE.Color(COLORS.weft2) }, cWarp: { value: new THREE.Color(COLORS.warp) },
    cBone: { value: new THREE.Color(COLORS.bone) }, cSus: { value: new THREE.Color(COLORS.suspicious) }, cBeh: { value: new THREE.Color(COLORS.behavior) },
    uStatus: { value: null },
  }
  const clothMat = clothMaterial(uni)
  const warpMat = yarnMaterial(COLORS.warp, { twist: 0, flat: 0.4 })
  const looseMats = {
    suspicious: yarnMaterial(COLORS.suspicious, { emissive: 0.55, twist: 0.6 }),
    behavior: yarnMaterial(COLORS.behavior, { emissive: 0.18, twist: 0.6 }),
    cosmetic: yarnMaterial(COLORS.cosmetic, { emissive: 0.0, twist: 0.6 }),
  }

  let W = 1, H = 1, D = 10
  let L = null, data = null
  let sys, clothLinks, chainLinks, looseLinks, tethers
  let cloth = null // { cols, rows, start, dx, dy, x0, y0 }
  let warp = null, fringe = null, loose = []
  let meshes = []
  let clothGeo = null
  let grabbed = -1, grabTarget = new THREE.Vector3(), grabKind = null
  let wake = null
  let scrollKick = 0
  let lastScroll = 0
  let simTime = 0
  let running = false, raf = 0, tLast = 0, acc = 0
  let visible = true, wasVisible = true
  const tmp = new THREE.Vector3()
  const stats = { fps: 0, frames: 0, t0: performance.now(), simMs: 0 }

  function disposeScene() {
    for (const m of meshes) { scene.remove(m); m.geometry.dispose() }
    meshes = []
    if (uni.uStatus.value) uni.uStatus.value.dispose()
  }

  function build() {
    disposeScene()
    if (!L || !data) return
    const N = Math.max(1, data.threads)
    const rows = data.rows.length
    const wx = (px) => (px - W / 2) / PX
    const wy = (py) => -py / PX
    const x0 = wx(L.clothL), x1 = wx(L.clothR)
    const width = x1 - x0
    const spacing = width / N
    const rowH = L.pitch / PX
    const ppr = L.picks || 10
    const SR = L.simRowsPerEpoch || 2
    sys = new Sys(200000)
    clothLinks = new Links(); chainLinks = new Links(); looseLinks = new Links()
    tethers = []

    // ── cloth grid ──
    const cols = Math.max(6, Math.round(width / (L.cell / PX)) + 1)
    const nr = Math.max(1, rows) * SR + 1
    const dx = width / (cols - 1), dy = rowH / SR
    const yTop = wy(L.fellY)
    const start = sys.n
    for (let r = 0; r < nr; r++) for (let c = 0; c < cols; c++) sys.add(x0 + c * dx, yTop - r * dy, Z_CLOTH, r === 0 ? 0 : 1, Z_CLOTH_MIN)
    const id = (c, r) => start + r * cols + c
    for (let r = 0; r < nr; r++) for (let c = 0; c < cols; c++) {
      if (c < cols - 1) clothLinks.add(sys, id(c, r), id(c + 1, r), 1)
      if (r < nr - 1) clothLinks.add(sys, id(c, r), id(c, r + 1), 1)
      if (c < cols - 1 && r < nr - 1) { clothLinks.add(sys, id(c, r), id(c + 1, r + 1), 0.6); clothLinks.add(sys, id(c + 1, r), id(c, r + 1), 0.6) }
      if (c < cols - 2) clothLinks.add(sys, id(c, r), id(c + 2, r), 0.35)
      if (r < nr - 2) clothLinks.add(sys, id(c, r), id(c, r + 2), 0.35)
      if (r > 0) tethers.push(id(c, r), id(c, 0), r * dy)
    }
    cloth = { cols, rows: nr, start, dx, dy, x0, yTop, width, rowH, N, spacing }

    // cloth mesh (uv in world units: u across from the left edge, v down from the fell)
    clothGeo = new THREE.BufferGeometry()
    const cpos = new Float32Array(cols * nr * 3), cuv = new Float32Array(cols * nr * 2), cidx = []
    for (let r = 0; r < nr; r++) for (let c = 0; c < cols; c++) {
      const v = r * cols + c
      cuv[v * 2] = c * dx; cuv[v * 2 + 1] = r * dy
      if (c < cols - 1 && r < nr - 1) cidx.push(v, v + cols, v + 1, v + 1, v + cols, v + cols + 1)
    }
    clothGeo.setAttribute('position', new THREE.BufferAttribute(cpos, 3).setUsage(THREE.DynamicDrawUsage))
    clothGeo.setAttribute('uv', new THREE.BufferAttribute(cuv, 2))
    clothGeo.setIndex(cidx)
    clothGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
    const clothMesh = new THREE.Mesh(clothGeo, clothMat)
    clothMesh.receiveShadow = shadows
    meshes.push(clothMesh)

    // status texture: N × rows, r = label code, g = 00:00 UTC row
    const tex = new Uint8Array(N * Math.max(1, rows) * 4)
    data.rows.forEach((row, r) => { if (row.day) for (let c = 0; c < N; c++) tex[(r * N + c) * 4 + 1] = 255 })
    for (const cell of data.cells) {
      if (cell.col < 0 || cell.col >= N || cell.row < 0 || cell.row >= rows) continue
      const k = (cell.row * N + cell.col) * 4
      tex[k] = Math.max(tex[k], LABEL_CODE[cell.label] || 0)
    }
    const st = new THREE.DataTexture(tex, N, Math.max(1, rows), THREE.RGBAFormat)
    st.needsUpdate = true
    uni.uStatus.value = st
    uni.uRows.value = Math.max(1, rows)
    uni.uWarpN.value = N / width
    uni.uClothW.value = width
    uni.uRowH.value = rowH
    uni.uPPR.value = ppr
    uni.uPicks.value = ppr / rowH

    // ── warp threads: beam → bottom of the pending row, one per tracked item ──
    const beamY = wy(L.beamY)
    const fellBottom = yTop - (rows > 0 ? rowH : 0)
    const WP = tier === 'low' ? 12 : 16
    const wstart = sys.n
    for (let t = 0; t < N; t++) {
      const x = x0 + (t + 0.5) * spacing
      for (let k = 0; k < WP; k++) {
        const y = beamY + (fellBottom - beamY) * (k / (WP - 1))
        sys.add(x, y, Z_CLOTH + (Z_WARP_FELL - Z_CLOTH) * (k / (WP - 1)), k === 0 || k === WP - 1 ? 0 : 1)
        if (k > 0) chainLinks.add(sys, sys.n - 2, sys.n - 1, 1)
      }
    }
    warp = { start: wstart, count: N, pts: WP, tubes: new Tubes(N, WP, 4, Math.min(0.014, spacing * 0.34)) }
    const warpMesh = new THREE.Mesh(warp.tubes.geo, warpMat)
    warpMesh.castShadow = shadows
    meshes.push(warpMesh)

    // ── fringe under the oldest row ──
    const FP = 7
    const fstart = sys.n
    const fl = (L.fringe || 90) / PX
    const yBot = yTop - (nr - 1) * dy
    for (let t = 0; t < N; t++) {
      const x = x0 + (t + 0.5) * spacing
      const len = fl * (0.8 + 0.4 * hash(t * 3.1))
      for (let k = 0; k < FP; k++) {
        sys.add(x, yBot - len * (k / (FP - 1)), Z_CLOTH, k === 0 ? 0 : 1)
        if (k > 0) chainLinks.add(sys, sys.n - 2, sys.n - 1, 1)
        if (k > 1) chainLinks.add(sys, sys.n - 3, sys.n - 1, 0.25)
      }
    }
    fringe = { start: fstart, count: N, pts: FP, tubes: new Tubes(N, FP, 3, Math.min(0.012, spacing * 0.36)) }
    const fringeMesh = new THREE.Mesh(fringe.tubes.geo, warpMat)
    fringeMesh.castShadow = shadows
    meshes.push(fringeMesh)

    // ── loose threads ──
    loose = []
    const KP = tier === 'low' ? 14 : 20
    const byLabel = { suspicious: [], behavior: [], cosmetic: [] }
    data.loose.forEach((lt, i) => {
      if (lt.col < 0 || lt.col >= N || lt.row < 0 || lt.row >= Math.max(1, rows)) return
      const u = (lt.col + 0.5) * spacing
      const v = (lt.row + 0.3) * rowH
      const len = (lt.label === 'suspicious' ? 1.9 : lt.label === 'behavior' ? 1.35 : 0.3) * (0.8 + 0.4 * hash(i * 7.7))
      const s0 = sys.n
      const dir = hash(i * 2.3) > 0.5 ? 1 : -1
      // rest shape: a kinked yarn hanging from its root (loose helix + drift), kept by i→i+2 / i→i+3 links
      const curl = (lt.label === 'cosmetic' ? 0.025 : 0.04 + 0.035 * len) * (0.85 + 0.3 * hash(i * 5.1))
      const turns = len * (0.9 + 0.9 * hash(i * 9.3)) + 0.6, ph = hash(i * 1.7) * 6.28
      const shape = []
      for (let k = 0; k < KP; k++) {
        const t = k / (KP - 1), a = t * turns * 6.283 + ph
        shape.push([dir * (curl * Math.sin(a) * Math.min(1, t * 4) + t * t * 0.12), -t * len, curl * (1 - Math.cos(a)) * 0.8 * Math.min(1, t * 4) + t * 0.06])
      }
      const rootX = x0 + u, rootY = yTop - v
      for (let k = 0; k < KP; k++) {
        // starts flattened into its column of the weave, then curls out once released
        sys.add(rootX + shape[k][0] * 0.15, rootY + shape[k][1], Z_CLOTH + 0.01, k === 0 ? 0 : 1)
      }
      const d3 = (a, b) => Math.hypot(shape[a][0] - shape[b][0], shape[a][1] - shape[b][1], shape[a][2] - shape[b][2])
      for (let k = 1; k < KP; k++) {
        looseLinks.addRest(s0 + k - 1, s0 + k, d3(k - 1, k), 1)
        if (k > 1) looseLinks.addRest(s0 + k - 2, s0 + k, d3(k - 2, k), 0.85)
        if (k > 2) looseLinks.addRest(s0 + k - 3, s0 + k, d3(k - 3, k), 0.5)
        if (k > 4) looseLinks.addRest(s0 + k - 5, s0 + k, d3(k - 5, k), 0.25)
      }
      const seg = d3(0, 1)
      const rec = { ...lt, start: s0, pts: KP, u, v, len, seg, dir, mesh: null, slot: byLabel[lt.label].length, delay: 0.25 + i * 0.09 + (lt.row * 0.05), released: false }
      byLabel[lt.label].push(rec)
      loose.push(rec)
    })
    for (const [label, list] of Object.entries(byLabel)) {
      if (!list.length) continue
      const r = label === 'cosmetic' ? Math.min(0.012, spacing * 0.42) : Math.max(0.016, Math.min(0.024, spacing * 0.75))
      const tubes = new Tubes(list.length, KP + 6, tier === 'low' ? 4 : 6, r)
      // frayed tips: thinner toward the end
      for (let t = 0; t < list.length; t++) for (let k = 0; k < KP + 6; k++) tubes.rad[t * (KP + 6) + k] = k < KP ? 1 - Math.max(0, (k - KP * 0.7) / KP) * 0.9 : 0.42
      const mesh = new THREE.Mesh(tubes.geo, looseMats[label])
      mesh.castShadow = shadows
      meshes.push(mesh)
      for (const rec of list) rec.group = { tubes, label }
    }
    clothLinks.freeze(); chainLinks.freeze(); looseLinks.freeze()
    tethers = Float32Array.from(tethers)
    for (const m of meshes) scene.add(m)

    // ease loose threads out of the weave: settle them at once when motion is reduced
    if (reduced || opts.settle) { releaseAll(); for (let i = 0; i < 240; i++) step(1 / 60, true) }
    syncMeshes()
  }

  function hash(x) { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s) }

  function releaseAll() { for (const lt of loose) release(lt) }
  function release(lt) {
    if (lt.released) return
    lt.released = true
    const P = sys.p, Q = sys.q
    for (let k = 1; k < lt.pts; k++) {
      const i = (lt.start + k) * 3
      Q[i + 2] = P[i + 2] - 0.02 * (k / lt.pts)       // pop outward
    }
  }

  // cloth position at fractional grid coordinates (bilinear)
  function clothAt(u, v, out) {
    const c = Math.max(0, Math.min(cloth.cols - 1.001, u / cloth.dx)), r = Math.max(0, Math.min(cloth.rows - 1.001, v / cloth.dy))
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0
    const P = sys.p, s = cloth.start, cols = cloth.cols
    const i00 = (s + r0 * cols + c0) * 3, i10 = i00 + 3, i01 = i00 + cols * 3, i11 = i01 + 3
    for (let a = 0; a < 3; a++) out[a] = (P[i00 + a] * (1 - fc) + P[i10 + a] * fc) * (1 - fr) + (P[i01 + a] * (1 - fc) + P[i11 + a] * fc) * fr
    return out
  }
  const cTmp = [0, 0, 0]

  function step(dt, silent) {
    const P = sys.p, Q = sys.q, Wt = sys.w
    simTime += dt
    const t = simTime
    const g = 5.5 * dt * dt
    const damp = 0.975
    const n = sys.n
    const windA = (0.22 + 0.12 * Math.sin(t * 0.23)) * dt * dt
    const cs = cloth.start, ce = cs + cloth.cols * cloth.rows
    for (let i = 0; i < n; i++) {
      if (Wt[i] === 0) continue
      const k = i * 3
      const x = P[k], y = P[k + 1], z = P[k + 2]
      let ax = 0, ay = -g, az = -g * 0.09
      const wind = Math.sin(t * 0.9 + x * 1.3 + y * 0.45) + 0.6 * Math.sin(t * 1.7 - x * 2.1 + y * 1.1) + 0.3 * Math.sin(t * 3.1 + y * 2.7)
      if (i >= cs && i < ce) az += wind * windA * 0.8 + scrollKick * dt * dt * Math.sin(y * 1.7 + x * 0.6)
      else az += wind * windA * 1.2
      P[k] = x + (x - Q[k]) * damp + ax
      P[k + 1] = y + (y - Q[k + 1]) * damp + ay
      P[k + 2] = z + (z - Q[k + 2]) * damp + az
      Q[k] = x; Q[k + 1] = y; Q[k + 2] = z
    }
    // pointer wake: brush through threads and cloth
    if (wake && wake.age < 0.25) {
      const R2 = wake.r * wake.r
      for (let i = 0; i < n; i++) {
        if (Wt[i] === 0) continue
        const k = i * 3
        const ddx = P[k] - wake.x, ddy = P[k + 1] - wake.y
        const d2 = ddx * ddx + ddy * ddy
        if (d2 > R2) continue
        const f = (1 - d2 / R2) * (1 - wake.age * 4)
        const isCloth = i >= cs && i < ce
        P[k] += wake.vx * dt * f * (isCloth ? 0.05 : 0.28)
        P[k + 2] += Math.min(0.03, Math.hypot(wake.vx, wake.vy) * dt * f * (isCloth ? 0.15 : 0.25))
      }
      wake.age += dt
    }
    // kinematic attachments: loose roots + fringe tops follow the cloth
    for (const lt of loose) {
      clothAt(lt.u, lt.v, cTmp)
      const i = lt.start * 3
      P[i] = cTmp[0]; P[i + 1] = cTmp[1]; P[i + 2] = cTmp[2] + 0.012
      if (lt.released && grabbed !== lt.start + 1) { const j = i + 3; P[j] += (cTmp[0] - P[j]) * 0.5; P[j + 1] += (cTmp[1] - lt.seg * 0.55 - P[j + 1]) * 0.5; P[j + 2] += (cTmp[2] + lt.seg * 0.8 - P[j + 2]) * 0.5 }
      if (!lt.released && simTime > lt.delay) release(lt)
      if (!lt.released) for (let k = 1; k < lt.pts; k++) { const j = (lt.start + k) * 3; Q[j] = P[j]; Q[j + 1] = P[j + 1]; Q[j + 2] = P[j + 2] }
    }
    const yBotV = (cloth.rows - 1) * cloth.dy
    for (let tt = 0; tt < fringe.count; tt++) {
      clothAt((tt + 0.5) * cloth.spacing, yBotV, cTmp)
      const i = (fringe.start + tt * fringe.pts) * 3
      P[i] = cTmp[0]; P[i + 1] = cTmp[1]; P[i + 2] = cTmp[2]
    }
    if (grabbed >= 0) {
      const k = grabbed * 3
      P[k] += (grabTarget.x - P[k]) * 0.5; P[k + 1] += (grabTarget.y - P[k + 1]) * 0.5; P[k + 2] += (grabTarget.z - P[k + 2]) * 0.5
    }
    const gw = grabbed >= 0 ? Wt[grabbed] : 0
    if (grabbed >= 0) Wt[grabbed] = 0
    const iters = tier === 'low' ? 3 : 4
    for (let it = 0; it < iters; it++) {
      clothLinks.solve(sys)
      // long range attachments: no particle drifts further from the fell than its rest length
      for (let c = 0; c < tethers.length; c += 3) {
        const a = tethers[c], b = tethers[c + 1], maxL = tethers[c + 2]
        if (Wt[a] === 0) continue
        const i = a * 3, j = b * 3
        const ddx = P[i] - P[j], ddy = P[i + 1] - P[j + 1], ddz = P[i + 2] - P[j + 2]
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
        if (d > maxL) { const s = maxL / d; P[i] = P[j] + ddx * s; P[i + 1] = P[j + 1] + ddy * s; P[i + 2] = P[j + 2] + ddz * s }
      }
      chainLinks.solve(sys)
      looseLinks.solve(sys)
    }
    if (grabbed >= 0) Wt[grabbed] = gw
    // collisions: the wall, and loose threads stay in front of the cloth
    const ZM = sys.zmin
    for (let i = 0; i < n; i++) { const k = i * 3 + 2; if (P[k] < ZM[i]) P[k] = ZM[i] }
    for (const lt of loose) {
      for (let k = 1; k < lt.pts; k++) {
        const i = (lt.start + k) * 3
        const u = P[i] - cloth.x0, v = cloth.yTop - P[i + 1]
        if (u < 0 || u > cloth.width || v < 0 || v > yBotV) continue
        clothAt(u, v, cTmp)
        const zmin = cTmp[2] + 0.018
        if (P[i + 2] < zmin) P[i + 2] = zmin
      }
    }
    scrollKick *= 0.9
    if (!silent) stats.simSteps = (stats.simSteps || 0) + 1
  }

  function syncMeshes() {
    const P = sys.p
    const cp = clothGeo.attributes.position.array
    cp.set(P.subarray(cloth.start * 3, (cloth.start + cloth.cols * cloth.rows) * 3))
    clothGeo.attributes.position.needsUpdate = true
    clothGeo.computeVertexNormals()
    warp.tubes.src.set(P.subarray(warp.start * 3, (warp.start + warp.count * warp.pts) * 3)); warp.tubes.update()
    fringe.tubes.src.set(P.subarray(fringe.start * 3, (fringe.start + fringe.count * fringe.pts) * 3)); fringe.tubes.update()
    const groups = new Set()
    for (const lt of loose) {
      const T = lt.group.tubes, n = T.pts, base = lt.slot * n * 3, KP = lt.pts
      T.src.set(P.subarray(lt.start * 3, (lt.start + KP) * 3), base)
      // frayed tip: 6 extra points fan out from the last segment as loose plies
      const e = (lt.start + KP - 1) * 3, e0 = (lt.start + KP - 2) * 3
      const tx = P[e] - P[e0], ty = P[e + 1] - P[e0 + 1]
      for (let k = 0; k < 6; k++) {
        const s = (k + 1) / 6, ply = k % 3 - 1
        const o = base + (KP + k) * 3
        T.src[o] = P[e] + tx * s * 1.6 + ply * 0.018 * s * (lt.label === 'cosmetic' ? 0.5 : 1) - ty * 0.2 * s
        T.src[o + 1] = P[e + 1] + ty * s * 1.6 + Math.abs(ply) * 0.006 * s
        T.src[o + 2] = P[e + 2] + 0.006 * s
      }
      groups.add(T)
    }
    for (const T of groups) T.update()
  }

  function resize(w, h) {
    W = w; H = h
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    D = (h / PX / 2) / Math.tan((FOV * Math.PI) / 360)
    camera.position.z = D
    camera.far = D + 50
    camera.updateProjectionMatrix()
  }

  function placeCamera(scrollY) {
    const cy = -(scrollY + H / 2) / PX
    camera.position.set(0, cy, D)
    camera.lookAt(0, cy, 0)
    // raking key from the upper left, shadow frustum follows the view
    key.position.set(-7 * 2.4, cy + 3.2 * 2.4, 2.6 * 2.4)
    key.target.position.set(0, cy, 0)
    rim.position.set(6, cy - 2, 3); rim.target.position.set(0, cy, 0)
    const sc = key.shadow.camera
    const ext = Math.max(W, H) / PX / 2 + 1.5
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext
    sc.near = 1; sc.far = 60
    sc.updateProjectionMatrix()
  }

  // visible page band [top, bottom] of the tapestry in px
  function tapestryBand() {
    if (!L || !cloth) return [0, 0]
    return [Math.min(L.beamY, L.fellY) - 40, L.fellY + (cloth.rows - 1) * cloth.dy * PX + (L.fringe || 90) + 60]
  }

  function frame(now) {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.05, (now - tLast) / 1000 || 0.016)
    tLast = now
    const sy = opts.getScroll ? opts.getScroll() : scrollY
    const [b0, b1] = tapestryBand()
    visible = sy + H > b0 && sy < b1
    const sv = sy - lastScroll
    lastScroll = sy
    if (!visible && wasVisible) opts.onHide && opts.onHide()
    wasVisible = visible
    if (!visible || !sys) return
    if (!reduced) {
      scrollKick += Math.max(-40, Math.min(40, sv)) * 0.02
      acc += dt
      const t0 = performance.now()
      let steps = 0
      while (acc >= 1 / 60 && steps < 2) { step(1 / 60); acc -= 1 / 60; steps++ }
      if (steps === 2) acc = 0
      if (steps) syncMeshes()
      stats.simMs = stats.simMs * 0.95 + (performance.now() - t0) * 0.05
    } else if (sv === 0 && stats.frames > 2 && !dirty) { tickStats(now); return }
    dirty = false
    uni.uProgress.value = opts.progress ? opts.progress() : 0.5
    placeCamera(sy)
    renderer.render(scene, camera)
    opts.onFrame && opts.onFrame(api)
    tickStats(now)
  }
  let dirty = true
  function tickStats(now) {
    stats.frames++
    if (now - stats.t0 > 1000) { stats.fps = (stats.frames * 1000) / (now - stats.t0); stats.frames = 0; stats.t0 = now }
  }

  // ── public API ──
  const api = {
    renderer, scene, camera, stats,
    get loose() { return loose },
    get visible() { return visible },
    setLayout(layout) { L = layout; resize(layout.W, layout.H); build(); dirty = true },
    setData(d) { data = d; build(); dirty = true },
    start() { if (running) return; running = true; tLast = performance.now(); raf = requestAnimationFrame(frame) },
    stop() { running = false; cancelAnimationFrame(raf) },
    renderOnce() { dirty = true; uni.uProgress.value = opts.progress ? opts.progress() : 0.5; placeCamera(opts.getScroll ? opts.getScroll() : scrollY); syncMeshes(); renderer.render(scene, camera) },
    settle(n = 240) { if (!sys) return; releaseAll(); for (let i = 0; i < n; i++) step(1 / 60, true); syncMeshes(); dirty = true },
    // screen position (css px, viewport) of a loose thread point (k in 0..1 along it)
    looseScreen(lt, k = 0.45) {
      const idx = lt.start + Math.round((lt.pts - 1) * k)
      tmp.set(sys.p[idx * 3], sys.p[idx * 3 + 1], sys.p[idx * 3 + 2]).project(camera)
      return { x: (tmp.x * 0.5 + 0.5) * W, y: (-tmp.y * 0.5 + 0.5) * H }
    },
    // nearest loose thread to a viewport point, within r px
    pickLoose(x, y, r = 18) {
      let best = null, bd = r * r
      for (const lt of loose) {
        for (let k = 1; k < lt.pts; k += 1) {
          tmp.set(sys.p[(lt.start + k) * 3], sys.p[(lt.start + k) * 3 + 1], sys.p[(lt.start + k) * 3 + 2]).project(camera)
          const sx = (tmp.x * 0.5 + 0.5) * W - x, syy = (-tmp.y * 0.5 + 0.5) * H - y
          const d = sx * sx + syy * syy
          if (d < bd) { bd = d; best = { lt, k } }
        }
      }
      return best
    },
    // world point on the z=0 plane under a viewport point
    toWorld(x, y) { return { x: (x - W / 2) / PX, y: camera.position.y - (y - H / 2) / PX } },
    grabLoose(hit) { grabKind = 'loose'; grabbed = hit.lt.start + hit.k; release(hit.lt); const p = sys.p; grabTarget.set(p[grabbed * 3], p[grabbed * 3 + 1], p[grabbed * 3 + 2] + 0.1) },
    grabAt(x, y) {
      // nearest cloth or warp particle under the pointer
      const w = api.toWorld(x, y)
      let best = -1, bd = 0.09
      const P = sys.p
      const ranges = [[cloth.start + cloth.cols, cloth.start + cloth.cols * cloth.rows], [warp.start, warp.start + warp.count * warp.pts]]
      for (const [a, b] of ranges) for (let i = a; i < b; i++) {
        if (sys.w[i] === 0) continue
        const d = (P[i * 3] - w.x) ** 2 + (P[i * 3 + 1] - w.y) ** 2
        if (d < bd) { bd = d; best = i }
      }
      if (best < 0) return false
      grabbed = best; grabKind = best >= warp.start ? 'warp' : 'cloth'
      grabTarget.set(P[best * 3], P[best * 3 + 1], P[best * 3 + 2] + (grabKind === 'cloth' ? 0.35 : 0.12))
      return true
    },
    drag(x, y) {
      if (grabbed < 0) return
      const w = api.toWorld(x, y)
      const r = sys.r, i = grabbed * 3
      const lim = grabKind === 'loose' ? 3 : grabKind === 'warp' ? 0.45 : 0.6
      grabTarget.x = r[i] + Math.max(-lim, Math.min(lim, w.x - r[i]))
      grabTarget.y = grabKind === 'loose' ? w.y : r[i + 1] + Math.max(-lim, Math.min(lim, w.y - r[i + 1]))
      if (grabKind === 'loose') { grabTarget.x = w.x; grabTarget.z = 0.25 }
    },
    releaseGrab() { grabbed = -1; grabKind = null },
    get grabbing() { return grabbed >= 0 ? grabKind : null },
    brush(x, y, vx, vy) {
      if (!sys || reduced) return
      const w = api.toWorld(x, y)
      wake = { x: w.x, y: w.y, vx: vx / PX, vy: -vy / PX, r: 0.28, age: 0 }
    },
    overCloth(x, y) {
      if (!cloth) return null
      const w = api.toWorld(x, y)
      if (w.x < cloth.x0 || w.x > cloth.x0 + cloth.width) return null
      const top = -L.beamY / PX, bot = cloth.yTop - (cloth.rows - 1) * cloth.dy
      if (w.y > top || w.y < bot) return null
      return w.y > cloth.yTop - cloth.rowH ? 'warp' : 'cloth'
    },
    dispose() { api.stop(); disposeScene(); renderer.dispose() },
  }
  return api
}

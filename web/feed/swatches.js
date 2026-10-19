// Integrity swatches: one WebGL renderer, one scissor viewport per DOM cell. Each swatch is a small verlet cloth hanging from
// two pins. A changed item unravels: its lower picks come undone and the freed warp ends dangle (red = suspicious, ink = behavior).
import * as THREE from 'three'
import { Sys, Links, Tubes, yarnMaterial, clothMaterial, webglOk } from '/landing/tapestry.js'

const C = 10, R = 10, SIZE = 1.6
const LOOSE_PTS = 9

export function createSwatches(canvas, grid) {
  if (!webglOk()) return null
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  let renderer
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }) } catch { return null }
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setScissorTest(true)
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20)
  camera.position.set(0.0, -0.3, 5.6)
  camera.lookAt(0, -0.32, 0)
  const swatches = []
  let raf = 0, t = 0

  function make(cell, label, seed, it = {}) {
    const rnd = (k) => { const x = Math.sin(seed * 91.7 + k * 13.1) * 43758.5453; return x - Math.floor(x) }
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc8ba, 1.5))
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(-2.5, 2.5, 2.5); scene.add(key)
    const sys = new Sys(400), links = new Links()
    const x0 = -SIZE / 2, y0 = SIZE / 2, dx = SIZE / (C - 1), dy = SIZE / (R - 1)
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) sys.add(x0 + c * dx, y0 - r * dy, 0, r === 0 && (c === 0 || c === C - 1) ? 0 : 1)
    const id = (c, r) => r * C + c
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (c < C - 1) links.add(sys, id(c, r), id(c + 1, r))
      if (r < R - 1) links.add(sys, id(c, r), id(c, r + 1))
      if (c < C - 1 && r < R - 1) { links.add(sys, id(c, r), id(c + 1, r + 1), 0.6); links.add(sys, id(c + 1, r), id(c, r + 1), 0.6) }
      if (c < C - 2) links.add(sys, id(c, r), id(c + 2, r), 0.4)
      if (r < R - 2) links.add(sys, id(c, r), id(c, r + 2), 0.4)
    }
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(C * R * 3), uv = new Float32Array(C * R * 2), idx = []
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const v = r * C + c; uv[v * 2] = c * dx; uv[v * 2 + 1] = r * dy
      if (c < C - 1 && r < R - 1) idx.push(v, v + C, v + 1, v + 1, v + C, v + C + 1)
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx)
    const N = 14 + Math.floor(rnd(1) * 18)
    const st = new THREE.DataTexture(new Uint8Array(N * 4), N, 1, THREE.RGBAFormat); st.needsUpdate = true
    const u = {
      uPend: { value: 0 }, uUnravel: { value: 0 }, uClothH: { value: SIZE }, uRows: { value: 1 }, uWarpN: { value: N / SIZE }, uPicks: { value: (14 + Math.floor(rnd(2) * 18)) / SIZE }, uRowH: { value: SIZE },
      uPPR: { value: 14 + Math.floor(rnd(2) * 18) }, uProgress: { value: 1 }, uClothW: { value: SIZE }, uAA: { value: 1 },
      cWeft: { value: new THREE.Color().setHSL(0.08 + rnd(3) * 0.06, 0.08 + rnd(4) * 0.12, 0.84 - rnd(5) * 0.12) }, cWeft2: { value: new THREE.Color().setHSL(0.09 + rnd(6) * 0.05, 0.06 + rnd(7) * 0.1, 0.72 - rnd(8) * 0.12) }, cWarp: { value: new THREE.Color().setHSL(0.1, 0.05, 0.62 + rnd(9) * 0.12) },
      cBone: { value: new THREE.Color(0xffffff) }, cSus: { value: new THREE.Color(0xd7261e) }, cBeh: { value: new THREE.Color(0x111111) }, uStatus: { value: st },
    }
    const mesh = new THREE.Mesh(geo, clothMaterial(u))
    scene.add(mesh)
    // loose warp ends for changed items
    const loose = []
    const n = label === 'suspicious' ? 7 : label === 'behavior' ? 4 : label === 'cosmetic' ? 1 : 0
    const llinks = new Links()
    for (let k = 0; k < n; k++) {
      const col = 0.2 + 0.6 * ((k + 0.5) / n) + (Math.sin(seed * 13 + k * 7) * 0.04)
      const s0 = sys.n
      const len = (label === 'cosmetic' ? 0.25 : 0.6 + 0.35 * Math.abs(Math.sin(seed * 3 + k))) / (LOOSE_PTS - 1)
      for (let p = 0; p < LOOSE_PTS; p++) sys.add(x0 + col * SIZE + Math.sin(p + k) * 0.03, -SIZE / 2 - p * len, 0.02 * p, p === 0 ? 0 : 1)
      for (let p = 1; p < LOOSE_PTS; p++) { llinks.add(sys, s0 + p - 1, s0 + p); if (p > 1) llinks.add(sys, s0 + p - 2, s0 + p, 0.4, 0.9) }
      loose.push({ s0, u: col })
    }
    links.freeze(); llinks.freeze()
    let tubes = null
    if (loose.length) {
      tubes = new Tubes(loose.length, LOOSE_PTS, 5, label === 'cosmetic' ? 0.012 : 0.016)
      const m = new THREE.Mesh(tubes.geo, yarnMaterial(label === 'suspicious' ? 0xd7261e : label === 'behavior' ? 0x1a1a1a : 0xbdb6a8, { twist: 1.4 }))
      scene.add(m)
    }
    const sc = it.score != null ? it.score : label === 'suspicious' ? 70 : label === 'behavior' ? 30 : 5
    return { cell, label, scene, sys, links, llinks, geo, u, loose, tubes, seed, unravel: 0, target: label === 'cosmetic' ? 0.04 : Math.min(0.45, 0.06 + sc / 180) }
  }

  function step(s, dt) {
    const P = s.sys.p, Q = s.sys.q, W = s.sys.w, n = s.sys.n
    const g = 3.2 * dt * dt
    for (let i = 0; i < n; i++) {
      if (!W[i]) continue
      const k = i * 3, x = P[k], y = P[k + 1], z = P[k + 2]
      const wind = Math.sin(t * 1.3 + s.seed * 4 + y * 2.2) * 0.35 + Math.sin(t * 2.1 + x * 3.1 + s.seed) * 0.2
      P[k] = x + (x - Q[k]) * 0.97; P[k + 1] = y + (y - Q[k + 1]) * 0.97 - g; P[k + 2] = z + (z - Q[k + 2]) * 0.97 + wind * dt * dt * 1.6
      Q[k] = x; Q[k + 1] = y; Q[k + 2] = z
    }
    // loose ends hang from the unravelled lower edge
    const edgeR = Math.min(R - 1, Math.round((R - 1) * (1 - s.unravel)))
    for (const l of s.loose) {
      const c = Math.min(C - 2, Math.floor(l.u * (C - 1))), f = l.u * (C - 1) - c
      const a = (edgeR * C + c) * 3, b = a + 3, k = l.s0 * 3
      for (let j = 0; j < 3; j++) P[k + j] = P[a + j] * (1 - f) + P[b + j] * f
      P[k + 2] += 0.01
    }
    for (let it = 0; it < 3; it++) { s.links.solve(s.sys); s.llinks.solve(s.sys) }
  }

  function sync(s) {
    s.geo.attributes.position.array.set(s.sys.p.subarray(0, C * R * 3))
    s.geo.attributes.position.needsUpdate = true
    s.geo.computeVertexNormals()
    if (s.tubes) { for (let i = 0; i < s.loose.length; i++) s.tubes.src.set(s.sys.p.subarray(s.loose[i].s0 * 3, (s.loose[i].s0 + LOOSE_PTS) * 3), i * LOOSE_PTS * 3); s.tubes.update() }
  }

  function frame() {
    raf = requestAnimationFrame(frame)
    const cr = canvas.getBoundingClientRect()
    if (cr.bottom < 0 || cr.top > innerHeight) return
    const dpr = Math.min(2, devicePixelRatio || 1)
    const w = Math.round(cr.width), hgt = Math.round(cr.height)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { renderer.setPixelRatio(dpr); renderer.setSize(w, hgt, false) }
    t += 1 / 60
    renderer.setScissor(0, 0, w, hgt); renderer.setViewport(0, 0, w, hgt); renderer.clear()
    for (const s of swatches) {
      if (!reduced) { s.unravel += (s.target - s.unravel) * 0.02; s.u.uUnravel.value = s.unravel; step(s, 1 / 60); sync(s) }
      const r = s.cell.getBoundingClientRect()
      const x = r.left - cr.left, y = cr.bottom - r.bottom
      camera.aspect = r.width / r.height; camera.updateProjectionMatrix()
      renderer.setScissor(x, y, r.width, r.height); renderer.setViewport(x, y, r.width, r.height)
      renderer.render(s.scene, camera)
    }
  }

  return {
    set(items) {
      for (const s of swatches) s.scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.() })
      swatches.length = 0
      grid.textContent = ''
      items.forEach((it, i) => {
        const cell = document.createElement('a')
        cell.className = `sw ${it.label || ''}`
        cell.href = it.href
        cell.title = `${it.name} · ${it.label || 'changed'}`
        const cap = document.createElement('span'); cap.className = `cap chip ${it.label || ''}`; cap.textContent = it.label || ''
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name
        cell.append(nm, cap)
        grid.append(cell)
        let hs = 0; for (const ch of String(it.key || it.name)) hs = (hs * 31 + ch.charCodeAt(0)) % 100003
        const s = make(cell, it.label, hs / 1000 + 0.3, it)
        if (reduced) { s.unravel = s.target; s.u.uUnravel.value = s.target; for (let k = 0; k < 160; k++) step(s, 1 / 60) }
        sync(s)
        swatches.push(s)
      })
      if (!raf) frame()
    },
    dispose() { cancelAnimationFrame(raf); renderer.dispose() },
  }
}

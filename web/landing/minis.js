// Small 3D objects inside page sections, drawn by one fixed overlay renderer with scissor rects:
// a woven strip per ledger row (one anchored hour) and the paper hang-tag behind the token block.
import * as THREE from 'three'
import { clothMaterial, yarnMaterial } from './tapestry.js'
import { tagGeometry } from './scene3d.js'

export function createMinis(canvas) {
  let renderer
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }) } catch { return null }
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.setScissorTest(true)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const items = []
  const lights = () => {
    const g = new THREE.Group()
    g.add(new THREE.HemisphereLight(0x9aa3ad, 0x1c1814, 0.6))
    const k = new THREE.DirectionalLight(0xffe0c0, 3.6); k.position.set(-3, 2.2, 2.4); g.add(k); const f = new THREE.DirectionalLight(0xffffff, 0.9); f.position.set(1, 0, 4); g.add(f)
    const r = new THREE.DirectionalLight(0x9fc3ff, 1.2); r.position.set(2, 1, -3); g.add(r)
    return g
  }

  function strip(el, { seed = 1, warp = 96, day = false } = {}) {
    const scene = new THREE.Scene(); scene.add(lights())
    const Wd = 3.2, Hh = 0.42
    const geo = new THREE.PlaneGeometry(Wd, Hh, 64, 6)
    const p = geo.attributes.position, uv = geo.attributes.uv
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i)
      p.setZ(i, Math.sin(x * 2.1 + seed) * 0.05 + Math.sin(x * 5.3 + seed * 2) * 0.012 + Math.cos(y * 6) * 0.01)
      uv.setXY(i, x + Wd / 2, Hh / 2 - y)
    }
    geo.computeVertexNormals()
    const st = new THREE.DataTexture(new Uint8Array(warp * 4).map((_, j) => (j % 4 === 1 && day ? 255 : 0)), warp, 1, THREE.RGBAFormat); st.needsUpdate = true
    const u = {
      uPend: { value: 0 }, uUnravel: { value: 0 }, uClothH: { value: Hh }, uRows: { value: 1 }, uWarpN: { value: warp / Wd }, uPicks: { value: 12 / Hh }, uRowH: { value: Hh },
      uPPR: { value: 12 }, uProgress: { value: 1 }, uClothW: { value: Wd }, uAA: { value: 1 },
      cWeft: { value: new THREE.Color(0x6a6660) }, cWeft2: { value: new THREE.Color(0x48453f) }, cWarp: { value: new THREE.Color(0x8a857c) },
      cBone: { value: new THREE.Color(0xe6dfcf) }, cSus: { value: new THREE.Color(0xff5a1f) }, cBeh: { value: new THREE.Color(0xc88a5a) }, uStatus: { value: st },
    }
    const mesh = new THREE.Mesh(geo, clothMaterial(u))
    scene.add(mesh)
    const cam = new THREE.PerspectiveCamera(22, 1, 0.1, 20)
    cam.position.set(-0.5, -0.25, 4.6); cam.lookAt(0.1, 0, 0)
    items.push({ el, scene, cam, mesh, anim: false })
  }

  function tag(el) {
    const scene = new THREE.Scene(); scene.add(lights())
    const tex = (() => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 512
      const x = c.getContext('2d'); x.fillStyle = '#e9e2d3'; x.fillRect(0, 0, 512, 512)
      for (let i = 0; i < 5000; i++) { x.fillStyle = `rgba(80,70,55,${Math.random() * 0.05})`; x.fillRect(Math.random() * 512, Math.random() * 512, 1.5, 1.5) }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
    })()
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.95 })
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat)
    const pivot = new THREE.Group(); pivot.add(mesh)
    const stringMat = yarnMaterial(0xff5a1f, { emissive: 0.25, twist: 0.6 })
    const string = new THREE.Mesh(new THREE.BufferGeometry(), stringMat)
    scene.add(pivot, string)
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 40)
    items.push({ el, scene, cam, mesh, pivot, string, aspect: 0, anim: !reduced })
  }
  // the tag is rebuilt to the element's aspect so the DOM sits on paper
  function fitTag(it, aspect) {
    if (Math.abs(aspect - it.aspect) < 0.04) return
    it.aspect = aspect
    const w = 2.4, portrait = aspect < 1
    const long = portrait ? (w / aspect) * 0.94 : w * 0.94, short = portrait ? w * 0.92 : Math.min(w * 1.8, w / aspect) * 0.9
    const cutH = Math.min(short, 1.25), cut = cutH * 0.32 * 0.95
    it.mesh.geometry.dispose(); it.mesh.geometry = tagGeometry(long, short, 0.02, cutH)
    const hole = portrait ? new THREE.Vector3(0, long / 2 - cut, 0) : new THREE.Vector3(-long / 2 + cut, 0, 0)
    it.mesh.position.copy(hole); it.mesh.rotation.z = portrait ? -Math.PI / 2 : 0
    const dir = portrait ? new THREE.Vector3(0.15, 1, 0) : new THREE.Vector3(-0.6, 1, 0)
    it.string.geometry.dispose()
    it.string.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([hole.clone().setZ(0.01), hole.clone().add(dir.clone().multiplyScalar(short * 0.28)).setZ(0.06), hole.clone().add(dir.clone().multiplyScalar(short * 0.6))]), 20, 0.012, 5)
    const d = (w / 2) / (Math.tan((it.cam.fov * Math.PI) / 360) * aspect) * 1.0
    it.cam.position.set(0.05, -0.05, d); it.cam.lookAt(0, 0, 0)
  }

  let raf = 0, t = 0
  function frame() {
    raf = requestAnimationFrame(frame)
    const w = innerWidth, h = innerHeight
    const dpr = Math.min(2, devicePixelRatio || 1)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { renderer.setPixelRatio(dpr); renderer.setSize(w, h, false) }
    t += 1 / 60
    renderer.setScissor(0, 0, w, h); renderer.setViewport(0, 0, w, h); renderer.clear()
    for (const it of items) {
      const r = it.el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > h || r.width < 4) continue
      if (it.pivot) fitTag(it, r.width / r.height)
      if (it.pivot && it.anim) { it.pivot.rotation.z = Math.sin(t * 0.9) * 0.012; it.pivot.rotation.y = Math.sin(t * 0.6) * 0.05 }
      it.cam.aspect = r.width / r.height
      if (!it.pivot) { const d = (3.2 / 2) / (Math.tan((it.cam.fov * Math.PI) / 360) * it.cam.aspect) * 1.02; it.cam.position.set(-0.35, -0.12, d); it.cam.lookAt(0, 0, 0) }
      it.cam.updateProjectionMatrix()
      renderer.setScissor(r.left, h - r.bottom, r.width, r.height); renderer.setViewport(r.left, h - r.bottom, r.width, r.height)
      renderer.render(it.scene, it.cam)
    }
  }
  return {
    strip, tag,
    clearStrips() { for (let i = items.length - 1; i >= 0; i--) if (!items[i].pivot) { items[i].mesh.geometry.dispose(); items.splice(i, 1) } },
    start() { if (!raf) frame() },
  }
}

import { useEffect, useRef } from 'react'

// --- fixed full-viewport water backdrop -------------------------------------
// A WebGL fragment-shader water surface (domain-warped fbm height field, lit
// and shaded) with a canvas-drawn dock scene layered on top: tackle box,
// bucket, coiled rope, a rod and reel, and a fish, seen top-down from the end
// of a dock pinned to the right edge. Purely decorative, sits behind all page
// content — every piece of copy on the page floats above it in its own
// readable "bubble" card.

const VERTEX_SRC = `
  attribute vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAGMENT_SRC = `
  precision highp float;
  uniform vec2 uRes;
  uniform float uTime;

  float hash(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    float a = hash(i);
    float b = hash(i+vec2(1.0,0.0));
    float c = hash(i+vec2(0.0,1.0));
    float d = hash(i+vec2(1.0,1.0));
    return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
  }

  float fbm(vec2 p){
    float v = 0.0;
    float amp = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for(int i=0;i<6;i++){
      v += amp * noise(p);
      p = rot * p * 2.02;
      amp *= 0.5;
    }
    return v;
  }

  float surface(vec2 p, float t){
    vec2 flow1 = vec2(0.06, 0.035) * t;
    vec2 flow2 = vec2(-0.04, 0.05) * t;
    vec2 q = vec2(fbm(p*1.2 + flow1), fbm(p*1.2 + vec2(3.1,1.7) - flow1));
    float h = fbm(p*1.6 + q*1.4 + flow2);
    h += 0.07 * fbm(p*5.0 - flow1*3.0);
    return h;
  }

  void main(){
    vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;
    float t = uTime;
    vec2 p = uv * 3.4;

    float e = 0.0015 * length(uRes) / uRes.y;
    float h  = surface(p, t);
    float hx = surface(p + vec2(e,0.0), t);
    float hy = surface(p + vec2(0.0,e), t);

    vec3 n = normalize(vec3((h-hx), (h-hy), e*3.2));

    vec3 lightDir = normalize(vec3(0.35, 0.5, 0.8));
    vec3 viewDir  = vec3(0.0, 0.0, 1.0);

    float diff = clamp(dot(n, lightDir), 0.0, 1.0);
    vec3 halfv = normalize(lightDir + viewDir);
    float spec = pow(clamp(dot(n, halfv), 0.0, 1.0), 60.0);

    vec3 deep    = vec3(0.020, 0.098, 0.086);
    vec3 mid     = vec3(0.043, 0.223, 0.180);
    vec3 shallow = vec3(0.110, 0.400, 0.320);

    float depth = smoothstep(0.25, 0.85, h);
    vec3 water = mix(deep, mid, smoothstep(0.0,0.6,h));
    water = mix(water, shallow, depth);

    float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
    vec3 sky = vec3(0.55, 0.72, 0.78);
    water = mix(water, sky, fres * 0.35);

    vec3 col = water * (0.55 + 0.7 * diff);
    col += spec * vec3(1.0, 0.98, 0.9) * 1.4;

    float glint = pow(clamp(dot(n, lightDir),0.0,1.0), 8.0);
    col += glint * vec3(0.12, 0.22, 0.24);

    col = pow(col, vec3(0.92));
    gl_FragColor = vec4(col, 1.0);
  }
`

function compileShader(gl, type, src) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Shader error:', gl.getShaderInfoLog(shader))
  }
  return shader
}

// Deterministic RNG so the dock is stable across resizes/redraws.
function makeRng(seed) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function drawTackleBox(ctx, gearShadow, x, y, sc = 1) {
  const w = 78
  const h = 50
  const draw = (silhouette) => {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(sc, sc)
    ctx.translate(-x, -y)
    const rx = x - w / 2
    const ry = y - h / 2
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(rx, ry, w, h, 6)
    else ctx.rect(rx, ry, w, h)
    if (silhouette) {
      ctx.fillStyle = '#000'
      ctx.fill()
      ctx.restore()
      return
    }
    const g = ctx.createLinearGradient(rx, ry, rx, ry + h)
    g.addColorStop(0, '#c0402f')
    g.addColorStop(0.5, '#9c2f22')
    g.addColorStop(1, '#7c2318')
    ctx.fillStyle = g
    ctx.fill()
    ctx.strokeStyle = 'rgba(40,10,6,0.6)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(rx + 2, y - 6)
    ctx.lineTo(rx + w - 2, y - 6)
    ctx.stroke()
    ctx.fillStyle = '#5c1a12'
    if (ctx.roundRect) {
      ctx.beginPath()
      ctx.roundRect(x - 16, ry - 4, 32, 8, 4)
      ctx.fill()
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    if (ctx.roundRect) {
      ctx.beginPath()
      ctx.roundRect(x - 12, ry - 2, 24, 4, 2)
      ctx.fill()
    }
    ctx.fillStyle = '#d9d4c8'
    ctx.fillRect(x - 24, y - 4, 8, 6)
    ctx.fillRect(x + 16, y - 4, 8, 6)
    const sp = ctx.createLinearGradient(rx, ry, rx + w, ry)
    sp.addColorStop(0, 'rgba(255,255,255,0)')
    sp.addColorStop(0.15, 'rgba(255,255,255,0.28)')
    sp.addColorStop(0.4, 'rgba(255,255,255,0)')
    ctx.fillStyle = sp
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(rx, ry, w, h / 2 - 6, 6)
    else ctx.rect(rx, ry, w, h / 2 - 6)
    ctx.fill()
    ctx.restore()
  }
  gearShadow(draw, 8 * sc, 10 * sc)
}

function drawBucket(ctx, gearShadow, x, y, r) {
  const draw = (silhouette) => {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    if (silhouette) {
      ctx.fillStyle = '#000'
      ctx.fill()
      return
    }
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.2, x, y, r)
    g.addColorStop(0, '#cfd2d0')
    g.addColorStop(0.7, '#9aa0a0')
    g.addColorStop(1, '#6d7373')
    ctx.fillStyle = g
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, r * 0.8, 0, Math.PI * 2)
    ctx.fillStyle = '#5b6161'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, r * 0.72, 0, Math.PI * 2)
    const ig = ctx.createRadialGradient(x, y, r * 0.1, x, y, r * 0.72)
    ig.addColorStop(0, '#2b3030')
    ig.addColorStop(1, '#1a1e1e')
    ctx.fillStyle = ig
    ctx.fill()
    ctx.strokeStyle = '#4a4f4f'
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.arc(x, y, r * 0.9, Math.PI * 0.15, Math.PI * 0.85)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.arc(x, y, r * 0.9, Math.PI * 0.2, Math.PI * 0.8)
    ctx.stroke()
  }
  gearShadow(draw, 7, 9)
}

function drawRope(ctx, gearShadow, x, y, r) {
  const draw = (silhouette) => {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    if (silhouette) {
      ctx.fillStyle = '#000'
      ctx.fill()
      return
    }
    ctx.fillStyle = '#c9b184'
    ctx.fill()
    const step = r / 6
    const tw = r * 0.067
    let ci = 0
    for (let rr = r; rr > step; rr -= step) {
      ctx.beginPath()
      ctx.arc(x, y, rr, 0, Math.PI * 2)
      ctx.strokeStyle = ci % 2 ? 'rgba(90,70,44,0.35)' : 'rgba(230,214,182,0.4)'
      ctx.lineWidth = step * 0.85
      ctx.stroke()
      ctx.strokeStyle = 'rgba(120,96,60,0.3)'
      ctx.lineWidth = 0.8
      const n = Math.max(8, Math.floor(rr))
      for (let a = 0; a < n; a++) {
        const ang = (a / n) * Math.PI * 2 + rr * 0.3
        ctx.beginPath()
        ctx.moveTo(x + Math.cos(ang) * (rr - tw), y + Math.sin(ang) * (rr - tw))
        ctx.lineTo(x + Math.cos(ang + 0.3) * (rr + tw), y + Math.sin(ang + 0.3) * (rr + tw))
        ctx.stroke()
      }
      ci++
    }
    ctx.beginPath()
    ctx.arc(x, y, r * 0.2, 0, Math.PI * 2)
    ctx.fillStyle = '#8a6f44'
    ctx.fill()
  }
  gearShadow(draw, 6, 8)
}

function drawRod(ctx, gearShadow, x0, yTop, dockLen, dockH, sc = 1) {
  const bx = x0 + dockLen * 0.8
  const by = yTop + dockH * 0.46
  const tipx = x0 - dockLen * 0.95
  const tipy = by - dockH * 0.3
  const draw = (silhouette) => {
    const segs = 24
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs
      const t1 = (k + 1) / segs
      ctx.beginPath()
      ctx.moveTo(bx + (tipx - bx) * t0, by + (tipy - by) * t0)
      ctx.lineTo(bx + (tipx - bx) * t1, by + (tipy - by) * t1)
      ctx.strokeStyle = silhouette ? '#000' : `rgb(${34 + t0 * 20},${32 + t0 * 18},${34 + t0 * 20})`
      ctx.lineWidth = (5.5 * (1 - t0) + 1) * sc
      ctx.lineCap = 'round'
      ctx.stroke()
    }
    if (silhouette) return
    ctx.beginPath()
    ctx.moveTo(bx, by - 1)
    ctx.lineTo(tipx, tipy - 0.5)
    ctx.strokeStyle = 'rgba(200,205,210,0.25)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.save()
    ctx.translate(bx, by)
    ctx.rotate(-0.5)
    ctx.scale(sc, sc)
    const rg = ctx.createLinearGradient(-14, 0, 14, 0)
    rg.addColorStop(0, '#3a3d40')
    rg.addColorStop(0.5, '#6a6e72')
    rg.addColorStop(1, '#33363a')
    ctx.fillStyle = rg
    if (ctx.roundRect) {
      ctx.beginPath()
      ctx.roundRect(-15, -11, 30, 22, 5)
      ctx.fill()
    }
    ctx.fillStyle = '#26282b'
    ctx.beginPath()
    ctx.ellipse(0, 0, 8, 9, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#82868a'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.ellipse(0, 0, 8, 9, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#1f2123'
    ctx.beginPath()
    ctx.arc(15, 8, 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    ctx.moveTo(tipx, tipy)
    ctx.quadraticCurveTo(tipx - 40, tipy + 10, tipx - 90, tipy + 46)
    ctx.strokeStyle = 'rgba(230,235,235,0.35)'
    ctx.lineWidth = 0.8
    ctx.stroke()
  }
  gearShadow(draw, 5, 7)
}

function drawFish(ctx, gearShadow, x, y, rot, sc = 1) {
  const draw = (silhouette) => {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.scale(sc, sc)
    ctx.beginPath()
    ctx.ellipse(0, 0, 26, 9, 0, 0, Math.PI * 2)
    if (silhouette) {
      ctx.fillStyle = '#000'
      ctx.fill()
      ctx.restore()
      return
    }
    const g = ctx.createLinearGradient(0, -9, 0, 9)
    g.addColorStop(0, '#c8d0d4')
    g.addColorStop(0.45, '#8f9ba1')
    g.addColorStop(0.55, '#6f7a80')
    g.addColorStop(1, '#4d565b')
    ctx.fillStyle = g
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(24, 0)
    ctx.lineTo(34, -7)
    ctx.lineTo(34, 7)
    ctx.closePath()
    ctx.fillStyle = '#5b666b'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(-18, -1.5, 1.8, 0, Math.PI * 2)
    ctx.fillStyle = '#15181a'
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(-2, -3, 16, 2.4, 0, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.fill()
    ctx.restore()
  }
  gearShadow(draw, 5, 6)
}

// Draws the whole top-down dock scene into the overlay canvas. Called once on
// mount and again on window resize — not every animation frame — since the
// scene is deterministic (fixed seed) and redrawing it 60x/sec bought nothing.
function drawDockScene(cv) {
  if (!cv) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const W = cv.clientWidth
  const H = cv.clientHeight
  cv.width = Math.floor(W * dpr)
  cv.height = Math.floor(H * dpr)
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  const rnd = makeRng(1337)
  const jitter = (a) => (rnd() * 2 - 1) * a

  const dockLen = Math.min(W * 0.2, 240)
  const dockH = Math.min(H * 0.26, 280)
  const x0 = W - dockLen
  const x1 = W + 4
  const yTop = (H - dockH) / 2
  const yBot = yTop + dockH
  const sc = dockLen / 480

  ctx.save()
  ctx.filter = 'blur(9px)'
  ctx.fillStyle = 'rgba(2,10,10,0.42)'
  ctx.fillRect(x0 - 26, yTop + 16, dockLen + 30, dockH)
  ctx.restore()

  const bw = 34 * sc
  const boards = Math.ceil(dockLen / bw) + 1
  for (let i = 0; i < boards; i++) {
    const bx = x1 - (i + 1) * bw
    const w = bw - 2.5
    if (bx + w < x0 - bw) continue
    const tone = jitter(16)
    const base = [150 + tone, 139 + tone, 118 + tone * 0.9]
    const g = ctx.createLinearGradient(0, yTop, 0, yBot)
    g.addColorStop(0, `rgb(${base[0] + 10},${base[1] + 9},${base[2] + 8})`)
    g.addColorStop(0.5, `rgb(${base[0]},${base[1]},${base[2]})`)
    g.addColorStop(1, `rgb(${base[0] - 14},${base[1] - 14},${base[2] - 12})`)
    ctx.fillStyle = g
    ctx.fillRect(bx, yTop, w, dockH)

    ctx.save()
    ctx.beginPath()
    ctx.rect(bx, yTop, w, dockH)
    ctx.clip()
    const streaks = 5 + Math.floor(rnd() * 4)
    for (let s = 0; s < streaks; s++) {
      const gx = bx + rnd() * w
      const dark = rnd() > 0.4
      ctx.strokeStyle = dark ? 'rgba(70,60,46,0.16)' : 'rgba(188,178,158,0.14)'
      ctx.lineWidth = 0.7 + rnd() * 1.4
      ctx.beginPath()
      let px = gx
      ctx.moveTo(px, yTop)
      const segs = 8
      for (let k = 1; k <= segs; k++) {
        px = gx + Math.sin(k * 0.9 + s) * (1.2 + rnd() * 1.6)
        ctx.lineTo(px, yTop + (dockH * k) / segs)
      }
      ctx.stroke()
    }
    if (rnd() > 0.72) {
      const ky = yTop + 14 + rnd() * (dockH - 28)
      const kx = bx + w * (0.3 + rnd() * 0.4)
      for (let r = 5; r > 0; r--) {
        ctx.strokeStyle = `rgba(60,48,36,${0.06 * r})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.ellipse(kx, ky, r * 1.6, r * 2.4, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.restore()

    const gap = ctx.createLinearGradient(bx, 0, bx + 3, 0)
    gap.addColorStop(0, 'rgba(30,24,18,0.55)')
    gap.addColorStop(1, 'rgba(30,24,18,0)')
    ctx.fillStyle = gap
    ctx.fillRect(bx, yTop, 3, dockH)

    for (const ny of [yTop + 9, yBot - 9]) {
      const nx = bx + w * 0.5 + jitter(3)
      const ng = ctx.createRadialGradient(nx - 1, ny - 1, 0.3, nx, ny, 3)
      ng.addColorStop(0, '#e8e6df')
      ng.addColorStop(0.5, '#8f8b80')
      ng.addColorStop(1, '#4b4740')
      ctx.fillStyle = ng
      ctx.beginPath()
      ctx.arc(nx, ny, 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  for (const [ey, dir] of [
    [yTop, 1],
    [yBot, -1],
  ]) {
    const eg = ctx.createLinearGradient(0, ey, 0, ey + dir * 10)
    eg.addColorStop(0, 'rgba(20,26,24,0.5)')
    eg.addColorStop(1, 'rgba(20,26,24,0)')
    ctx.fillStyle = eg
    ctx.fillRect(x0, dir > 0 ? ey : ey - 10, dockLen, 10)
  }
  const le = ctx.createLinearGradient(x0, 0, x0 + 12, 0)
  le.addColorStop(0, 'rgba(16,22,20,0.55)')
  le.addColorStop(1, 'rgba(16,22,20,0)')
  ctx.fillStyle = le
  ctx.fillRect(x0, yTop, 12, dockH)

  const gearShadow = (drawFn, ox, oy) => {
    ctx.save()
    ctx.translate(ox, oy)
    ctx.filter = 'blur(5px)'
    ctx.globalAlpha = 0.38
    drawFn(true)
    ctx.restore()
    drawFn(false)
  }

  drawTackleBox(ctx, gearShadow, x0 + dockLen * 0.3, yTop + dockH * 0.3, sc)
  drawBucket(ctx, gearShadow, x0 + dockLen * 0.62, yTop + dockH * 0.66, 30 * sc)
  drawRope(ctx, gearShadow, x0 + dockLen * 0.72, yTop + dockH * 0.26, 24 * sc)
  drawRod(ctx, gearShadow, x0, yTop, dockLen, dockH, sc)
  drawFish(ctx, gearShadow, x0 + dockLen * 0.4, yTop + dockH * 0.72, 0.4, sc)
}

export default function LakeBackground() {
  const canvasRef = useRef(null)
  const dockRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const dock = dockRef.current
    if (!canvas || !dock) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false })

    const resizeWater = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.floor(canvas.clientWidth * dpr)
      const h = Math.floor(canvas.clientHeight * dpr)
      if (gl && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
    }

    const handleResize = () => {
      resizeWater()
      drawDockScene(dock)
    }

    window.addEventListener('resize', handleResize)
    handleResize()

    if (!gl) {
      console.warn('WebGL not available')
      return () => window.removeEventListener('resize', handleResize)
    }

    const prog = gl.createProgram()
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC))
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC))
    gl.linkProgram(prog)
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const posLoc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uTime = gl.getUniformLocation(prog, 'uTime')

    let raf = null
    const start = performance.now()

    const drawFrame = (t) => {
      resizeWater()
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, t)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    if (reduceMotion) {
      drawFrame(0)
    } else {
      const loop = () => {
        drawFrame((performance.now() - start) / 1000)
        raf = requestAnimationFrame(loop)
      }
      loop()
    }

    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <div className="lake-bg" aria-hidden="true">
      <canvas ref={canvasRef} className="lake-bg__water" />
      <canvas ref={dockRef} className="lake-bg__dock" />
      <div className="lake-bg__vignette" />
    </div>
  )
}

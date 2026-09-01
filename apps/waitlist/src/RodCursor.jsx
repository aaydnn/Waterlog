import { useEffect, useRef } from 'react'

// --- interactive fishing rod, pinned to the bottom-left of the viewport ----
// Fixed (never scrolls with the page). The hook idles and bobs at rest;
// bring the cursor within CATCH_RADIUS and it hooks on and follows the
// mouse, bending the rod and pulling the line taut; move far enough away
// (RELEASE_RADIUS) and it eases back to rest. Pure decoration — the whole
// SVG is pointer-events:none so it never blocks clicks on the page beneath.

const CATCH_RADIUS = 80
const RELEASE_RADIUS = 240

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by)
}

function bez(t, B, C, T) {
  const mt = 1 - t
  return {
    x: mt * mt * B.x + 2 * mt * t * C.x + t * t * T.x,
    y: mt * mt * B.y + 2 * mt * t * C.y + t * t * T.y,
  }
}

export default function RodCursor() {
  const svgRef = useRef(null)
  const rodRef = useRef(null)
  const rodHiRef = useRef(null)
  const gripRef = useRef(null)
  const seatRef = useRef(null)
  const reelRef = useRef(null)
  const g1Ref = useRef(null)
  const g2Ref = useRef(null)
  const g3Ref = useRef(null)
  const g4Ref = useRef(null)
  const tipGuideRef = useRef(null)
  const lineRef = useRef(null)
  const hookRef = useRef(null)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches

    let mode = 'IDLE'
    const mouse = { x: -9999, y: -9999, seen: false }
    const hook = { x: 0, y: 0 }
    let bend = 0
    let flicker = 0
    const start = performance.now()

    let butt = { x: 0, y: 0 }
    let tipRest = { x: 0, y: 0 }
    let rest = { x: 0, y: 0 }

    function layout() {
      const W = window.innerWidth
      const H = window.innerHeight
      const svg = svgRef.current
      if (svg) svg.setAttribute('viewBox', `0 0 ${W} ${H}`)

      // rig lives pinned to the bottom-left corner, always in view
      butt = { x: 24, y: H - 130 }
      tipRest = { x: Math.min(W * 0.22, 260), y: H - 95 }
      rest = { x: Math.min(W * 0.13, 160), y: H - 40 }
    }

    layout()
    hook.x = rest.x
    hook.y = rest.y

    const onMove = (e) => {
      mouse.x = e.clientX
      mouse.y = e.clientY
      mouse.seen = true
    }
    const onResize = () => layout()
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('resize', onResize)

    let raf = null

    const tick = (now) => {
      const t = (now - start) / 1000

      const bobAmp = reduced ? 0 : 4
      const bob = Math.sin(t * ((2 * Math.PI) / 2.5)) * bobAmp

      if (canHover && mouse.seen) {
        const dToHook = dist(mouse.x, mouse.y, hook.x, hook.y)
        if (mode === 'IDLE') {
          if (dToHook < CATCH_RADIUS) {
            mode = 'HOOKED'
            if (!reduced) flicker = 2
          }
        } else if (mode === 'HOOKED') {
          if (dToHook > RELEASE_RADIUS) mode = 'RELEASING'
        }
      } else if (mode !== 'IDLE') {
        mode = 'RELEASING'
      }

      if (mode === 'IDLE') {
        hook.x = rest.x
        hook.y = rest.y + bob
      } else if (mode === 'HOOKED') {
        if (reduced) {
          hook.x = mouse.x
          hook.y = mouse.y
        } else {
          hook.x += (mouse.x - hook.x) * 0.15
          hook.y += (mouse.y - hook.y) * 0.15
        }
      } else if (mode === 'RELEASING') {
        const tx = rest.x
        const ty = rest.y + bob
        if (reduced) {
          hook.x = tx
          hook.y = ty
        } else {
          hook.x += (tx - hook.x) * 0.15
          hook.y += (ty - hook.y) * 0.15
        }
        if (dist(hook.x, hook.y, rest.x, rest.y) < 2) mode = 'IDLE'
      }

      const bendTarget = mode === 'HOOKED' ? 1 : 0
      if (reduced) {
        bend = bendTarget
      } else {
        const rate = bendTarget > bend ? 0.28 : 0.16
        bend += (bendTarget - bend) * rate
        if (Math.abs(bendTarget - bend) < 0.002) bend = bendTarget
      }

      let pdx = hook.x - tipRest.x
      let pdy = hook.y - tipRest.y
      const pl = Math.hypot(pdx, pdy) || 1
      pdx /= pl
      pdy /= pl

      const tipX = tipRest.x + pdx * bend * 24
      const tipY = tipRest.y + pdy * bend * 24

      const rmx = (butt.x + tipX) / 2
      const rmy = (butt.y + tipY) / 2
      const rcx = rmx + pdx * 46 * bend
      const rcy = rmy + 16 * (1 - bend) + pdy * 46 * bend
      const B = butt
      const C = { x: rcx, y: rcy }
      const T = { x: tipX, y: tipY }
      const rodD = `M ${B.x} ${B.y} Q ${rcx} ${rcy} ${tipX} ${tipY}`
      if (rodRef.current) rodRef.current.setAttribute('d', rodD)
      if (rodHiRef.current) rodHiRef.current.setAttribute('d', rodD)

      // cork grip + dark reel seat band riding the base of the blank
      const gEnd = bez(0.15, B, C, T)
      const sEnd = bez(0.23, B, C, T)
      if (gripRef.current) gripRef.current.setAttribute('d', `M ${B.x} ${B.y} L ${gEnd.x} ${gEnd.y}`)
      if (seatRef.current) seatRef.current.setAttribute('d', `M ${gEnd.x} ${gEnd.y} L ${sEnd.x} ${sEnd.y}`)

      // reel hangs below the seat
      const ra = bez(0.19, B, C, T)
      if (reelRef.current) reelRef.current.setAttribute('transform', `translate(${ra.x} ${ra.y})`)

      // line guides threaded along the blank (taper toward the tip)
      const guides = [
        [g1Ref, 0.42, 5],
        [g2Ref, 0.6, 4.4],
        [g3Ref, 0.76, 3.8],
        [g4Ref, 0.9, 3.2],
        [tipGuideRef, 0.99, 2.6],
      ]
      for (const [ref, tt, r] of guides) {
        if (!ref.current) continue
        const p = bez(tt, B, C, T)
        ref.current.setAttribute('cx', p.x)
        ref.current.setAttribute('cy', p.y)
        ref.current.setAttribute('r', r)
      }

      // fishing line: sags when idle, near-straight when loaded; one-frame
      // flick to fully taut on catch
      const hookTopY = hook.y - 6
      const lmx = (tipX + hook.x) / 2
      const lmy = (tipY + hookTopY) / 2
      let sag
      if (flicker > 0) {
        sag = 0
        flicker--
      } else {
        sag = 44 * (1 - bend) + 6 * bend
      }
      if (lineRef.current) {
        lineRef.current.setAttribute('d', `M ${tipX} ${tipY} Q ${lmx} ${lmy + sag} ${hook.x} ${hookTopY}`)
      }

      if (hookRef.current) {
        hookRef.current.setAttribute('transform', `translate(${hook.x} ${hook.y})`)
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <svg ref={svgRef} className="rod-cursor" aria-hidden="true">
      {/* rod blank: dark graphite with a bone spine highlight */}
      <path ref={rodRef} d="" fill="none" stroke="#20303B" strokeWidth="8" strokeLinecap="round" />
      <path ref={rodHiRef} d="" fill="none" stroke="#3B4E5B" strokeWidth="3" strokeLinecap="round" />
      {/* cork grip + reel seat near the butt */}
      <path ref={gripRef} d="" fill="none" stroke="#C6A469" strokeWidth="15" strokeLinecap="round" />
      <path ref={seatRef} d="" fill="none" stroke="#1A2833" strokeWidth="15" strokeLinecap="butt" />
      {/* reel hangs below the seat */}
      <g ref={reelRef} transform="translate(0,0)">
        <line x1="0" y1="0" x2="0" y2="15" stroke="#8C979D" strokeWidth="4" />
        <circle cx="0" cy="26" r="13" fill="#20303B" stroke="#9AA4AA" strokeWidth="3" />
        <circle cx="0" cy="26" r="5.5" fill="#8C979D" />
        <circle cx="0" cy="26" r="1.6" fill="#DFFF00" />
        <line x1="-9" y1="21" x2="9" y2="31" stroke="#6E787E" strokeWidth="1.4" />
        <line x1="9" y1="21" x2="-9" y2="31" stroke="#6E787E" strokeWidth="1.4" />
      </g>
      {/* line guides threaded along the blank */}
      <circle ref={g1Ref} cx="0" cy="0" r="0" fill="none" stroke="#B8C0C4" strokeWidth="2" />
      <circle ref={g2Ref} cx="0" cy="0" r="0" fill="none" stroke="#B8C0C4" strokeWidth="2" />
      <circle ref={g3Ref} cx="0" cy="0" r="0" fill="none" stroke="#B8C0C4" strokeWidth="1.8" />
      <circle ref={g4Ref} cx="0" cy="0" r="0" fill="none" stroke="#B8C0C4" strokeWidth="1.8" />
      <circle ref={tipGuideRef} cx="0" cy="0" r="0" fill="none" stroke="#B8C0C4" strokeWidth="1.6" />
      <path ref={lineRef} d="" fill="none" stroke="#F2EFE6" strokeWidth="1.4" strokeOpacity="0.85" />
      <g ref={hookRef} transform="translate(0,0)">
        <path d="M0 5 q0 9 -6.5 9 q-4.5 0 -4.5 -4.5" fill="none" stroke="#F2EFE6" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="0" cy="0" r="6" fill="#122A3B" stroke="#F2EFE6" strokeWidth="1.6" />
        <circle cx="0" cy="0" r="2.6" fill="#DFFF00" />
      </g>
    </svg>
  )
}

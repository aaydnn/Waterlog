import { useEffect, useState } from 'react'
import './dive-transition.css'

const seeded = (seed: number): number => {
  const value = Math.sin(seed * 127.1) * 43758.5453
  return value - Math.floor(value)
}

const cssVars = (values: Record<string, string>): React.CSSProperties => values as React.CSSProperties

/**
 * The signed-in app is already mounted behind this layer, so the angler lands directly in
 * their journal as the water clears rather than waiting on a second loading screen.
 */
export function DiveTransition() {
  const [running, setRunning] = useState(true)

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const timeout = window.setTimeout(() => setRunning(false), reduceMotion ? 120 : 1850)
    return () => window.clearTimeout(timeout)
  }, [])

  if (!running) return null

  return (
    <div className="dive-transition" aria-hidden="true" data-testid="dive-transition">
      <div className="dive-transition__sheet" onAnimationEnd={() => setRunning(false)}>
        <div className="dive-transition__edge dive-transition__edge--top">
          <svg viewBox="0 0 1440 60" preserveAspectRatio="none">
            <path d="M0 26C180-4 360 54 540 26 720-2 900 52 1080 24 1240 0 1360 40 1440 22V60H0Z" />
          </svg>
        </div>
        <div className="dive-transition__water">
          {Array.from({ length: 20 }, (_, index) => {
            const size = 5 + seeded(index + 1) * 16
            return (
              <i
                className="dive-transition__bubble"
                key={`bubble-${index}`}
                style={cssVars({
                  '--left': `${seeded(index + 9) * 98}%`,
                  '--bottom': `${-8 + seeded(index + 21) * 40}%`,
                  '--size': `${size}px`,
                  '--speed': `${(1.1 + seeded(index + 33) * 1.5) * 1.6}s`,
                  '--delay': `${seeded(index + 44) * 1.28}s`,
                })}
              />
            )
          })}
          {Array.from({ length: 5 }, (_, index) => {
            const swimsRight = seeded(index + 5) > 0.45
            return (
              <i
                className={`dive-transition__fish ${swimsRight ? 'dive-transition__fish--right' : ''}`}
                key={`fish-${index}`}
                style={cssVars({
                  '--top': `${8 + seeded(index + 7) * 74}%`,
                  '--width': `${34 + seeded(index + 3) * 46}px`,
                  '--speed': `${(0.9 + seeded(index + 11) * 0.8) * 1.6}s`,
                  '--delay': `${seeded(index + 13) * 0.8}s`,
                  '--bob': `${0.7 + seeded(index + 17) * 0.5}s`,
                  '--fish-color': index % 3 === 0 ? 'rgba(223,255,0,.72)' : 'rgba(242,239,230,.42)',
                })}
              >
                <svg viewBox="0 0 64 32">
                  <path d="M4 16C14 2 40 1 50 16 40 31 14 30 4 16Z" />
                  <path d="m49 16 14-11v22Z" />
                  <circle cx="16" cy="13" r="1.7" />
                </svg>
              </i>
            )
          })}
        </div>
        <div className="dive-transition__edge dive-transition__edge--bottom">
          <svg viewBox="0 0 1440 80" preserveAspectRatio="none">
            <path d="M0 0h1440v30c-180 44-320-18-500 10S620 16 440 42C280 66 140 22 0 34Z" />
            <path className="dive-transition__chartreuse-line" d="M0 34c140-12 280 32 440 8 180-26 320 26 500-2s320 34 500-10" />
            <path className="dive-transition__bone-line" d="M0 30c140-12 280 32 440 8 180-26 320 26 500-2s320 34 500-10" />
          </svg>
        </div>
      </div>
      {Array.from({ length: 7 }, (_, index) => (
        <i
          className="dive-transition__drip"
          key={`drip-${index}`}
          style={cssVars({
            '--top': `${12 + seeded(index + 61) * 60}%`,
            '--left': `${6 + seeded(index + 71) * 88}%`,
            '--height': `${3 + seeded(index + 81) * 9}px`,
            '--speed': `${0.7 + seeded(index + 91) * 0.5}s`,
            '--delay': `${0.8 + seeded(index + 95) * 0.672}s`,
          })}
        />
      ))}
    </div>
  )
}

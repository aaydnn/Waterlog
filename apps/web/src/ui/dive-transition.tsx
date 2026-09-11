import { useEffect, useState } from 'react'
import './dive-transition.css'

const seeded = (seed: number): number => {
  const value = Math.sin(seed * 127.1) * 43758.5453
  return value - Math.floor(value)
}

const cssVars = (values: Record<string, string>): React.CSSProperties =>
  values as React.CSSProperties

/**
 * A full-viewport layer that drains down the screen after authentication. The water is always
 * attached to the bottom edge, so the app is revealed above the moving surface rather than
 * peeking through underneath a travelling panel.
 */
export function DiveTransition() {
  const [running, setRunning] = useState(true)

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const timeout = window.setTimeout(() => setRunning(false), reduceMotion ? 220 : 2400)
    return () => window.clearTimeout(timeout)
  }, [])

  if (!running) return null

  return (
    <div className="dive-transition" aria-hidden="true" data-testid="dive-transition">
      <div
        className="dive-transition__sheet"
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setRunning(false)
        }}
      >
        <div className="dive-transition__water">
          <div className="dive-transition__caustics" />

          {Array.from({ length: 30 }, (_, index) => {
            const size = 4 + seeded(index + 1) * 17
            return (
              <i
                className="dive-transition__bubble"
                key={`bubble-${index}`}
                style={cssVars({
                  '--left': `${2 + seeded(index + 9) * 96}%`,
                  '--bottom': `${-8 + seeded(index + 21) * 86}%`,
                  '--size': `${size}px`,
                  '--speed': `${0.9 + seeded(index + 33) * 1.25}s`,
                  '--delay': `${seeded(index + 44) * 0.72}s`,
                  '--drift': `${-22 + seeded(index + 53) * 44}px`,
                })}
              />
            )
          })}

          {Array.from({ length: 5 }, (_, index) => (
            <i
              className={`dive-transition__current ${index % 2 === 0 ? 'dive-transition__current--accent' : ''}`}
              key={`current-${index}`}
              style={cssVars({
                '--top': `${16 + index * 17}%`,
                '--delay': `${seeded(index + 72) * -2.4}s`,
                '--duration': `${3.2 + seeded(index + 79) * 2}s`,
              })}
            >
              <svg viewBox="0 0 1440 70" preserveAspectRatio="none">
                <path d="M-80 35C100 4 280 66 460 34S820 5 1000 37s360 21 520-7" />
              </svg>
            </i>
          ))}

          {Array.from({ length: 8 }, (_, index) => (
            <i
              className="dive-transition__ripple"
              key={`ripple-${index}`}
              style={cssVars({
                '--left': `${4 + seeded(index + 101) * 88}%`,
                '--top': `${12 + seeded(index + 111) * 76}%`,
                '--width': `${42 + seeded(index + 121) * 94}px`,
                '--delay': `${seeded(index + 131) * 1.1}s`,
                '--speed': `${1.2 + seeded(index + 141) * 1.1}s`,
              })}
            />
          ))}
        </div>

        <div className="dive-transition__surface">
          <svg viewBox="0 0 1440 96" preserveAspectRatio="none">
            <path
              className="dive-transition__surface-fill"
              d="M0 35C130 4 260 64 410 37 580 7 720 57 890 31c180-28 320 35 550-3V96H0Z"
            />
            <path
              className="dive-transition__surface-glow"
              d="M0 35C130 4 260 64 410 37 580 7 720 57 890 31c180-28 320 35 550-3"
            />
            <path
              className="dive-transition__surface-highlight"
              d="M0 43C135 12 260 70 416 44 580 16 724 65 895 39c176-27 322 34 545-3"
            />
            <path
              className="dive-transition__surface-foam-line"
              d="M0 28C130-1 260 58 408 31 580 2 720 51 888 25c182-29 324 35 552-5"
            />
          </svg>

          {Array.from({ length: 22 }, (_, index) => (
            <i
              className="dive-transition__foam"
              key={`foam-${index}`}
              style={cssVars({
                '--left': `${seeded(index + 161) * 100}%`,
                '--top': `${28 + seeded(index + 171) * 31}px`,
                '--size': `${2 + seeded(index + 181) * 5}px`,
                '--delay': `${seeded(index + 191) * -1.5}s`,
              })}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

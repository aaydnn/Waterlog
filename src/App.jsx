import { useState } from 'react'

// --- validation helpers -----------------------------------------------------

function isValidEmail(value) {
  // Deliberately loose: local@domain.tld with no spaces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function isValidPhone(value) {
  // Optional field. Strip everything that isn't a digit, accept 10–15 digits.
  // Don't fight international formats.
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

// --- illustration: bathymetric contour map ----------------------------------
// The page's signature element. Faint depth-map contours in the deep teal,
// drawn as inline SVG so it scales cleanly and carries no external weight.
// Purely decorative — hidden from assistive tech.

function ContourMap() {
  return (
    <svg
      className="contours"
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="var(--teal-deep)"
        strokeWidth="1.25"
        strokeLinecap="round"
      >
        <path d="M-40 120 C 180 60, 380 210, 560 150 S 940 40, 1240 170" />
        <path d="M-40 180 C 200 130, 400 270, 590 210 S 960 110, 1240 230" />
        <path d="M-40 250 C 220 210, 430 340, 620 280 S 980 190, 1240 300" />
        <path d="M-40 330 C 240 300, 470 420, 660 360 S 1010 280, 1240 380" />
        <path d="M-40 430 C 260 410, 500 520, 700 460 S 1040 390, 1240 480" />
        <path d="M-40 540 C 280 520, 520 630, 740 570 S 1070 510, 1240 590" />
        <path d="M-40 650 C 300 640, 540 740, 780 680 S 1100 630, 1240 700" />
        {/* a nested basin — closed contours, the deep hole on the map */}
        <path d="M700 380 C 800 350, 900 400, 900 470 C 900 545, 800 585, 705 560 C 630 540, 615 430, 700 380 Z" />
        <path d="M735 415 C 805 395, 865 435, 862 485 C 858 540, 795 560, 735 542 C 685 527, 675 440, 735 415 Z" />
        <path d="M765 448 C 810 435, 835 470, 830 500 C 824 532, 790 542, 762 528 C 735 515, 730 465, 765 448 Z" />
      </g>
    </svg>
  )
}

// --- illustration: film grain -----------------------------------------------
// Subtle noise overlay across the whole page. Visible if you look for it.

function GrainOverlay() {
  return (
    <svg className="grain" aria-hidden="true" focusable="false">
      <filter id="grain-noise">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.9"
          numOctaves="2"
          stitchTiles="stitch"
        />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain-noise)" />
    </svg>
  )
}

// --- wordmark: the "o" is a bobber ------------------------------------------

function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="waterlog home">
      <span className="wordmark__wat">wat</span>
      <span className="wordmark__bobber" aria-hidden="true">
        <svg viewBox="0 0 40 40" focusable="false">
          {/* top half — bright cork/foam */}
          <path d="M20 3 A17 17 0 0 1 37 20 L3 20 A17 17 0 0 1 20 3 Z" fill="var(--sea-green)" />
          {/* bottom half — painted body */}
          <path d="M3 20 L37 20 A17 17 0 0 1 3 20 Z" fill="var(--teal-deep)" />
          {/* waterline stripe */}
          <rect x="3" y="18.5" width="34" height="3" fill="var(--ink)" opacity="0.55" />
          {/* antenna */}
          <line x1="20" y1="3" x2="20" y2="-4" stroke="var(--bone)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="wordmark__rest">log</span>
    </a>
  )
}

// --- the signup form --------------------------------------------------------

function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [company, setCompany] = useState('') // honeypot
  const [status, setStatus] = useState('idle') // idle | submitting | success | error
  const [errorMsg, setErrorMsg] = useState('')
  const [fieldError, setFieldError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setFieldError('')
    setErrorMsg('')

    if (!isValidEmail(email)) {
      setFieldError('That email looks off. Check it and try again.')
      return
    }
    if (phone.trim() && !isValidPhone(phone)) {
      setFieldError('That number looks short. Leave it blank if you like.')
      return
    }

    setStatus('submitting')
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          phone: phone.trim(),
          company, // honeypot — server drops the request if filled
        }),
      })

      if (res.ok) {
        setStatus('success')
        return
      }

      // Non-200: keep their input intact, show a plain explanation.
      let message = 'Something went wrong on our end. Try again in a minute.'
      if (res.status === 409) {
        message = "You're already on the list — good instincts."
      } else if (res.status === 400) {
        message = 'That input got rejected. Check the email and try again.'
      }
      setErrorMsg(message)
      setStatus('error')
    } catch (err) {
      setErrorMsg("Couldn't reach the dock. Check your connection and try again.")
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <div className="signup signup--done" role="status" aria-live="polite">
        <p className="signup__done-line">You're in.</p>
        <p className="signup__done-sub">
          We'll email you when there's something worth reading.
        </p>
      </div>
    )
  }

  const submitting = status === 'submitting'

  return (
    <form className="signup" onSubmit={handleSubmit} noValidate>
      {/* Honeypot: hidden from people, tempting to bots. */}
      <div className="hp" aria-hidden="true">
        <label htmlFor="company">Company</label>
        <input
          id="company"
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      <div className="signup__field">
        <label htmlFor="email" className="signup__label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div className="signup__field">
        <label htmlFor="phone" className="signup__label">
          Phone <span className="signup__hint">optional — for launch-day text only</span>
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(555) 019-2834"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={submitting}
        />
      </div>

      {(fieldError || errorMsg) && (
        <p className="signup__error" role="alert">
          {fieldError || errorMsg}
        </p>
      )}

      <button type="submit" className="signup__submit" disabled={submitting}>
        {submitting ? 'Adding you…' : 'Join the waitlist'}
      </button>
    </form>
  )
}

// --- page -------------------------------------------------------------------

export default function App() {
  return (
    <>
      <ContourMap />
      <GrainOverlay />

      <main className="page">
        <header className="topbar">
          <Wordmark />
          <span className="stamp">EST. 2026 · BUILT BY AN ANGLER</span>
        </header>

        <section className="hero">
          <h1 className="hero__headline">
            Stop guessing.
            <br />
            Start patterning.
          </h1>

          <p className="hero__subhead">
            A fishing log that learns your patterns from your own catches. Log a
            catch in seconds; over time it tells you what actually works for
            you.
          </p>

          <div className="hero__form">
            <WaitlistForm />
          </div>

          <p className="hero__teaser">
            You already believe you have patterns. Soon you'll have proof.
          </p>
        </section>

        <section className="teasers" aria-label="What waterlog does">
          <hr className="rule" />
          <p className="teaser-line">
            A fishing log that learns your personal patterns from your own
            catches.
          </p>
          <hr className="rule" />
          <p className="teaser-line">
            Log a catch in seconds. The app quietly records the conditions
            around it.
          </p>
          <hr className="rule" />
          <p className="teaser-line">
            Over time it tells you what actually works for you — not generic
            cloudy-day, dark-lure folklore.
          </p>
          <hr className="rule" />
        </section>

        <section className="privacy" aria-label="Privacy">
          <p className="privacy__stamp-label">PRIVATE BY DEFAULT</p>
          <blockquote className="privacy__copy">
            No feed. No followers. Nobody sees your spots. WaterLog works for
            you, not an audience.
          </blockquote>
        </section>

        <footer className="footer">
          <p className="footer__credit">
            Built by one angler who got tired of guessing.
          </p>
          <p className="footer__copy">© 2026 waterlog. Coming soon.</p>
        </footer>
      </main>
    </>
  )
}

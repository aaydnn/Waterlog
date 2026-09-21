import { MIN_BASELINE_HOURS } from '@waterlog/patterns'
import type { PatternFeed } from '@waterlog/schema'
import { useEffect, useState } from 'react'
import { ApiError, apiClient } from '../../lib/api-client'
import { WebPushRegistrar, type PushRegistrar } from '../../lib/push/push-registrar'
import { PatternCard, TeaserCard } from './pattern-card'
import './patterns-view.css'

/**
 * F6, the pattern feed — the retention moment (packet §09 flow 3).
 *
 * Everything on screen was computed overnight and read from `pattern_cache`, so it opens
 * instantly. The empty states are not filler: they carry the free-to-Pro narrative, and the packet
 * says so twice.
 */

/** Roughly what it takes before rates start clearing the surfacing gate — about twenty catches, in
 * the packet's own words. Shown as progress rather than as an empty screen. */
const CATCHES_FOR_PATTERNS = 20

function Locked({ feed }: { feed: Extract<PatternFeed, { tier: 'free' }> }) {
  if (feed.total === 0) {
    return (
      <Waiting hoursLeft={feed.hours_until_baseline}>
        Keep logging. The moment there is a pattern in your fishing, it will show up here.
      </Waiting>
    )
  }
  return (
    <>
      <div className="patterns__paywall">
        <p className="patterns__paywall-count tabular-nums">
          {feed.total} {feed.total === 1 ? 'pattern' : 'patterns'} found in your fishing.
        </p>
        <p className="patterns__paywall-copy">
          Computed from your own catches, every night. Unlock Pro to see what they are.
        </p>
        <button type="button" className="patterns__paywall-cta">
          Unlock Pro
        </button>
      </div>
      <ul className="patterns__list">
        {feed.teasers.map((teaser) => (
          <TeaserCard key={teaser.id} teaser={teaser} />
        ))}
      </ul>
    </>
  )
}

/** The progress meter §09 asks for in place of a blank screen, plus the reason it is blank. */
function Waiting({ hoursLeft, children }: { hoursLeft: number; children: React.ReactNode }) {
  const onTheWater = Math.max(0, MIN_BASELINE_HOURS - hoursLeft)
  const pct = Math.round((onTheWater / MIN_BASELINE_HOURS) * 100)
  return (
    <div className="patterns__waiting">
      {hoursLeft > 0 ? (
        <>
          <p className="patterns__waiting-headline tabular-nums">
            {onTheWater} of {MIN_BASELINE_HOURS} hours on the water
          </p>
          <span className="patterns__meter" aria-hidden="true">
            <span className="patterns__meter-fill" style={{ width: `${pct}%` }} />
          </span>
          <p className="patterns__waiting-copy">
            Rates need hours to divide by, skunked ones included. {hoursLeft}{' '}
            {hoursLeft === 1 ? 'hour' : 'hours'} to go before your first pattern can exist.
          </p>
        </>
      ) : (
        <>
          <p className="patterns__waiting-headline">
            You have the hours. Now it needs the catches.
          </p>
          <p className="patterns__waiting-copy">
            About {CATCHES_FOR_PATTERNS} catches is where patterns usually start to separate from
            luck. {children}
          </p>
        </>
      )}
    </div>
  )
}

/**
 * The opt-in for the first-pattern push (packet §09 flow 3).
 *
 * Asked here, on the screen the notification is about, and never on load: a permission prompt
 * fired at an angler who has not yet seen what it is for is the fastest way to be denied
 * permanently, and a denial cannot be taken back from script.
 */
function NotifyOptIn({ registrar }: { registrar: PushRegistrar }) {
  const [state, setState] = useState<'hidden' | 'offer' | 'working' | 'on' | 'declined'>('hidden')

  useEffect(() => {
    const supported =
      typeof Notification !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    if (supported && Notification.permission === 'default') setState('offer')
  }, [])

  if (state === 'hidden') return null
  if (state === 'on') {
    return <p className="patterns__notify patterns__notify--on">You will be told when a new pattern lands.</p>
  }
  if (state === 'declined') {
    return (
      <p className="patterns__notify">
        No notifications then. Your patterns are always here when you open the app.
      </p>
    )
  }

  return (
    <div className="patterns__notify">
      <button
        type="button"
        className="patterns__notify-button"
        disabled={state === 'working'}
        onClick={() => {
          setState('working')
          void registrar
            .register()
            .then((token) => setState(token ? 'on' : 'declined'))
            .catch(() => setState('declined'))
        }}
      >
        {state === 'working' ? 'Asking…' : 'Tell me when a pattern lands'}
      </button>
    </div>
  )
}

export interface PatternsViewProps {
  /** Injectable so the opt-in can be exercised without a real push service. */
  registrar?: PushRegistrar
}

const webPush = new WebPushRegistrar()

export function PatternsView({ registrar = webPush }: PatternsViewProps = {}) {
  const [feed, setFeed] = useState<PatternFeed | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void apiClient
      .patterns()
      .then((payload) => {
        if (!cancelled) setFeed(payload)
      })
      .catch((err) => {
        if (cancelled) return
        setError(
          err instanceof ApiError && err.status === 401
            ? 'Sign in to see your patterns.'
            : 'Offline — patterns are computed on the server overnight.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <p className="patterns__message">{error}</p>
  if (!feed) return <p className="patterns__message">Loading your patterns…</p>

  if (feed.tier === 'free') {
    return (
      <section className="patterns" aria-label="Your patterns">
        <Locked feed={feed} />
      </section>
    )
  }

  if (feed.patterns.length === 0) {
    return (
      <section className="patterns" aria-label="Your patterns">
        <Waiting hoursLeft={feed.hours_until_baseline}>
          Keep logging and the first one will land here.
        </Waiting>
        <NotifyOptIn registrar={registrar} />
      </section>
    )
  }

  return (
    <section className="patterns" aria-label="Your patterns">
      <ul className="patterns__list">
        {feed.patterns.map((pattern) => (
          <PatternCard key={pattern.id} pattern={pattern} />
        ))}
      </ul>
      {feed.unattributed_catches > 0 ? (
        <p className="patterns__note">
          {feed.unattributed_catches}{' '}
          {feed.unattributed_catches === 1 ? 'catch is' : 'catches are'} not counted in these rates
          yet: their trip is still open, or its conditions have not come back.
        </p>
      ) : null}
      <NotifyOptIn registrar={registrar} />
    </section>
  )
}

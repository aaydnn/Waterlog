import { useState } from 'react'
import type { AuthProvider } from '../../lib/auth/auth-provider'
import { WebAuthProvider } from '../../lib/auth/auth-provider'
import { Wordmark } from '../../ui/wordmark'
import './sign-in.css'

export interface SignInProps {
  auth?: AuthProvider
  /** This device locked itself out but the server hasn't confirmed the sign-out yet. Saying so
   * beats implying the session is definitely dead when it isn't. */
  signOutPending?: boolean
}

/** The gate in front of everything. Capture still works offline once you're through it — the
 * session cookie outlives the trip — but a first run has to sign in somewhere, and until now
 * the only way was typing /api/auth/google into the address bar. */
export function SignIn({ auth = new WebAuthProvider(), signOutPending = false }: SignInProps) {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onMagicLink(e: React.FormEvent) {
    e.preventDefault()
    if (email.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await auth.signIn('magic-link', { email })
      if (result.kind === 'email-sent') setSentTo(result.email)
    } catch {
      setError('Could not send that link. Check the address and your connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="sign-in">
      <h1 className="sign-in__mark">
        <Wordmark />
      </h1>
      <p className="sign-in__pitch">Your patterns. Proven.</p>

      {signOutPending && (
        <p className="sign-in__pending" role="status">
          You're signed out on this device. We'll finish signing you out everywhere once you're
          back online.
        </p>
      )}

      {sentTo ? (
        <p className="sign-in__sent" role="status">
          Check {sentTo} for a sign-in link. It expires in 10 minutes.
        </p>
      ) : (
        <>
          <button
            type="button"
            className="sign-in__google"
            onClick={() => void auth.signIn('google').catch(() => setError('Google sign-in is unavailable.'))}
          >
            Continue with Google
          </button>

          <p className="sign-in__or">or</p>

          <form className="sign-in__form" onSubmit={(e) => void onMagicLink(e)}>
            <input
              type="email"
              aria-label="Email address"
              className="sign-in__email"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className="sign-in__submit" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a link'}
            </button>
          </form>
        </>
      )}

      {error && (
        <p className="sign-in__error" role="alert">
          {error}
        </p>
      )}

      <p className="sign-in__fine">No feed. No followers. Nobody sees your spots.</p>
    </main>
  )
}

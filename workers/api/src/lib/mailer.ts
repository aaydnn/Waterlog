import type { ApiBindings } from '../env'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

/** Dev mailer: prints the message (magic link included) to the console. */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.log(`mail to=${message.to} subject=${message.subject}\n${message.text}`)
  }
}

const RESEND_API_URL = 'https://api.resend.com/emails'

/** Sends via Resend's HTTP API. Until a custom domain is verified in the
 * Resend dashboard, the shared `onboarding@resend.dev` sender can only
 * deliver to the account's own registered address. */
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string) {}

  async send(message: MailMessage): Promise<void> {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: 'WaterLog <onboarding@resend.dev>',
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    })
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`)
    }
  }
}

/** Thrown when no mailer can be built. Callers turn this into a 503 — never into a
 * console-logged sign-in link. */
export class MailerNotConfiguredError extends Error {
  constructor() {
    super(
      'no mailer configured: set the RESEND_API_KEY secret, or set ALLOW_CONSOLE_MAIL="true" ' +
        '(local dev only, in .dev.vars) to print sign-in links to the console instead',
    )
    this.name = 'MailerNotConfiguredError'
  }
}

/**
 * Resolves the mailer, failing closed.
 *
 * The console mailer prints the whole magic link, and that link is a bearer credential: anyone
 * who can read the log can sign in as that address. It used to be the automatic fallback
 * whenever RESEND_API_KEY was absent, so a secret that failed to propagate to production would
 * have silently rerouted every sign-in link into Worker logs. It now takes an explicit opt-in
 * that is only ever set locally (`workers/api/.dev.vars`), never in wrangler.toml's [vars].
 *
 * Precedence is deliberate: a real key always wins, so ALLOW_CONSOLE_MAIL left set somewhere it
 * should not be cannot downgrade a configured environment to console logging.
 */
export function getMailer(env: ApiBindings): Mailer {
  if (env.RESEND_API_KEY) return new ResendMailer(env.RESEND_API_KEY)
  if (env.ALLOW_CONSOLE_MAIL === 'true') return new ConsoleMailer()
  throw new MailerNotConfiguredError()
}

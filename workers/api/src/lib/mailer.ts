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

/** RESEND_API_KEY is a secret, absent in local dev and in tests — both
 * fall back to the console mailer. */
export function getMailer(env: ApiBindings): Mailer {
  return env.RESEND_API_KEY ? new ResendMailer(env.RESEND_API_KEY) : new ConsoleMailer()
}

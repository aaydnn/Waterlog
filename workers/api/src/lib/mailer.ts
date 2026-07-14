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

/** Provider selection is a config decision deferred to Epic 6 polish;
 * until then every environment gets the console mailer. */
export function getMailer(_env: ApiBindings): Mailer {
  return new ConsoleMailer()
}

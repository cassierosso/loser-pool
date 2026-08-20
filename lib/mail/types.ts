/**
 * A minimal mail port. Phase 4 sends magic links through it; Phase 6b's weekly
 * digest to every league member uses the same interface.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

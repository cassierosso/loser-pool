import { createConsoleMailer } from "./console";
import { createResendMailer } from "./resend";
import type { Mailer } from "./types";

export * from "./types";
export * from "./console";
export * from "./resend";

/**
 * Resend when it is configured, the console otherwise. Local development needs
 * no account and no key: the magic link is printed to the terminal.
 */
export function createMailer(): Mailer {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();

  if (apiKey && from) return createResendMailer({ apiKey, from });
  return createConsoleMailer();
}

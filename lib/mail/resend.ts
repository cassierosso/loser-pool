import type { Mailer, MailMessage } from "./types";

/**
 * Production mailer. Unused until RESEND_API_KEY and MAIL_FROM are set.
 *
 * Note that Resend will only deliver to arbitrary addresses from a verified
 * domain; without one it accepts mail only to the account owner's address.
 * Deliberately calls the HTTP API directly rather than adding a dependency for
 * one POST.
 */
export function createResendMailer(options: { apiKey: string; from: string }): Mailer {
  return {
    name: "resend",
    async send(message: MailMessage) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      });

      if (!response.ok) {
        // Loud, per SS8's principle: a silently undelivered magic link looks
        // exactly like a broken app to whoever is waiting for it.
        throw new Error(`Resend returned ${response.status}: ${await response.text()}`);
      }
    },
  };
}

import type { Mailer, MailMessage } from "./types";

/**
 * Production mailer. Unused until RESEND_API_KEY and MAIL_FROM are set.
 *
 * Note that Resend will only deliver to arbitrary addresses from a verified
 * domain; without one it accepts mail only to the account owner's address.
 * Deliberately calls the HTTP API directly rather than adding a dependency for
 * one POST.
 */
export function createResendMailer(options: {
  apiKey: string;
  from: string;
  /** Resend's free tier allows 2 requests/second. */
  minRequestIntervalMs?: number;
}): Mailer {
  const minInterval = options.minRequestIntervalMs ?? 550;
  let queue: Promise<unknown> = Promise.resolve();
  let lastSentAt = Number.NEGATIVE_INFINITY;

  /**
   * Resend rate limits at 2 requests/second, and the weekly digest goes to
   * every member -- 60+ of them, back to back. Sending flat out gets the tail
   * of the league silently rejected, which for an accountability digest means
   * exactly the people who most need the hash never receive it.
   */
  function throttle<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const wait = minInterval - (Date.now() - lastSentAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastSentAt = Date.now();
      return work();
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    name: "resend",
    async send(message: MailMessage) {
      return throttle(async () => {
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
      });
    },
  };
}

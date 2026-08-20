import type { Mailer, MailMessage } from "./types";

/**
 * Development mailer: prints the message to the terminal.
 *
 * This is what makes Phase 4 runnable with no account, no API key, and no
 * verified domain -- you click the link straight out of the server log.
 */
export function createConsoleMailer(log: (message: string) => void = console.log): Mailer {
  return {
    name: "console",
    async send(message: MailMessage) {
      log(
        [
          "",
          "--- EMAIL (console mailer) -------------------------------------",
          `To:      ${message.to}`,
          `Subject: ${message.subject}`,
          "",
          message.text,
          "----------------------------------------------------------------",
          "",
        ].join("\n"),
      );
    },
  };
}

/** Test double: keeps messages instead of printing them. */
export interface CapturingMailer extends Mailer {
  readonly messages: MailMessage[];
}

export function createCapturingMailer(): CapturingMailer {
  const messages: MailMessage[] = [];
  return {
    name: "capturing",
    messages,
    async send(message) {
      messages.push(message);
    },
  };
}

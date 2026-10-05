import { type SentMail, parseMailLog } from "../../lib/mail.js";
import { endpoints } from "./odb.js";

export type { SentMail };

/**
 * What the odb has handed to the stack's Mailgun stand-in so far (ticket 028), oldest first.
 * Nothing is ever delivered; this is the record of attempted sends. An empty log (no mail
 * yet) is a 404 from Caddy, which reads as no messages.
 */
export async function sentMail(): Promise<SentMail[]> {
  const response = await fetch(endpoints.mailLogUrl, { cache: "no-store" });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`the mail record at ${endpoints.mailLogUrl} answered ${response.status}`);
  }
  return parseMailLog(await response.text());
}

/**
 * The messages sent after a point in the record (the length of `sentMail()` taken before
 * the action under test).
 */
export async function mailSentSince(count: number): Promise<SentMail[]> {
  return (await sentMail()).slice(count);
}

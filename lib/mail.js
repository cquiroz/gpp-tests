// The stack's record of outgoing mail (ticket 028).
//
// Nothing the ephemeral stack runs can send email: inside the compose network
// `api.mailgun.net` resolves to Caddy, which answers like Mailgun and writes each request —
// including its form body — as one JSON line to a log it serves back at
// `endpoints.mailLogUrl` (stack/caddy/Caddyfile). This module turns that log into messages,
// so a test can assert what the odb *tried* to send: the proposal-submitted email to the
// PI, an invitation, and so on. Pure; both suites can import it.

/**
 * @typedef {object} SentMail
 * @property {number} at Unix seconds, from Caddy's access log entry.
 * @property {string} from
 * @property {string[]} to Comma-separated recipients split, trimmed.
 * @property {string} subject
 * @property {string} text
 * @property {string} [html]
 * @property {number} status The stand-in's HTTP status (200 unless the route was wrong).
 */

/**
 * Parse the stand-in's access log. Lines that are not sends (the events poll, a 404) and
 * lines that do not parse are skipped, so a partially written last line never fails a test.
 *
 * @param {string} log The log file, one JSON object per line.
 * @returns {SentMail[]} Oldest first.
 */
export function parseMailLog(log) {
  /** @type {SentMail[]} */
  const sent = [];
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    const uri = String(entry.request?.uri ?? "");
    if (entry.request?.method !== "POST" || !/\/messages(\?|$)/.test(uri)) continue;
    const form = parseForm(String(entry.body ?? ""));
    sent.push({
      at: Number(entry.ts ?? 0),
      from: form.from ?? "",
      to: (form.to ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      subject: form.subject ?? "",
      text: form.text ?? "",
      ...(form.html !== undefined ? { html: form.html } : {}),
      status: Number(entry.status ?? 0),
    });
  }
  return sent;
}

/**
 * `application/x-www-form-urlencoded`, as http4s' UrlForm writes it (the odb's email
 * client): `+` is a space, the rest percent-encoded. Repeated keys keep the last value.
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseForm(body) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!body) return out;
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decode(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? "" : decode(pair.slice(eq + 1));
    out[key] = value;
  }
  return out;
}

/** @param {string} s */
function decode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch (_error) {
    return s;
  }
}

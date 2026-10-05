import { describe, expect, it } from "vitest";
import { parseForm, parseMailLog } from "./mail.js";

/**
 * @param {string} body
 * @param {Record<string, unknown>} [extra]
 */
const send = (body, extra = {}) =>
  JSON.stringify({
    level: "info",
    ts: 1791237000.5,
    logger: "http.log.access",
    msg: "handled request",
    request: { method: "POST", uri: "/v3/mail.example.com/messages", host: "api.mailgun.net" },
    status: 200,
    body,
    ...extra,
  });

describe("parseMailLog", () => {
  it("turns each send into a message, oldest first, and ignores everything else", () => {
    const log = [
      send("from=odb%40gpp-test.internal&to=pi.one%40gpp-test.internal%2C+staff%40gpp-test.internal&subject=Proposal+G-2027A-0001+submitted&text=Hello%0AWorld&html=%3Cp%3EHi%3C%2Fp%3E"),
      JSON.stringify({ ts: 1, request: { method: "GET", uri: "/v3/mail.example.com/events" }, status: 200 }),
      send("from=a%40b&to=c%40d&subject=second&text=t", { ts: 1791237001 }),
      "{not json",
      "",
    ].join("\n");

    const sent = parseMailLog(log);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      at: 1791237000.5,
      from: "odb@gpp-test.internal",
      to: ["pi.one@gpp-test.internal", "staff@gpp-test.internal"],
      subject: "Proposal G-2027A-0001 submitted",
      text: "Hello\nWorld",
      html: "<p>Hi</p>",
      status: 200,
    });
    expect(sent[1]?.subject).toBe("second");
    expect(sent[1]?.html).toBeUndefined();
  });

  it("is empty for an empty or missing log", () => {
    expect(parseMailLog("")).toEqual([]);
  });
});

describe("parseForm", () => {
  it("decodes plus-as-space and percent escapes, keeping the last repeated key", () => {
    expect(parseForm("a=1+2&b=%26&a=3&c")).toEqual({ a: "3", b: "&", c: "" });
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROPOSAL_ATTACHMENT_FIXTURE,
  PROPOSAL_ATTACHMENT_SIZES,
  PROPOSAL_ATTACHMENT_TYPES,
  attachmentUploadRequest,
  contentTypeFor,
  padPdf,
  proposalAttachments,
} from "./attachments.js";

describe("attachmentUploadRequest", () => {
  it("builds the odb's REST upload with every parameter encoded", () => {
    const r = attachmentUploadRequest({
      odbRestUrl: "https://odb.gpp-test.internal",
      programId: "p-123",
      attachmentType: "science",
      fileName: "science case.pdf",
      description: "run 42 & co",
    });
    expect(r.operationName).toBe("UploadAttachment");
    expect(r.method).toBe("POST");
    expect(r.url).toBe(
      "https://odb.gpp-test.internal/attachment?programId=p-123&fileName=science%20case.pdf" +
        "&attachmentType=science&description=run%2042%20%26%20co",
    );
    expect(r.headers).toEqual({ "content-type": "application/pdf" });
  });

  it("omits the description when there is none", () => {
    const r = attachmentUploadRequest({
      odbRestUrl: "https://odb.gpp-test.internal",
      programId: "p-1",
      attachmentType: "team",
      fileName: "team.pdf",
    });
    expect(r.url).not.toContain("description");
  });
});

describe("proposalAttachments", () => {
  it("names one PDF per required type, distinct within the program", () => {
    const files = proposalAttachments("nightly");
    expect(files.map((f) => f.attachmentType)).toEqual([...PROPOSAL_ATTACHMENT_TYPES]);
    expect(new Set(files.map((f) => f.fileName)).size).toBe(files.length);
    for (const f of files) {
      expect(f.fileName).toMatch(/\.pdf$/);
      expect(f.description).toContain("nightly");
    }
  });
});

describe("the fixture", () => {
  it("is a small PDF that exists where both suites look for it", () => {
    const bytes = readFileSync(new URL(`../${PROPOSAL_ATTACHMENT_FIXTURE}`, import.meta.url));
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(4096);
  });

  it("has a content type the odb will not reject", () => {
    expect(contentTypeFor(PROPOSAL_ATTACHMENT_FIXTURE)).toBe("application/pdf");
    expect(contentTypeFor("mask_ODF.fits")).toBe("application/fits");
    expect(contentTypeFor("notes")).toBe("application/octet-stream");
  });
});

describe("padPdf", () => {
  const fixture = new Uint8Array(
    readFileSync(new URL(`../${PROPOSAL_ATTACHMENT_FIXTURE}`, import.meta.url)),
  );
  /** @param {Uint8Array} bytes */
  const text = (bytes) => Buffer.from(bytes).toString("latin1");

  it("grows the fixture to exactly the requested size, keeping it a PDF", () => {
    const padded = padPdf(fixture, 100_000);
    expect(padded.length).toBe(100_000);
    expect(text(padded.subarray(0, fixture.length))).toBe(text(fixture));
    expect(text(padded.subarray(fixture.length, fixture.length + 2))).toBe("\n%");
    expect(text(padded.subarray(-7))).toBe("\n%%EOF\n");
  });

  it("returns the original when it is already big enough", () => {
    expect(padPdf(fixture, 10)).toBe(fixture);
    expect(padPdf(fixture, fixture.length + 5)).toBe(fixture);
  });

  it("has a size for every required attachment type", () => {
    for (const type of PROPOSAL_ATTACHMENT_TYPES) {
      expect(PROPOSAL_ATTACHMENT_SIZES[type]).toBeGreaterThan(fixture.length);
    }
  });
});

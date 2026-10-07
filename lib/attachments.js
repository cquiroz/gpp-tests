// Attachment uploads: the one ODB operation that is not GraphQL (ticket 028).
//
// The odb takes a file as `POST /attachment?programId=&fileName=&attachmentType=&description=`
// with the raw bytes as the body and the user's JWT, and answers with the new attachment id
// as plain text (lucuma-odb `AttachmentRoutes.scala`). Explore does exactly this from the
// proposal editor. Both suites build the request here and differ only in the HTTP client —
// Playwright's fetch, k6's http.post — so the REST contract lives in one place, like the
// GraphQL documents in `odb-operations.js`.
//
// Since 2026-09-07 a proposal cannot be submitted without a Science and a Team attachment,
// at both layers; the surge model's proposal loop therefore carries two uploads per
// submission (`wayfinder/map-gpp-tests.md`).

/**
 * The two attachments every proposal submission needs, as the odb's REST tags (the GraphQL
 * enum spells them `SCIENCE` and `TEAM`). Both must be PDFs (`AttachmentFileService`).
 */
export const PROPOSAL_ATTACHMENT_TYPES = /** @type {const} */ (["science", "team"]);

/** @typedef {typeof PROPOSAL_ATTACHMENT_TYPES[number] | "finder" | "mos_mask" | "pre_imaging" | "custom_sed"} AttachmentType */

/**
 * The fixture both suites upload, repo-relative: a 631-byte single-page PDF. The regression
 * suites send it as is; the surge's proposal loop pads it to {@link PROPOSAL_ATTACHMENT_SIZES}
 * with {@link padPdf}, so the REST leg carries realistic bytes.
 */
export const PROPOSAL_ATTACHMENT_FIXTURE = "fixtures/proposal-attachment.pdf";

/**
 * The surge model's upload sizes, bytes per attachment type (ticket 017). Assumed, not
 * measured: a science case is a few pages of text and figures, around 2 MiB; the team
 * attachment (CVs, publication lists) a fraction of that. Nothing in the odb's REST route
 * depends on the size, so these only shape the object-store and bandwidth leg of a
 * submission. Overridable per run with `SCIENCE_ATTACHMENT_BYTES` / `TEAM_ATTACHMENT_BYTES`
 * (k6 reads them in k6/lib/attachments.js).
 */
export const PROPOSAL_ATTACHMENT_SIZES = /** @type {const} */ ({
  science: 2 * 1024 * 1024,
  team: 512 * 1024,
});

/**
 * Grow a PDF to `totalBytes` without breaking it as a file: the padding goes after the
 * original end-of-file marker as one PDF comment line, and a fresh `%%EOF` closes the
 * result (readers that look for the marker in the tail still find it). Verified against the
 * stack 2026-10-06: the odb and versitygw store a 2 MiB padded fixture and list its size.
 *
 * Returns the original bytes untouched when they already reach `totalBytes`.
 *
 * @param {Uint8Array} pdf
 * @param {number} totalBytes
 * @returns {Uint8Array}
 */
export function padPdf(pdf, totalBytes) {
  const head = PAD_OPEN.length;
  const tail = PAD_CLOSE.length;
  if (totalBytes <= pdf.length + head + tail) return pdf;

  const out = new Uint8Array(totalBytes);
  out.set(pdf, 0);
  out.set(PAD_OPEN, pdf.length);
  out.fill(0x78, pdf.length + head, totalBytes - tail); // 'x': printable, so a text tool shows it
  out.set(PAD_CLOSE, totalBytes - tail);
  return out;
}

/** "\n%" — the start of a PDF comment line. */
const PAD_OPEN = new Uint8Array([0x0a, 0x25]);
/** "\n%%EOF\n" */
const PAD_CLOSE = new Uint8Array([0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a]);

/**
 * @typedef {object} UploadRequest
 * @property {"UploadAttachment"} operationName Named like a GraphQL operation so metrics and
 *   logs read the same way.
 * @property {"POST"} method
 * @property {string} url
 * @property {Record<string, string>} headers Content type only; callers add authorization.
 */

/**
 * The upload request for one attachment. Query parameters are encoded here because k6's
 * runtime has no URLSearchParams.
 *
 * @param {{
 *   odbRestUrl: string,
 *   programId: string,
 *   attachmentType: AttachmentType,
 *   fileName: string,
 *   description?: string,
 * }} args
 * @returns {UploadRequest}
 */
export function attachmentUploadRequest({
  odbRestUrl,
  programId,
  attachmentType,
  fileName,
  description,
}) {
  /** @type {[string, string][]} */
  const pairs = [
    ["programId", programId],
    ["fileName", fileName],
    ["attachmentType", attachmentType],
  ];
  if (description) pairs.push(["description", description]);
  const params = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return {
    operationName: "UploadAttachment",
    method: "POST",
    url: `${odbRestUrl}/attachment?${params}`,
    headers: { "content-type": contentTypeFor(fileName) },
  };
}

/**
 * The file names the suites upload for a proposal, one per required type. Distinct names
 * because the odb refuses a duplicate file name within a program.
 *
 * @param {string} [label] Something run-specific for the description, e.g. the run id.
 * @returns {{attachmentType: "science" | "team", fileName: string, description: string}[]}
 */
export function proposalAttachments(label = "gpp-tests") {
  return PROPOSAL_ATTACHMENT_TYPES.map((attachmentType) => ({
    attachmentType,
    fileName: `${attachmentType}-case.pdf`,
    description: `${label} ${attachmentType} attachment`,
  }));
}

/** @param {string} fileName */
export function contentTypeFor(fileName) {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "fits":
      return "application/fits";
    default:
      return "application/octet-stream";
  }
}

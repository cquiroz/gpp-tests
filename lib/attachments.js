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
 * The fixture both suites upload, repo-relative: a 631-byte single-page PDF. Real science
 * cases run to a few MB; the surge model (ticket 017) decides whether to pad.
 */
export const PROPOSAL_ATTACHMENT_FIXTURE = "fixtures/proposal-attachment.pdf";

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

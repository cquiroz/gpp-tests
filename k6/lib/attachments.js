// Attachment uploads from k6 (ticket 028): the REST leg of a proposal submission.
//
// The request comes from `lib/attachments.js`, shared with Playwright; this module adds
// k6's client, the check and the metrics, in the shape `graphql.js` gives GraphQL calls, so
// an upload shows up in Grafana as one more write operation (`operation=UploadAttachment`).
import { check } from "k6";
import http from "k6/http";
import {
  PROPOSAL_ATTACHMENT_FIXTURE,
  attachmentUploadRequest,
  proposalAttachments,
} from "../../lib/attachments.js";
import { programAttachments } from "../../lib/odb-operations.js";
import { endpoints } from "./config.js";
import { gql } from "./graphql.js";
import { graphqlErrors, tags, writeDuration } from "./metrics.js";

/**
 * The fixture PDF, read once per VU in the init context — k6 forbids file access inside an
 * iteration. The path is relative to this module.
 */
export const PROPOSAL_ATTACHMENT_BYTES = open(`../../${PROPOSAL_ATTACHMENT_FIXTURE}`, "b");

/**
 * Upload one attachment as the session's user. Returns the attachment id, or undefined on
 * failure (recorded as a failed check and an `odb_graphql_errors` sample, like a rejected
 * mutation).
 *
 * @param {{token: string}} session
 * @param {{
 *   programId: string,
 *   attachmentType: import("../../lib/attachments.js").AttachmentType,
 *   fileName: string,
 *   description?: string,
 *   body?: ArrayBuffer,
 * }} file
 * @param {{scenario?: string, measure?: boolean}} [opts]
 * @returns {string | undefined}
 */
export function uploadAttachment(session, file, opts = {}) {
  const { scenario, measure = true } = opts;
  const request = attachmentUploadRequest({
    odbRestUrl: endpoints.odbRestUrl,
    programId: file.programId,
    attachmentType: file.attachmentType,
    fileName: file.fileName,
    description: file.description,
  });
  const labels = tags({ scenario, operation: request.operationName });
  const response = http.post(request.url, file.body || PROPOSAL_ATTACHMENT_BYTES, {
    headers: { ...request.headers, authorization: `Bearer ${session.token}` },
    tags: labels,
  });

  const id = String(response.body || "").trim();
  const ok = response.status === 200 && id.length > 0;
  check(response, {
    [`${request.operationName} ${file.attachmentType} succeeded`]: () => ok,
  });
  if (measure) writeDuration.add(response.timings.duration, labels);
  if (!ok) {
    graphqlErrors.add(
      1,
      tags({ scenario, operation: request.operationName, status: String(response.status) }),
    );
    console.warn(
      `${request.operationName} ${file.attachmentType} ${file.fileName}: HTTP ${response.status} ` +
        `${String(response.body || "").slice(0, 200)}`,
    );
    return undefined;
  }
  return id;
}

/**
 * Both required proposal attachments uploaded to a program, then read back: the complete
 * REST leg of one submission, which the surge's proposal loop (017) performs per proposal.
 *
 * @param {{token: string}} session
 * @param {string} programId
 * @param {{scenario?: string, label?: string, measure?: boolean}} [opts]
 * @returns {boolean} whether both uploads landed and the program lists both types
 */
export function proposalAttachmentsScenario(session, programId, opts = {}) {
  const scenario = opts.scenario || "proposal-attachments";
  const uploaded = proposalAttachments(opts.label).map((file) =>
    uploadAttachment(session, { programId, ...file }, { scenario, measure: opts.measure }),
  );
  if (uploaded.some((id) => !id)) return false;

  const data = gql(session, programAttachments({ programId }), {
    scenario,
    measure: opts.measure,
  });
  const listed = (data && data.program.attachments) || [];
  const complete = ["SCIENCE", "TEAM"].every((type) =>
    listed.some((a) => a.attachmentType === type),
  );
  check(listed, { "program lists a SCIENCE and a TEAM attachment": () => complete });
  return complete;
}

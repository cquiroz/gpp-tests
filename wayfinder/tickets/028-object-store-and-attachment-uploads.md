---
id: 028
title: "An object store for the stack, and attachment uploads in the test layers"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

Since 2026-09-07 the odb refuses to submit a proposal without a Science and a Team
attachment ("Science attachment is required" / "Team attachment is required" — the nightly
of that day caught it). Attachments are files: the odb stores them in S3 through Cloudcube
credentials (`CLOUDCUBE_ACCESS_KEY_ID/SECRET/URL`, bucket = first host label of the URL,
path-style, region `us-east-1`, no endpoint setting in its config —
`modules/service/.../S3FileService.scala`), and the ephemeral stack feeds it placeholders,
so nothing can be uploaded and nothing can be submitted, in e2e or in k6.

Give the stack an object store and make uploads a first-class operation:

- **Stack:** a MinIO (or equivalent S3-compatible) service in `stack/docker-compose.yml`
  with a bucket created at boot; point the odb at it. First try the AWS SDK's own
  `AWS_ENDPOINT_URL_S3` environment override (honoured by recent Java SDK v2 releases with
  no code change); if the odb's SDK ignores it, the fallback is an upstream ask for an
  endpoint option. Same service on the AWS load target (016) and, later, real Cloudcube or
  a bucket on the Heroku target (026).
- **Upload operation:** the odb's REST contract is `POST /attachment?programId=&fileName=
  &attachmentType=science|team&description=` with the file as the body and the user's
  JWT (`AttachmentRoutes.scala`); add it to the shared operations layer for both Playwright
  (`tests/support/odb.ts`) and k6, with a small fixture PDF.
- **Tests:** restore the submit/retract lifecycle in `tests/e2e/proposals.spec.ts`
  scenario 4 (upload both, submit, read back the minted reference, retract) and let
  scenario 3 drive Explore's own Submit button once attachments exist. Parity catalog and
  `tests/COVERAGE.md` Attachments row updated.
- **Load model:** every proposal submission in the surge (017) now costs two uploads;
  record typical sizes so the model's REST leg is realistic.

Resolution records the odb env used, the upload helper's API, and the first green
lifecycle run.

---
id: 028
title: "An object store for the stack, and attachment uploads in the test layers"
labels: [wayfinder:task]
status: closed
assignee: claude
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

## Update 2026-10-05: a real bucket exists

IT created the S3 bucket `noirlab-gpp-tests` (us-west-2, shared account 384445651298) and
granted it to the EC2 pair's instance profile `ec2_profile_gpp_tests`. Carlos's own
`gpp-tests` CLI profile also has full object access (put/get/delete verified), though not
ListAllMyBuckets. The pair's IMDSv2 hop limit is 2, so a container on the host can use the
instance role.

Two facts from the odb source decide how it can be used:

- The odb signs with **static keys** (`AwsBasicCredentials`, no session token) and pins the
  region to **us-east-1**, path-style. The instance role cannot feed it, and a direct
  us-west-2 bucket fails signing.
- The image ships AWS SDK **2.29.50**, past 2.28.1 where `AWS_ENDPOINT_URL_S3` became an
  env override, so the endpoint can be moved without an odb change. 2.29.x also predates
  the 2.30 default-checksum change, so no unsigned `x-amz-checksum-*` headers are sent.

Validated path (probe 2026-10-05, from the laptop): an `aws-sigv4-proxy` sidecar
(`public.ecr.aws/aws-observability/aws-sigv4-proxy`, amd64 + arm64) run with
`--name s3 --region us-west-2 --host s3.us-west-2.amazonaws.com`, using the host credential
chain (instance role on AWS, `gpp-tests` profile locally). The client kept the odb's exact
behaviour: dummy static keys, region us-east-1, path-style, `AWS_ENDPOINT_URL_S3` pointing at
the proxy. Put, get, list, delete and a 12 MiB two-part multipart upload all succeeded.
Odb env becomes `CLOUDCUBE_URL=https://noirlab-gpp-tests.<anything>/gpp-tests`, dummy
Cloudcube keys, `AWS_ENDPOINT_URL_S3=http://s3proxy:8080`.

Consequences for this ticket: the AWS target can use the real bucket through the proxy
instead of MinIO; locally either MinIO or the same proxy with the laptop profile. Presigned
download URLs would carry a us-east-1 signature to the proxy host, so attachment *download*
through the browser stays out of scope until upstream makes the region configurable (a
small `CLOUDCUBE_REGION`/default-credentials change Carlos could carry). Use a
per-run key prefix under `gpp-tests/` and clean it at the end of the wizard.

## Resolution (2026-10-05)

**The object store, two modes, one switch.** `S3_MODE` in `stack/scripts/bootstrap.sh`
picks a compose profile and the odb's endpoint; both are written to `stack/.env.generated`
so every later compose call agrees.

- `local` (default; CI and laptops): service `s3`, **versitygw** `v1.8.0` — MinIO's public
  images were withdrawn in 2025 (quay 401, Docker Hub "object not found"); versitygw is a
  30 MB Go binary, multi-arch, 21 MiB resident, and any directory under its root is a
  bucket, so the shell wrapper's `mkdir -p` is the whole init. It keeps object metadata in
  extended attributes, hence a named volume (`s3data`) rather than a macOS bind mount, which
  has none. It ignores the signing region. Probe: put, get, 12 MiB three-part multipart
  round trip byte-identical, delete.
- `bucket` (the AWS target): service `s3proxy`, **aws-sigv4-proxy** pinned by digest, in
  front of `noirlab-gpp-tests` (us-west-2). It discards the odb's us-east-1 static-key
  signature and re-signs with the host credential chain: the instance role
  `ec2_profile_gpp_tests` on EC2 (IMDSv2 hop limit 2), `S3PROXY_AWS_*` exported keys on a
  laptop. Probe from the laptop with the odb's exact client behaviour: put, get, list,
  delete, 12 MiB multipart.

**The odb env used** (`x-odb-env`): `CLOUDCUBE_ACCESS_KEY_ID`/`SECRET` = `S3_ACCESS_KEY_ID`/
`S3_SECRET_ACCESS_KEY` (defaults `gpp-tests` / `gpp-tests-attachments`, versitygw's root
user; dummies in bucket mode), `CLOUDCUBE_URL=https://<S3_BUCKET>.s3.invalid/<S3_PREFIX>`
(bucket = first host label, path = key prefix, host never resolved),
`AWS_ENDPOINT_URL_S3=<S3_ENDPOINT_URL>` (`http://s3:7070` or `http://s3proxy:8080`). The
image's SDK is 2.29.50: past 2.28.1 where the env override arrived, before the 2.30
default-checksum change, so no odb change was needed.

**The upload helper's API.** `lib/attachments.js` (pure, shared): `attachmentUploadRequest({
odbRestUrl, programId, attachmentType, fileName, description })` → `{ operationName:
"UploadAttachment", method, url, headers }`; `proposalAttachments(label)` → the two files a
submission needs (`science-case.pdf`, `team-case.pdf`); `PROPOSAL_ATTACHMENT_FIXTURE`
(`fixtures/proposal-attachment.pdf`, a hand-assembled 631-byte PDF). Playwright:
`OdbClient.upload(...)` and `uploadProposalAttachments(odb, programId, label)` in
`tests/support/odb.ts`. k6: `uploadAttachment(session, file, opts)` and
`proposalAttachmentsScenario(session, programId, opts)` in `k6/lib/attachments.js`,
recorded as `operation=UploadAttachment` in `odb_write_duration`. Read-back:
`programAttachments({ programId })` in `lib/odb-operations.js`, replayed by
`tools/verify-operations.js`.

**Tests.** `proposals.spec.ts` scenario 4 keeps the two-error refusal, then uploads both,
reads them back by id and size, submits (SUBMITTED, reference minted, e.g. `G-2027A-0001`),
asserts the submission email reached the stand-in, retracts. Scenario 5 drives Explore's
own Submit and Retract buttons (the buttons swap; API read-back each time). k6 regression:
scenario `proposal-attachments` (uploads to the PI's program, read-back). Parity catalog:
`proposal-attachments`, `proposal-submit`, `proposal-submit-ui`. `tests/COVERAGE.md`
Attachments and Proposals rows updated.

**Found on the way: the odb emails on submission.** The first lifecycle run failed with
`email_send_error: Unexpected status '401 Unauthorized'` — the odb POSTs to Mailgun after
committing the status (the proposal *was* SUBMITTED and referenced), with the base URL
hardcoded to `https://api.mailgun.net/v3` (Config.scala, "add to environment?"). The stack
now answers for it: compose aliases `api.mailgun.net` to Caddy; the Caddyfile serves
`POST /v3/*/messages` with a Mailgun-shaped `{id, message}` (EmailService decodes those two
fields and strips the angle brackets) and `GET /v3/*/events` with an empty page; the odb's
JVM trusts Caddy's CA through a merged truststore (`stack/scripts/java-truststore.sh`: the
image's cacerts plus the Caddy root, built inside the odb image, mounted at
`/stack/cacerts`, `-Djavax.net.ssl.trustStore` in `JAVA_OPTS`). Bootstrap therefore starts
Caddy first (`--no-deps`), exports its root, builds the store, then starts the rest.
**No email can leave the stack**: the name never resolves to Mailgun from inside the
compose network; the API key is a dummy that real Mailgun refuses; the recipients are
`@gpp-test.internal`. **And what was sent is verifiable**: Caddy's access log for that site
carries each request's form body (`log_append body {http.request.body}`) and is served at
`https://mail.<domain>/mailgun.log`; `lib/mail.js` parses it into messages,
`tests/support/mail.ts` fetches it, scenario 4 asserts a fresh message with a stack-local
recipient. `mail.` is a sixth hostname (`hosts.sh`, the wizard's `/etc/hosts` line).

**AWS wizard.** Preflight heads the bucket and picks `S3_PREFIX=gpp-tests/aws-<stamp>`;
the bootstrap stage passes `S3_MODE=bucket …` to the target (falls back to `local` when the
laptop profile cannot see the bucket); the collect stage prints the objects and bytes the
run uploaded (the surge model's attachment leg); teardown and the AUTO failure path delete
the prefix (`KEEP_ATTACHMENTS=1` keeps it). **First bucket-mode run on AWS: 2026-10-06
00:00–00:40 UTC**, after a bootstrap fix (the mode switch had landed inside the generated-env
heredoc; the first attempt died there and the wizard stopped the pair and cleaned the prefix
as designed). Regression green: 101 checks, 10/10 scenarios, 0 GraphQL errors, both
uploads through the proxy and the instance role — the bucket held exactly 2 objects, 1262
bytes, under `gpp-tests/aws-20261006T000031Z`, deleted at teardown. The rest of the run as
before: 313 steps, step overhead p95 570 ms; 275 sockets, event latency p95 69 ms, nothing
lost; odb memory 4.5 → 10.4 GiB over the execution run then flat, the JVM-sizing shape.

**Verification.** `npm run check` green (typecheck, 220 unit tests incl. `attachments` and
`mail`, guard, parity 32 ↔ 25). k6 regression locally: 10/10 scenarios, 94 checks, 0
GraphQL errors, with `proposal-attachments`. Playwright `proposals.spec.ts`: first full
green run 2026-10-05 against the local stack — five scenarios in 22 s, the lifecycle by API
and through Explore's buttons, the submission email found in the stand-in's record.

**Upstream asks for Carlos** (both small, both would remove a stand-in): a configurable S3
region and endpoint in the odb (today us-east-1 and static keys are pinned, so the real
bucket needs the proxy and presigned downloads cannot work); a configurable Mailgun base
URL (today the stack must own `api.mailgun.net` and a JVM truststore to intercept it).

**Not done.** Attachment *download* through the browser (presigned URLs carry the odb's
us-east-1 signature). Finder charts and MOS masks (the helper takes any `attachmentType`;
nothing uploads them yet). Padding the fixture to realistic sizes (017's call).

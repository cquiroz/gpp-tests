#!/usr/bin/env node
/**
 * Post a Grafana annotation marking a run's start, end or threshold breach (spec §7).
 *
 *   node tools/grafana-annotate.js --kind=start --suite=load --at=<ISO>
 *   node tools/grafana-annotate.js --kind=end   --suite=load --at=<ISO> --ended-at=<ISO> --outcome=fail
 *   node tools/grafana-annotate.js --kind=breach --suite=load --at=<ISO> --breach="odb_write_duration: p(95)<5000"
 *
 * Annotations are how a run is identified end-to-end: metric labels are capped for
 * cardinality, so the annotation window plus the `environment` attribute is what locates a
 * run's traffic in Tempo.
 *
 * Needs GRAFANA_URL (e.g. https://myorg.grafana.net) and GRAFANA_ANNOTATIONS_TOKEN. Without
 * them it prints the payload and exits 0 — annotations are observability, not a gate, and a
 * missing token must not fail a run that otherwise passed.
 *
 * Pass `--strict` to invert that for a one-off check: missing credentials or a rejected POST
 * then exit non-zero. Use it to confirm the credentials work; never in the workflows.
 */
import {
  breachAnnotation,
  runEndAnnotation,
  runStartAnnotation,
} from "../lib/annotations.js";
import { ENVIRONMENT_OF, testId } from "../lib/run-identity.js";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);

const kind = args.get("kind") ?? "start";
const suite = /** @type {"regression"|"load"} */ (
  args.get("suite") ?? process.env.SUITE ?? "regression"
);
const at = args.get("at") ?? new Date().toISOString();

const run = {
  testid: testId({ suite, runId: process.env.GITHUB_RUN_ID }),
  suite,
  environment: process.env.OTEL_ENVIRONMENT ?? ENVIRONMENT_OF[suite],
  runUrl:
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined,
  at,
};

let annotation;
switch (kind) {
  case "start":
    annotation = runStartAnnotation(run);
    break;
  case "end":
    annotation = runEndAnnotation({
      ...run,
      endedAt: args.get("ended-at") ?? new Date().toISOString(),
      outcome: /** @type {"pass"|"fail"|"flaky"} */ (args.get("outcome") ?? "pass"),
    });
    break;
  case "breach":
    annotation = breachAnnotation({
      ...run,
      breaches: (args.get("breach") ?? "unknown threshold").split(";").map((b) => b.trim()),
    });
    break;
  default:
    console.error(`unknown --kind=${kind} (expected start, end or breach)`);
    process.exit(2);
}

/**
 * Secrets arrive as text someone pasted, so tolerate the usual damage: a trailing newline
 * from `echo … | gh secret set`, quotes copied along with the value, or line breaks from a
 * wrapped paste. Untreated, each shows up as an unparseable URL or a flat 401 — errors that
 * never mention whitespace, and whose values are masked in CI logs.
 *
 * @param {string|undefined} value
 * @param {{stripAllWhitespace?: boolean}} [opts]
 */
function cleanSecret(value, opts = {}) {
  let v = (value ?? "").trim();
  // Quotes are never part of a URL or a token, but they are easy to paste.
  v = v.replace(/^(['"])(.*)\1$/s, "$2").trim();
  // Grafana tokens contain no whitespace at all, so internal breaks are paste damage.
  if (opts.stripAllWhitespace) v = v.replace(/\s+/g, "");
  return v;
}

const url = cleanSecret(process.env.GRAFANA_URL);
const token = cleanSecret(process.env.GRAFANA_ANNOTATIONS_TOKEN, {
  stripAllWhitespace: true,
});

const strict = args.has("strict");

if (!url || !token) {
  console.error(
    "GRAFANA_URL or GRAFANA_ANNOTATIONS_TOKEN not set — printing the annotation instead",
  );
  console.log(JSON.stringify(annotation, null, 2));
  process.exit(strict ? 1 : 0);
}

// Checked before the request so the diagnosis names the variable. Left to fetch, the failure
// reads "Failed to parse URL from ***/api/annotations" — and in CI the value is masked, so
// there is nothing in the log to reason from.
if (!/^https?:\/\/[^/]/.test(url)) {
  console.error(
    "GRAFANA_URL is not an absolute URL, so no request was attempted.\n" +
      "It must include the scheme and be the stack root, e.g. https://myorg.grafana.net\n" +
      "(no trailing path, no quotes). A value like `myorg.grafana.net` or one with a\n" +
      "trailing newline fails here. Re-set it with:\n" +
      "    gh secret set GRAFANA_URL --body 'https://myorg.grafana.net'",
  );
  process.exit(strict ? 1 : 0);
}

// A DNS failure, TLS error or timeout must land in the same graceful path as an HTTP error —
// a Grafana outage should cost a run its annotation, not produce a stack trace.
let response;
try {
  response = await fetch(`${url.replace(/\/+$/, "")}/api/annotations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(annotation),
    signal: AbortSignal.timeout(20_000),
  });
} catch (error) {
  console.error(
    `annotation failed: could not reach ${url} ` +
      `(${error instanceof Error ? error.message : error})`,
  );
  process.exit(strict ? 1 : 0);
}

const body = await response.text();
if (!response.ok) {
  // Loud, but not fatal: losing an annotation should not turn a green run red.
  console.error(`annotation failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  if (response.status === 401 || response.status === 403) {
    // Classify by prefix without echoing the value: `glsa_` is an in-instance service-account
    // token (what this API wants) and `glc_` is a Cloud Access Policy token (what people
    // reach for, because it is the one the metrics pipeline uses).
    const shape = token.startsWith("glsa_")
      ? "a Grafana service-account token (glsa_…), which is the right kind — so the token is\n" +
        "probably revoked, from a different stack, or its role lacks annotation write access"
      : token.startsWith("glc_")
        ? "a Grafana Cloud **Access Policy** token (glc_…). That is the metrics remote-write\n" +
          "credential; the annotations API does not accept it"
        : "of no recognised Grafana token shape (a service-account token starts with glsa_)";

    console.error(
      `\nThe token looks like ${shape}.\n\n` +
        "The annotations API belongs to the Grafana *instance*, so it needs a service-account\n" +
        "token created inside Grafana itself:\n" +
        "  1. open https://<org>.grafana.net\n" +
        "  2. Administration → Users and access → Service accounts → Add service account\n" +
        "  3. role Editor (or Admin), then Add service account token\n" +
        "  4. gh secret set GRAFANA_ANNOTATIONS_TOKEN --body 'glsa_...'\n\n" +
        "Check one before setting it:\n" +
        "  curl -s -o /dev/null -w '%{http_code}\\n' \\\n" +
        "    -H \"Authorization: Bearer $TOKEN\" \"$GRAFANA_URL/api/annotations?limit=1\"\n" +
        "200 means it works; 401 means it is the wrong kind.",
    );
  }
  process.exit(strict ? 1 : 0);
}
console.error(`annotated ${kind} for ${run.testid}: ${body.slice(0, 200)}`);

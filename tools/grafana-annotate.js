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
    // Never follow a redirect on this POST. Per the Fetch spec a followed 301/302 downgrades
    // POST to GET and drops the body — and `GET /api/annotations` is a valid request that
    // returns 200 with a list, so the tool would report a successful annotation having
    // created nothing. `http://` in GRAFANA_URL is enough to trigger it.
    redirect: "manual",
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
  // Grafana's own errors are compact JSON and worth printing; an HTML body means a proxy or
  // error page answered, and dumping it just buries the explanation below.
  const isHtml = /^\s*<(!doctype|html)/i.test(body);
  console.error(
    `annotation failed: HTTP ${response.status}` +
      (isHtml ? " (HTML error page, not a Grafana response)" : ` ${body.slice(0, 300)}`),
  );
  // grafana.net sits behind Cloudflare, which answers 530 (error 1016, "Origin DNS error")
  // when the hostname is not a live stack. Nothing reached Grafana, so the token is not
  // implicated — and neither status nor body says "that host does not exist".
  if (response.status === 530 || body.includes("error code: 1016")) {
    console.error(
      "\nA 530 comes from Cloudflare, not Grafana: the request never reached a stack, because\n" +
        "that hostname is not a live one. Check GRAFANA_URL against the URL you actually open\n" +
        "Grafana with — it is the *stack* name, which is often not the organisation name:\n" +
        "  grafana.com → My Account → Stacks → your stack's Grafana URL",
    );
  }

  if (response.status >= 300 && response.status < 400) {
    console.error(
      `\nThe endpoint redirected (Location: ${response.headers.get("location") ?? "not given"}),\n` +
        "and this POST deliberately does not follow it: a followed redirect turns the POST into\n" +
        "a GET, which succeeds against /api/annotations and would look like a created\n" +
        "annotation while creating nothing.\n" +
        "Almost always GRAFANA_URL uses http:// where it should use https://.",
    );
  }

  if (response.status === 404) {
    console.error(
      "\nA 404 usually means GRAFANA_URL carries a path. It must be the bare stack root, e.g.\n" +
        "https://mystack.grafana.net — this tool appends /api/annotations itself.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    // Classify by prefix without echoing the value: `glsa_` is an in-instance service-account
    // token (what this API wants) and `glc_` is a Cloud Access Policy token (what people
    // reach for, because it is the one the metrics pipeline uses).
    const shape = token.startsWith("glsa_")
      ? "a Grafana service-account token (glsa_…) — the right kind, so it is probably revoked,\n" +
        "from a different stack, or its role lacks annotation write access"
      : token.startsWith("glc_")
        ? "a Grafana Cloud Access Policy token (glc_…) — that is the metrics remote-write\n" +
          "credential, which the annotations API does not accept"
        : token.startsWith("eyJ")
          ? "a legacy Grafana API key (the base64 eyJ… kind). Those were replaced by service\n" +
            "accounts and current Grafana rejects them exactly like this"
          : `no recognised Grafana token shape — ${token.length} characters, starting with\n` +
            "neither glsa_ (service account) nor glc_ (Cloud Access Policy). Check that the\n" +
            "secret holds the token itself and not, say, an instance ID or a username:password";

    console.error(
      `\nThe token is ${shape}.\n\n` +
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
// A 2xx is not proof by itself. Grafana answers a *created* annotation with an object
// ({id, message: "Annotation added"}); an array is the response to a GET listing them, which
// is what arrives if this POST was ever turned into a GET. Belt to the redirect braces above.
let created;
try {
  created = JSON.parse(body);
} catch {
  created = undefined;
}
if (Array.isArray(created)) {
  console.error(
    `annotation failed: HTTP ${response.status} returned a list, not a created annotation.\n` +
      "Something turned this POST into a GET — check GRAFANA_URL for a redirecting host.",
  );
  process.exit(strict ? 1 : 0);
}

console.error(`annotated ${kind} for ${run.testid}: ${body.slice(0, 200)}`);

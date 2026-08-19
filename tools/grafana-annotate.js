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

const url = process.env.GRAFANA_URL;
const token = process.env.GRAFANA_ANNOTATIONS_TOKEN;

if (!url || !token) {
  console.error(
    "GRAFANA_URL or GRAFANA_ANNOTATIONS_TOKEN not set — printing the annotation instead",
  );
  console.log(JSON.stringify(annotation, null, 2));
  process.exit(0);
}

const response = await fetch(`${url.replace(/\/+$/, "")}/api/annotations`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(annotation),
  signal: AbortSignal.timeout(20_000),
});

const body = await response.text();
if (!response.ok) {
  // Loud, but not fatal: losing an annotation should not turn a green run red.
  console.error(`annotation failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  process.exit(0);
}
console.error(`annotated ${kind} for ${run.testid}: ${body.slice(0, 200)}`);

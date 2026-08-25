// A five-second run whose only purpose is to prove the Grafana Cloud remote-write credentials
// work (spec §7). Emits one custom metric with the same name shape the load suite uses, so a
// successful push is visible in Grafana as `k6_gpp_verify_*`.
//
// Driven by tools/verify-metrics.sh — which is the part that actually checks for failure,
// because k6 treats a rejected push as a logged error and carries on to exit 0.
import { Counter, Trend } from "k6/metrics";
import { sleep } from "k6";

const pushes = new Counter("gpp_verify_pushes");
const latency = new Trend("gpp_verify_latency", true);

export const options = {
  vus: 1,
  duration: "5s",
  // No thresholds: this script cannot fail. Whether the *metrics* arrived is not something k6
  // reports through its exit code, which is the whole reason the wrapper exists.
};

export default function () {
  pushes.add(1, { suite: "verify" });
  latency.add(Math.random() * 100, { suite: "verify" });
  sleep(1);
}

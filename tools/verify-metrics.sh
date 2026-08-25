#!/usr/bin/env bash
# Prove the Grafana Cloud remote-write credentials actually work, before a paid run depends on
# them (spec §7).
#
#   tools/verify-metrics.sh
#
# Needed because k6 treats a rejected remote-write as a logged error and still exits 0 — the
# same "green but broken" shape as the Grafana annotations, which took four CI runs to notice.
# This runs a five-second push and fails if anything was rejected.
#
# Find the values with:
#   tools/find-grafana-credentials.sh
set -uo pipefail

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v k6 >/dev/null || die "k6 is not installed (it is in the flake devShell)"

missing=()
for var in K6_PROMETHEUS_RW_SERVER_URL K6_PROMETHEUS_RW_USERNAME K6_PROMETHEUS_RW_PASSWORD; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  die "not set: ${missing[*]}
    Discover the first two with tools/find-grafana-credentials.sh; the third is an Access
    Policy token with the metrics:write scope, created at grafana.com → Access Policies."
fi

# The endpoint is easy to get subtly wrong: the *query* URL ends in /api/prom and the
# *write* URL needs /api/prom/push. Pushing to the query URL returns 404 or 405, which the
# error scan below would catch — but naming it up front is faster than reading log lines.
case "$K6_PROMETHEUS_RW_SERVER_URL" in
  https://*/api/prom/push) : ;;
  https://*/api/v1/write)  : ;;  # self-hosted Prometheus / Mimir shape
  https://*/api/prom)
    die "K6_PROMETHEUS_RW_SERVER_URL ends in /api/prom, which is the *query* endpoint.
    Remote write needs /api/prom/push — append it:
        ${K6_PROMETHEUS_RW_SERVER_URL}/push" ;;
  *)
    warn "the endpoint does not look like a Grafana Cloud remote-write URL"
    warn "(expected https://prometheus-prod-XX-<region>.grafana.net/api/prom/push)" ;;
esac

# The username is the numeric Prometheus instance ID. A token pasted here instead is a common
# mix-up and produces an authentication failure that says nothing about which field is wrong.
if ! [[ "$K6_PROMETHEUS_RW_USERNAME" =~ ^[0-9]+$ ]]; then
  warn "K6_PROMETHEUS_RW_USERNAME is not numeric — it should be the Prometheus *instance ID*"
  warn "(a number), not a token or an email address."
fi

case "$K6_PROMETHEUS_RW_PASSWORD" in
  glsa_*)
    warn "the password looks like a Grafana *service-account* token (glsa_…), which belongs to"
    warn "the instance API. Remote write wants a Cloud Access Policy token (glc_…)." ;;
esac

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

log "pushing five seconds of metrics to ${K6_PROMETHEUS_RW_SERVER_URL}"
K6_PROMETHEUS_RW_STALE_MARKERS=true \
  k6 run --quiet -o experimental-prometheus-rw \
    "$(dirname "$0")/../k6/verify-metrics.js" >"$OUT" 2>&1
k6_status=$?

# k6 logs a rejected push and carries on, so the exit code alone proves nothing. Scan for the
# output's own error lines.
if grep -qiE "level=error|failed to (send|store|write)|remote-write.*(error|unauthorized|forbidden)|401|403" "$OUT"; then
  echo >&2
  grep -iE "level=error|failed to|401|403|unauthorized|forbidden" "$OUT" | head -5 >&2
  echo >&2
  die "the metrics were rejected. Common causes:
    401 / unauthorized  the token lacks metrics:write, or the username is not the instance ID
    404 / 405           the URL is the query endpoint; remote write needs /api/prom/push
    connection refused  wrong region in the hostname"
fi

if [[ $k6_status -ne 0 ]]; then
  tail -20 "$OUT" >&2
  die "k6 itself failed (exit $k6_status)"
fi

log "no push errors reported"
cat >&2 <<EOF

$(printf '\033[1;32mok\033[0m') the credentials work. Confirm the data landed — in Grafana, open Explore
   and query:

       k6_gpp_verify_pushes_total

   It should appear within a minute or two. If the credentials work but nothing shows up, the
   metric-name suffixes are what the custom dashboard needs checking against
   (see grafana/README.md).
EOF

#!/usr/bin/env bash
# Work out the k6 remote-write settings from your Grafana instance.
#
#   GRAFANA_URL=https://<stack>.grafana.net GRAFANA_ANNOTATIONS_TOKEN=glsa_... \
#     tools/find-grafana-credentials.sh
#
# Two of the three values k6 needs are already recorded in Grafana's own Prometheus datasource,
# so they can be read out rather than hunted for in the portal:
#
#   K6_PROMETHEUS_RW_SERVER_URL   the datasource URL with /push appended
#   K6_PROMETHEUS_RW_USERNAME     the datasource's basic-auth user — the instance ID
#
# The third, K6_PROMETHEUS_RW_PASSWORD, cannot be read back from anywhere: tokens are shown
# once at creation. That one has to come from grafana.com → Access Policies.
set -uo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

: "${GRAFANA_URL:?GRAFANA_URL is required, e.g. https://myorg.grafana.net}"
: "${GRAFANA_ANNOTATIONS_TOKEN:?GRAFANA_ANNOTATIONS_TOKEN is required (a glsa_ service-account token)}"

command -v jq >/dev/null || die "jq is required"

URL="${GRAFANA_URL%/}"

log "reading the Prometheus datasource from $URL"
response="$(curl -sS -m 30 -w '\n%{http_code}' \
  -H "Authorization: Bearer $GRAFANA_ANNOTATIONS_TOKEN" \
  "$URL/api/datasources" 2>&1)" || die "could not reach $URL"

status="$(printf '%s' "$response" | tail -1)"
body="$(printf '%s' "$response" | sed '$d')"

if [[ "$status" != "200" ]]; then
  printf '%s\n' "$body" | head -3 >&2
  die "HTTP $status listing datasources.
    A 403 means the service account can read annotations but not datasources — give it the
    Editor role, or read the values from the portal instead (see below)."
fi

count="$(printf '%s' "$body" | jq '[.[] | select(.type == "prometheus")] | length')"
if [[ "$count" == "0" ]]; then
  die "no Prometheus datasource found on this stack."
fi

printf '%s' "$body" | jq -r '
  .[] | select(.type == "prometheus") |
  "\n  name          \(.name)\n  query URL     \(.url)\n  instance ID   \(.basicAuthUser // "not set on this datasource")"
' >&2

# Grafana Cloud's query endpoint ends in /api/prom; remote write is the same host with /push.
query_url="$(printf '%s' "$body" | jq -r '[.[] | select(.type == "prometheus")][0].url')"
instance_id="$(printf '%s' "$body" | jq -r '[.[] | select(.type == "prometheus")][0].basicAuthUser // ""')"
write_url="${query_url%/}/push"

cat >&2 <<EOF

$(printf '\033[1;34m==>\033[0m') what k6 needs

  export K6_PROMETHEUS_RW_SERVER_URL='$write_url'
  export K6_PROMETHEUS_RW_USERNAME='${instance_id:-<the numeric instance ID>}'
  export K6_PROMETHEUS_RW_PASSWORD='glc_...'   # cannot be read back — create one:

grafana.com → your org → Access Policies → Create access policy
  scope: metrics:write     realm: this stack
then Add token, and copy it once.

Check it works before anything depends on it:

  tools/verify-metrics.sh

EOF

if [[ -z "$instance_id" ]]; then
  die "the datasource has no basicAuthUser, so the instance ID is not recorded there.
    Find it at grafana.com → your stack → Prometheus → Details (\"User\" / instance ID)."
fi

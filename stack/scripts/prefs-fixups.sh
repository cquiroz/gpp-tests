#!/usr/bin/env bash
# Repairs the prefs database after Hasura has applied lucuma-apps' migrations. Idempotent;
# bootstrap and refresh run it after every Hasura start.
#
# Production's prefs database has never been created from scratch, so a migration that only
# breaks a fresh one goes unnoticed upstream: 1725303654076_itc_graph_rename renamed the
# ItcChartType rows (s2n_chart -> s2n_graph) and left lucumaUserPreferences.itcChartType
# defaulting to the old id. A user's first preferences row then violates the foreign key,
# and Explore, which swallows preference errors, stores nothing (seen 2026-11-02).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd docker curl

load_generated_env

pg="${COMPOSE_PROJECT_NAME:-gpp-tests}-postgres-1"
health="https://prefs.$GPP_TEST_DOMAIN/healthz"

for _ in $(seq 1 90); do
  curl -sk --max-time 5 "$health" 2>/dev/null | grep -q OK && break
  sleep 2
done
curl -sk --max-time 5 "$health" 2>/dev/null | grep -q OK \
  || die "hasura is not answering at $health; see: docker logs ${COMPOSE_PROJECT_NAME:-gpp-tests}-hasura-1"

log "repairing the prefs schema: itcChartType defaults to s2n_graph"
docker exec "$pg" psql -U "${PG_USER:-jimmy}" -d prefs -v ON_ERROR_STOP=1 -q \
  -c "alter table \"lucumaUserPreferences\" alter column \"itcChartType\" set default 's2n_graph'"

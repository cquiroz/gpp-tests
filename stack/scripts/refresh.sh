  # Waits for Hasura, then re-applies the repairs the migrations need on a fresh schema.
  bash "$STACK_DIR/scripts/prefs-fixups.sh"
  compose up --detach --no-deps --force-recreate hasura
  # Waits for Hasura, then re-applies the repairs the migrations need on a fresh schema.
  bash "$STACK_DIR/scripts/prefs-fixups.sh"
#!/usr/bin/env bash
# Bring a running stack's service images up to today's `-dev` builds, in place.
#
#   stack/scripts/refresh.sh            # pull sso, odb, obscalc, itc; recreate what changed
#   SERVICES="odb obscalc" stack/scripts/refresh.sh   # a subset
#
# Why this exists: Explore is not a container here — Caddy proxies it live from Firebase dev
# hosting, which tracks lucuma-apps main every day — while the odb, obscalc, ITC and SSO images
# are whatever bootstrap pulled. A few days later Explore's schema is ahead of the odb's and
# every run goes red with "Schema error, reload to check for a new version" at the foot of
# the page, and mutations Explore issues are refused (seen 2026-10-26 and 2026-10-30). A
# fresh `down.sh` + `bootstrap.sh` fixes it but wipes the database and the fabricated users;
# this keeps both. The odb migrates its database forward on boot, and the SSO sessions live in
# Postgres, so the cookies the browser specs inject keep working.
#
# The prefs schema ages the same way: Hasura applies the migrations of the lucuma-apps
# checkout bootstrap made (fetch-lucuma-apps.sh), and Explore's preference documents move
# with main — seen 2026-11-02, a `theme` column: every preference query failed validation,
# Explore fell back to defaults and silently stored nothing. So the checkout is updated and
# Hasura recreated when it changed; its image applies the new migrations on start.
#
# Needs the stack up (bootstrap.sh done) and a Docker login to registry.heroku.com — the one
# bootstrap made is usually still cached; otherwise `export HEROKU_API_KEY=…` as for bootstrap.
#
# A Postgres restart is deliberately *not* part of this: the odb does not reconnect after one
# (HTTP 500s until it is restarted), so Postgres is left alone and only the services whose
# image changed are recreated. Recreating any of them drops its pooled connections cleanly.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd docker node git

load_generated_env

[[ -n "${GPG_SSO_PUBLIC_KEY:-}" ]] \
  || die "no generated environment found ($GENERATED_ENV): run stack/scripts/bootstrap.sh first"

read -r -a services <<<"${SERVICES:-${STACK_IMAGE_SERVICES[*]}}"

# Same default as bootstrap, so compose mounts the migrations from the same checkout.
export LUCUMA_APPS_DIR="${LUCUMA_APPS_DIR:-$STACK_DIR/.cache/lucuma-apps}"
prefs_before="$(git -C "$LUCUMA_APPS_DIR" rev-parse HEAD 2>/dev/null || true)"
bash "$STACK_DIR/scripts/fetch-lucuma-apps.sh"
prefs_after="$(git -C "$LUCUMA_APPS_DIR" rev-parse HEAD)"

if [[ -n "${HEROKU_API_KEY:-}" ]]; then
  log "logging in to registry.heroku.com"
  echo "$HEROKU_API_KEY" | docker login registry.heroku.com -u _ --password-stdin >/dev/null
fi

container_of() { printf '%s-%s-1' "${COMPOSE_PROJECT_NAME:-gpp-tests}" "$1"; }

# running_image_id <service> — the id of the image the service's container runs now.
running_image_id() {
  docker inspect --format '{{.Image}}' "$(container_of "$1")" 2>/dev/null || true
}

# pulled_image_id <service> — the id the service's image reference resolves to after the
# pull. The reference is read from the running container, not from `compose config
# --images`, which lists the service's dependencies' images too, in no fixed order.
pulled_image_id() {
  local ref
  ref="$(docker inspect --format '{{.Config.Image}}' "$(container_of "$1")" 2>/dev/null || true)"
  [[ -n "$ref" ]] && docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true
}

log "pulling ${services[*]}"
compose pull --quiet "${services[@]}" \
  || die "pull failed — if it says 'no basic auth credentials', export HEROKU_API_KEY and re-run"

changed=()
for s in "${services[@]}"; do
  running="$(running_image_id "$s")"
  pulled="$(pulled_image_id "$s")"
  if [[ -z "$running" || -z "$pulled" || "$running" != "$pulled" ]]; then
    changed+=("$s")
  fi
done

if (( ${#changed[@]} == 0 )); then
  log "every image is already current; nothing to recreate"
else
  # Recreate only what changed, in dependency order, without touching anything else
  # (--no-deps keeps Postgres, Hasura and Caddy as they are).
  ordered=()
  for s in sso itc odb obscalc; do
    for c in "${changed[@]}"; do [[ "$c" == "$s" ]] && ordered+=("$s"); done
  done
  log "recreating ${ordered[*]}"
  compose up --detach --no-deps "${ordered[@]}"

  log "waiting for the odb to report healthy"
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "${COMPOSE_PROJECT_NAME:-gpp-tests}-odb-1" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && break
    sleep 5
  done
  [[ "$status" == "healthy" ]] || die "the odb did not become healthy; see: docker logs ${COMPOSE_PROJECT_NAME:-gpp-tests}-odb-1"
  # obscalc and the ITC answer a moment after the odb; the replay below retries nothing.
  sleep 15
fi

if [[ "$prefs_before" == "$prefs_after" ]]; then
  log "prefs schema already at lucuma-apps $(git -C "$LUCUMA_APPS_DIR" rev-parse --short HEAD); hasura kept"
else
  log "recreating hasura for the prefs migrations at lucuma-apps $(git -C "$LUCUMA_APPS_DIR" rev-parse --short HEAD)"
  # --force-recreate: the mount is unchanged as far as compose can tell, only its contents moved.
  compose up --detach --no-deps --force-recreate hasura
  # Waits for Hasura, then re-applies the repairs the migrations need on a fresh schema.
  bash "$STACK_DIR/scripts/prefs-fixups.sh"
fi

for s in "${services[@]}"; do
  log "$s: $(docker inspect --format '{{.Config.Image}} {{slice .Image 7 19}}' "${COMPOSE_PROJECT_NAME:-gpp-tests}-$s-1" 2>/dev/null || echo 'not running')"
done

log "replaying every operation against the refreshed odb"
(cd "$REPO_DIR" && node tools/verify-operations.js) \
  || die "the refreshed odb refuses an operation: the schema moved, see schema/README.md"

log "refreshed; the fabricated users and the database are untouched"

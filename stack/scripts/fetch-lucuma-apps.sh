#!/usr/bin/env bash
# Sparse checkout of lucuma-apps for the Hasura preferences migrations (spec §3, service 6).
#
# The prefs service is stock Hasura; its schema lives in lucuma-apps at
# explore/hasura/user-prefs/ and must come from the same commit range as the Explore bundle
# we serve, so it is fetched from main on every run rather than vendored here.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd git

REPO_URL="${LUCUMA_APPS_REPO:-https://github.com/gemini-hlsw/lucuma-apps.git}"
REF="${LUCUMA_APPS_REF:-main}"
DIR="${LUCUMA_APPS_DIR:-$STACK_DIR/.cache/lucuma-apps}"
SPARSE_PATH="explore/hasura/user-prefs"

if [[ -d "$DIR/.git" ]]; then
  log "updating $DIR to $REF"
  git -C "$DIR" fetch --depth 1 origin "$REF" --quiet
  git -C "$DIR" checkout --quiet FETCH_HEAD
else
  log "cloning $SPARSE_PATH from lucuma-apps ($REF)"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$REF" "$REPO_URL" "$DIR"
  git -C "$DIR" sparse-checkout init --cone
  git -C "$DIR" sparse-checkout set "$SPARSE_PATH"
  git -C "$DIR" checkout --quiet
fi

[[ -d "$DIR/$SPARSE_PATH/migrations" ]] \
  || die "$DIR/$SPARSE_PATH/migrations is missing — has the prefs project moved in lucuma-apps?"

log "prefs migrations: $(find "$DIR/$SPARSE_PATH/migrations" -name up.sql | wc -l | tr -d ' ') migration(s) at $(git -C "$DIR" rev-parse --short HEAD)"

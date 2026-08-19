#!/usr/bin/env bash
# Record the exact images this run used (spec §3: "record image SHAs so failures attribute
# to commits"). The tag policy is `:latest` from the `-dev` apps, i.e. a moving target —
# without the digest a red run cannot be pinned to the day's merges.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd docker jq

OUTPUT="${1:-$REPO_DIR/out/images.json}"
mkdir -p "$(dirname "$OUTPUT")"

config_json="$(compose config --format json)"

{
  for service in "${STACK_IMAGE_SERVICES[@]}"; do
    image="$(jq -r --arg s "$service" '.services[$s].image // empty' <<<"$config_json")"
    [[ -n "$image" ]] || continue
    digest="$(docker image inspect \
      --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' \
      "$image" 2>/dev/null || echo unknown)"
    jq -n --arg s "$service" --arg image "$image" --arg digest "$digest" \
      '{($s): {image: $image, digest: $digest}}'
  done
} | jq -s 'add // {}' > "$OUTPUT"

log "recorded image digests in $OUTPUT"
jq -r 'to_entries[] | "  \(.key): \(.value.digest)"' "$OUTPUT" >&2

#!/usr/bin/env bash
# Fabricate standard (non-guest) SSO users for role-diverse tests, without ORCID.
#
#   stack/scripts/create-standard-users.sh   # needs the stack up (bootstrap.sh done)
#   source stack/.env.standard-users         # TEST_PI_* and TEST_STAFF_* land here
#
# Implements tiers 2-3 of research/orcid-auth-testing-strategy.md, following the SQL and
# cookie mechanics traced in research/sso-standard-user-fabrication.md: a standard user is
# two INSERTs into the SSO database this stack owns, a browser session is one more (the
# refresh token is stored unhashed, so the RETURNING value *is* the cookie value), and the
# JWT is minted by the running sso container so it is signed by the keypair the ODB trusts.
#
# Idempotent: users, roles and sessions are looked up before being created, so re-running
# only re-mints the JWTs (they expire after an hour; sessions and users live with the stack).
#
# Two personas for the browser suite (TEST_PI, TEST_STAFF), then the pool for k6 (ticket 017):
# POOL_PI_COUNT PIs and POOL_STAFF_COUNT staff written as JSON to
# stack/.env.standard-users.json, one identity per load VU (POOL_PI_COUNT=0 skips it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_generated_env

# The ORCID iDs are fabricated but must be *checksum-valid*: the SSO database accepts any
# string, but every read path decodes through OrcidId.fromValue, which enforces the ISO-7064
# mod-11-2 check digit — a bad one makes create-jwt and refresh-token crash later, far from
# here. Verified digits; recompute per the algorithm in the research note if adding personas.
readonly PI_ORCID="0000-0002-1825-0097"
readonly STAFF_ORCID="0000-0002-1825-010X"

sso_psql() {
  compose exec -T postgres psql -qtAX -U "${PG_USER:-jimmy}" -d lucuma-sso -v ON_ERROR_STOP=1 -c "$1"
}

# ensure_user <orcid> <given> <family> — prints the user_id, creating the user if needed.
# orcid_id is UNIQUE, so it is the idempotency key; GIDs are left to their defaults.
ensure_user() {
  local orcid="$1" given="$2" family="$3" user_id email
  email="$(printf '%s.%s@gpp-test.internal' "$given" "$family" | tr '[:upper:]' '[:lower:]')"
  user_id="$(sso_psql "SELECT user_id FROM lucuma_user WHERE orcid_id = '$orcid';")"
  if [[ -z "$user_id" ]]; then
    user_id="$(sso_psql "
      INSERT INTO lucuma_user (user_type, orcid_id, orcid_given_name, orcid_family_name, orcid_email)
      VALUES ('standard', '$orcid', '$given', '$family', '$email')
      RETURNING user_id;")"
  fi
  [[ -n "$user_id" ]] || die "could not create or find the SSO user for $orcid"
  printf '%s' "$user_id"
}

# ensure_role <user_id> <role_type> — prints the role_id. Non-ngo roles only (role_ngo must
# stay NULL for pi/staff/admin; an ngo persona would need the partner column too).
ensure_role() {
  local user_id="$1" role_type="$2" role_id
  role_id="$(sso_psql "SELECT role_id FROM lucuma_role WHERE user_id = '$user_id' AND role_type = '$role_type';")"
  if [[ -z "$role_id" ]]; then
    role_id="$(sso_psql "
      INSERT INTO lucuma_role (user_id, role_type)
      VALUES ('$user_id', '$role_type')
      RETURNING role_id;")"
  fi
  [[ -n "$role_id" ]] || die "could not create or find the $role_type role for $user_id"
  printf '%s' "$role_id"
}

# ensure_session <user_id> <role_id> — prints the refresh token (the cookie value). The
# session row picks the JWT's *active* role; it has no expiry and survives until the stack
# is torn down, which is what makes it injectable into a browser context days later.
ensure_session() {
  local user_id="$1" role_id="$2" token
  token="$(sso_psql "SELECT refresh_token FROM lucuma_session WHERE user_id = '$user_id' AND role_id = '$role_id' LIMIT 1;")"
  if [[ -z "$token" ]]; then
    token="$(sso_psql "
      INSERT INTO lucuma_session (user_id, user_type, role_id)
      VALUES ('$user_id', 'standard', '$role_id')
      RETURNING refresh_token;")"
  fi
  [[ -n "$token" ]] || die "could not create or find a session for $user_id/$role_id"
  printf '%s' "$token"
}

# mint_jwt <role_id> — prints a 1-hour JWT for the role, signed by the running sso container
# (same stdout-scraping approach bootstrap uses for the service JWT, and for the same
# reason: the subcommand logs around the token).
mint_jwt() {
  local role_id="$1" output jwt
  output="$(compose exec -T sso /opt/docker/bin/lucuma-sso-service create-jwt "$role_id" 2>&1)" || true
  jwt="$(printf '%s\n' "$output" \
    | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' \
    | tail -1 || true)"
  if [[ -z "$jwt" ]]; then
    printf '%s\n' "$output" >&2
    die "create-jwt $role_id printed no JWT (output above)"
  fi
  printf '%s' "$jwt"
}

log "fabricating standard users in the lucuma-sso database"
PI_USER_ID="$(ensure_user "$PI_ORCID" Test Pi)"
PI_ROLE_ID="$(ensure_role "$PI_USER_ID" pi)"
PI_REFRESH_TOKEN="$(ensure_session "$PI_USER_ID" "$PI_ROLE_ID")"

STAFF_USER_ID="$(ensure_user "$STAFF_ORCID" Test Staff)"
STAFF_ROLE_ID="$(ensure_role "$STAFF_USER_ID" staff)"
STAFF_REFRESH_TOKEN="$(ensure_session "$STAFF_USER_ID" "$STAFF_ROLE_ID")"

log "minting 1-hour JWTs (re-run this script when they expire; everything else persists)"
PI_JWT="$(mint_jwt "$PI_ROLE_ID")"
STAFF_JWT="$(mint_jwt "$STAFF_ROLE_ID")"

# A separate file, not an append to .env.generated: bootstrap rewrites that file wholesale,
# and this one is re-runnable on its own. Both are gitignored by the same stack/.env* glob.
STANDARD_USERS_ENV="$STACK_DIR/.env.standard-users"
cat > "$STANDARD_USERS_ENV" <<EOF
# Generated by create-standard-users.sh — fabricated standard SSO users (no real ORCID).
# JWTs live 1 hour; user/role/session rows live until the stack is torn down.
export TEST_PI_USER_ID="$PI_USER_ID"
export TEST_PI_ROLE_ID="$PI_ROLE_ID"
export TEST_PI_REFRESH_TOKEN="$PI_REFRESH_TOKEN"
export TEST_PI_JWT="$PI_JWT"
export TEST_STAFF_USER_ID="$STAFF_USER_ID"
export TEST_STAFF_ROLE_ID="$STAFF_ROLE_ID"
export TEST_STAFF_REFRESH_TOKEN="$STAFF_REFRESH_TOKEN"
export TEST_STAFF_JWT="$STAFF_JWT"
# Browser tests inject the refresh token as a cookie on this domain (name:
# lucuma-refresh-token, path /, Secure, HttpOnly, SameSite=Strict).
export SSO_COOKIE_DOMAIN="$GPP_TEST_DOMAIN"
EOF

log "wrote $STANDARD_USERS_ENV"
log "pi:    $PI_USER_ID / $PI_ROLE_ID"
log "staff: $STAFF_USER_ID / $STAFF_ROLE_ID"

# ---------------------------------------------------------------------------------------
# The standard-user pool (ticket 017): POOL_PI_COUNT PIs and POOL_STAFF_COUNT staff, one per
# k6 VU, so the surge's proposal loop and its subscriber population never share an identity
# (CONTEXT.md "Standard-user pool"). Same three rows per user as above, but set-based: one
# psql round trip for the whole pool instead of three `docker exec`s per user, because
# bootstrap runs this on every boot and 250 users must cost a second, not minutes.
#
# ORCID iDs are `0009-01xx-xxxx-xxxC`: a fabricated range far from the two personas above,
# with the ISO-7064 mod-11-2 check digit computed here (research/sso-standard-user-fabrication.md
# §1) — a bad digit does not fail the INSERT, it crashes refresh-token later.
# ---------------------------------------------------------------------------------------
POOL_PI_COUNT="${POOL_PI_COUNT:-250}"
POOL_STAFF_COUNT="${POOL_STAFF_COUNT:-4}"

# orcid_check <15 base digits> — the check digit, "X" for 10.
orcid_check() {
  local base="$1" total=0 i
  for ((i = 0; i < ${#base}; i++)); do
    total=$(( (total + ${base:i:1}) * 2 ))
  done
  local result=$(( (12 - total % 11) % 11 ))
  if (( result == 10 )); then printf 'X'; else printf '%d' "$result"; fi
}

# pool_orcid <kind-digit> <index> — e.g. pool_orcid 1 7 → 0009-0100-0000-007C (PIs are 1,
# staff 2). 15 base digits: 0009 01 K then the index zero-padded to 8 digits.
pool_orcid() {
  local base
  base="$(printf '000901%d%08d' "$1" "$2")"
  printf '%s-%s-%s-%s%s' "${base:0:4}" "${base:4:4}" "${base:8:4}" "${base:12:3}" "$(orcid_check "$base")"
}

# pool_values <kind-digit> <role> <count> <given> — VALUES rows for the temp table.
pool_values() {
  local kind="$1" role="$2" count="$3" given="$4" i sep=""
  for ((i = 1; i <= count; i++)); do
    printf "%s('%s','%s','%s','%s%04d','%s-%04d@gpp-test.internal',%d)" \
      "$sep" "$(pool_orcid "$kind" "$i")" "$role" "$given" "Pool" "$i" "$(tr '[:upper:]' '[:lower:]' <<<"$given")" "$i" "$i"
    sep=$',\n'
  done
}

STANDARD_USERS_POOL="$STACK_DIR/.env.standard-users.json"
if (( POOL_PI_COUNT > 0 || POOL_STAFF_COUNT > 0 )); then
  log "fabricating the standard-user pool: $POOL_PI_COUNT PIs, $POOL_STAFF_COUNT staff"
  # Users, roles and sessions are created only where missing (orcid_id is the key), then the
  # whole pool is read back as one JSON document — the file k6 opens.
  compose exec -T postgres psql -qtAX -U "${PG_USER:-jimmy}" -d lucuma-sso -v ON_ERROR_STOP=1 <<SQL > "$STANDARD_USERS_POOL.tmp"
CREATE TEMP TABLE pool (orcid text, role_type text, given text, family text, email text, idx int);
INSERT INTO pool VALUES
$(pool_values 1 pi "$POOL_PI_COUNT" Pi)$( (( POOL_PI_COUNT > 0 && POOL_STAFF_COUNT > 0 )) && printf ',\n')$(pool_values 2 staff "$POOL_STAFF_COUNT" Staff);
INSERT INTO lucuma_user (user_type, orcid_id, orcid_given_name, orcid_family_name, orcid_email)
  SELECT 'standard', p.orcid, p.given, p.family, p.email FROM pool p
  WHERE NOT EXISTS (SELECT 1 FROM lucuma_user u WHERE u.orcid_id = p.orcid);
INSERT INTO lucuma_role (user_id, role_type)
  SELECT u.user_id, p.role_type::lucuma_role_type FROM pool p JOIN lucuma_user u ON u.orcid_id = p.orcid
  WHERE NOT EXISTS (SELECT 1 FROM lucuma_role r WHERE r.user_id = u.user_id AND r.role_type = p.role_type::lucuma_role_type);
INSERT INTO lucuma_session (user_id, user_type, role_id)
  SELECT u.user_id, 'standard', r.role_id FROM pool p
  JOIN lucuma_user u ON u.orcid_id = p.orcid
  JOIN lucuma_role r ON r.user_id = u.user_id AND r.role_type = p.role_type::lucuma_role_type
  WHERE NOT EXISTS (SELECT 1 FROM lucuma_session s WHERE s.user_id = u.user_id AND s.role_id = r.role_id);
SELECT json_build_object(
  'cookieDomain', '$GPP_TEST_DOMAIN',
  'pi', (SELECT coalesce(json_agg(json_build_object('userId', u.user_id, 'roleId', r.role_id, 'refreshToken', s.refresh_token) ORDER BY p.idx), '[]'::json)
         FROM pool p JOIN lucuma_user u ON u.orcid_id = p.orcid
         JOIN lucuma_role r ON r.user_id = u.user_id AND r.role_type = 'pi'
         JOIN LATERAL (SELECT refresh_token FROM lucuma_session s WHERE s.user_id = u.user_id AND s.role_id = r.role_id LIMIT 1) s ON true
         WHERE p.role_type = 'pi'),
  'staff', (SELECT coalesce(json_agg(json_build_object('userId', u.user_id, 'roleId', r.role_id, 'refreshToken', s.refresh_token) ORDER BY p.idx), '[]'::json)
         FROM pool p JOIN lucuma_user u ON u.orcid_id = p.orcid
         JOIN lucuma_role r ON r.user_id = u.user_id AND r.role_type = 'staff'
         JOIN LATERAL (SELECT refresh_token FROM lucuma_session s WHERE s.user_id = u.user_id AND s.role_id = r.role_id LIMIT 1) s ON true
         WHERE p.role_type = 'staff'));
SQL
  # Only a complete document replaces the previous pool; a failed psql leaves the old file.
  if [[ -s "$STANDARD_USERS_POOL.tmp" ]] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$STANDARD_USERS_POOL.tmp" 2>/dev/null; then
    chmod 600 "$STANDARD_USERS_POOL.tmp"
    mv "$STANDARD_USERS_POOL.tmp" "$STANDARD_USERS_POOL"
    log "wrote $STANDARD_USERS_POOL"
  else
    mv "$STANDARD_USERS_POOL.tmp" "$STANDARD_USERS_POOL.failed" 2>/dev/null || true
    die "the standard-user pool query produced no JSON (see $STANDARD_USERS_POOL.failed)"
  fi
fi

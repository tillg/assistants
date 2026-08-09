#!/bin/sh
#
# SPDX-License-Identifier: EUPL-1.2 OR LicenseRef-commercial
#
# Copyright (c) 2012-2026 mgm technology partners GmbH
#
# Dual License
# ------------
# This source file is part of the mgm A12 Platform and available under
# a choice of two different licenses:
#
# 1. Open-Source License - EUPL v1.2
#    You may redistribute and/or modify this file under the terms of the
#    European Union Public License, version 1.2 - see https://eupl.eu/.
#
# 2. Commercial License
#    Alternatively, you may obtain a commercial license from
#    mgm technology partners GmbH, that permits use of this software
#    under different terms (including support and maintenance services).
#
#    Please contact a12-license@mgm-tp.com for more information.
#
# You must select and comply with exactly one of the above license options.
#
# Warranty Disclaimer (applies to either option)
# ----------------------------------------------
# THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND,
# WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
# OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NON-INFRINGEMENT, EXCEPT WHERE SUCH DISCLAIMERS ARE HELD TO BE
# LEGALLY INVALID. SEE THE RESPECTIVE LICENSE TEXT FOR DETAILS.
#
# Headless bootstrap for Firefly III:
#   0. reuse an existing, still-valid token from $TOKEN_FILE (idempotency)
#   1. wait for /healthcheck
#   2. register the first user (becomes owner/admin) -- or log in if it exists
#   3. mint a Personal Access Token -> $TOKEN_FILE
#
# No artisan command can mint a PAT, so this drives the same HTTP endpoints the
# web UI uses. Only sh, curl and the busybox text tools are required -- deliberately
# nothing that has to be installed at start-up, so an offline `up` still works.
set -eu

BASE="${BASE:-http://firefly:8080}"
EMAIL="${FIREFLY_EMAIL:-bot@example.com}"
PASSWORD="${FIREFLY_PASSWORD:-correct-horse-battery-staple}"   # min 16 chars
TOKEN_NAME="${TOKEN_NAME:-assistants-runtime}"
TOKEN_FILE="${TOKEN_FILE:-/firefly-token/pat.txt}"

WORK="$(mktemp -d)"
CJ="$WORK/cookies"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- 1. wait
printf 'waiting for %s/healthcheck ' "$BASE"
i=0
while [ "$i" -lt 120 ]; do
  if curl -fsS -o /dev/null "$BASE/healthcheck" 2>/dev/null; then echo ' up'; break; fi
  printf .
  i=$((i + 1))
  sleep 2
done
curl -fsS -o /dev/null "$BASE/healthcheck" || { echo 'FAILED: firefly never became healthy'; exit 1; }

# ------------------------------------------------- 0. existing token wins
if [ -s "$TOKEN_FILE" ]; then
  if curl -fsS -o /dev/null \
       -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
       -H 'Accept: application/json' "$BASE/api/v1/about"; then
    # Re-apply the mode even on the reuse path: a token minted by an older build is 0600 and
    # the Runtime (unprivileged) cannot read it.
    chmod 0644 "$TOKEN_FILE" 2>/dev/null || true
    echo "token:      reusing existing valid token from $TOKEN_FILE"
    exit 0
  fi
  echo "token:      $TOKEN_FILE exists but is not accepted -- minting a new one"
fi

get_form_token() {
  curl -sS -b "$CJ" -c "$CJ" "$BASE$1" \
    | grep -oE 'name="_token" value="[^"]+"' | head -1 | cut -d'"' -f4 || true
}

# ------------------------------------------------------------ 2. register
# On a fresh install this creates the owner/admin and opens the session.
# On a re-run it bounces back to /register with a validation error, which is
# fine -- the login step below picks it up.
curl -sS -b "$CJ" -c "$CJ" -o /dev/null -w 'register:   HTTP %{http_code} -> %{redirect_url}\n' \
  -X POST "$BASE/register" \
  --data-urlencode "_token=$(get_form_token /register)" \
  --data-urlencode "email=$EMAIL" \
  --data-urlencode "password=$PASSWORD" \
  --data-urlencode "password_confirmation=$PASSWORD"

# --------------------------------------------------------------- 3. login
# GET /login redirects to /home when the session is already authenticated, so
# an empty form token means "registration already logged us in".
LT="$(get_form_token /login)"
if [ -n "$LT" ]; then
  curl -sS -b "$CJ" -c "$CJ" -o /dev/null -w 'login:      HTTP %{http_code} -> %{redirect_url}\n' \
    -X POST "$BASE/login" \
    --data-urlencode "_token=$LT" \
    --data-urlencode "email=$EMAIL" \
    --data-urlencode "password=$PASSWORD"
else
  echo 'login:      skipped (already authenticated)'
fi

# ---------------------------------------------------------- 4. oauth page
# REQUIRED: this page lazily creates the Passport "personal access grant"
# client. Without it the next step fails. Take the CSRF token from its
# <meta name="csrf-token"> -- the XSRF-TOKEN cookie is stale after the session
# was regenerated and yields "CSRF token mismatch".
CSRF="$(curl -sS -b "$CJ" -c "$CJ" "$BASE/profile/oauth" \
        | grep -oE '<meta name="csrf-token" content="[^"]+"' | cut -d'"' -f4)"
if [ -z "$CSRF" ]; then
  echo 'FAILED: not authenticated -- /profile/oauth carried no csrf-token'
  exit 1
fi
echo "oauth page: csrf $(printf '%.8s' "$CSRF")..."

# ----------------------------------------------------------- 5. mint a PAT
curl -sS -b "$CJ" -c "$CJ" -X POST "$BASE/oauth/personal-access-tokens" \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -H "X-CSRF-TOKEN: $CSRF" \
  -d "{\"name\":\"$TOKEN_NAME\",\"scopes\":[]}" \
  -o "$WORK/pat.json" -w 'PAT:        HTTP %{http_code}\n'

# The response is one flat JSON object and a PAT is base64url, so it never contains a quote --
# the same grep/cut extraction the CSRF step above uses is enough, and it keeps python3 off the
# dependency list.
ACCESS_TOKEN="$(grep -oE '"accessToken" *: *"[^"]+"' "$WORK/pat.json" | head -1 | cut -d'"' -f4)"
if [ -z "$ACCESS_TOKEN" ]; then
  echo "FAILED: no accessToken in the response -- $(head -c 300 "$WORK/pat.json")"
  exit 1
fi
mkdir -p "$(dirname "$TOKEN_FILE")"
printf '%s' "$ACCESS_TOKEN" > "$TOKEN_FILE"
# 0644, not 0600: this file is handed to the Runtime container through a shared volume, and the
# Runtime deliberately runs as an unprivileged user, so a root-owned 0600 file is unreadable to it
# (EACCES, which surfaces as every bookkeeping call failing). The volume is internal to the compose
# stack, and the token is a development one.
chmod 0644 "$TOKEN_FILE"
echo "accessTokenId: $(grep -oE '"accessTokenId" *: *"?[^",}]+' "$WORK/pat.json" | head -1 | cut -d: -f2- | tr -d '" ')"
echo "-> $TOKEN_FILE ($(printf '%s' "$ACCESS_TOKEN" | wc -c | tr -d ' ') chars)"

# ------------------------------------------------------------- 6. verify
curl -fsS -o /dev/null \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -H 'Accept: application/json' "$BASE/api/v1/about"
echo 'verify:     token accepted by /api/v1/about'

#!/bin/sh
# SPDX-License-Identifier: EUPL-1.2
#
# Copyright (c) 2026 Till Gartner
#
# Part of Assistants.
#
# Licensed under the European Union Public Licence, version 1.2 - see
# https://eupl.eu/ and the LICENSE file at the root of this repository.
# Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.
# Headless bootstrap for Firefly III:
#   0. reuse an existing, still-valid token from $TOKEN_FILE (idempotency)
#   1. wait for /healthcheck
#   2. mint a Personal Access Token -> $TOKEN_FILE
#
# No artisan command can mint a PAT, so this drives the same HTTP endpoints the
# web UI uses. Only sh, curl and the busybox text tools are required -- deliberately
# nothing that has to be installed at start-up, so an offline `up` still works.
#
# There is no password anywhere in here. Firefly runs with AUTHENTICATION_GUARD=
# remote_user_guard, so it takes the user's identity from X-Forwarded-Email and creates
# the account on first sight -- which is what firefly-proxy does for a browser after
# Keycloak has authenticated it, and what this script does directly. $EMAIL must be the
# `email` of the Keycloak user who will browse the books, or the Runtime writes its
# transactions into an account nobody looks at.
set -eu

BASE="${BASE:-http://firefly:8080}"
EMAIL="${FIREFLY_EMAIL:-bot@example.com}"
TOKEN_NAME="${TOKEN_NAME:-assistants-runtime}"
TOKEN_FILE="${TOKEN_FILE:-/firefly-token/pat.txt}"

# Every authenticated request carries it; the guard performs no validation beyond
# "is it non-empty", which is why Firefly publishes no port of its own.
AUTH_HEADER="X-Forwarded-Email: $EMAIL"

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

# ---------------------------------------------------------- 2. oauth page
# REQUIRED, and it does three things at once: the guard creates the account for
# $EMAIL if this is the first request it has ever seen, Firefly opens a session, and
# the page lazily creates the Passport "personal access grant" client the next step
# needs. Take the CSRF token from its <meta name="csrf-token"> -- the XSRF-TOKEN
# cookie is stale after the session was regenerated and yields "CSRF token mismatch".
CSRF="$(curl -sS -b "$CJ" -c "$CJ" -H "$AUTH_HEADER" "$BASE/profile/oauth" \
        | grep -oE '<meta name="csrf-token" content="[^"]+"' | cut -d'"' -f4)"
if [ -z "$CSRF" ]; then
  echo "FAILED: not authenticated as $EMAIL -- /profile/oauth carried no csrf-token"
  exit 1
fi
echo "oauth page: authenticated as $EMAIL, csrf $(printf '%.8s' "$CSRF")..."

# ----------------------------------------------------------- 3. mint a PAT
curl -sS -b "$CJ" -c "$CJ" -H "$AUTH_HEADER" -X POST "$BASE/oauth/personal-access-tokens" \
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

# ------------------------------------------------------------- 4. verify
curl -fsS -o /dev/null \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -H 'Accept: application/json' "$BASE/api/v1/about"
echo 'verify:     token accepted by /api/v1/about'

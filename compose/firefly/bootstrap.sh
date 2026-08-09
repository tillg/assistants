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
# web UI uses. Only curl + python3 are required.
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

TOKEN_FILE="$TOKEN_FILE" WORK="$WORK" python3 - <<'PY'
import json, os, sys
d = json.load(open(os.environ['WORK'] + '/pat.json'))
if not d.get('accessToken'):
    print('FAILED:', json.dumps(d)[:300]); sys.exit(1)
path = os.environ['TOKEN_FILE']
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as fh:
    fh.write(d['accessToken'])
os.chmod(path, 0o600)
print('accessTokenId:', d['accessTokenId'])
print('expiresIn    :', d['expiresIn'], 's')
print('-> %s (%d chars)' % (path, len(d['accessToken'])))
PY

# ------------------------------------------------------------- 6. verify
curl -fsS -o /dev/null \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -H 'Accept: application/json' "$BASE/api/v1/about"
echo 'verify:     token accepted by /api/v1/about'

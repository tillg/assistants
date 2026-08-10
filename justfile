# Assistants — the command surface.
#
# `just` with no arguments lists everything. Every recipe here is documented in README.md.

set shell := ["bash", "-uc"]

compose := "docker compose -p assistants -f compose/docker-compose.yml --env-file .env"

# Recipes run under bash, which does not source the interactive shell profile — so tools managed
# by sdkman and nvm are not on PATH the way they are in a terminal. Resolve them explicitly, and
# fall back to the version manager's current selection.
gradle  := '"$(command -v gradle || echo "$HOME/.sdkman/candidates/gradle/current/bin/gradle")" --no-daemon'

# Show the available commands.
default:
    @just --list --unsorted

# ---------------------------------------------------------------------------- setup

# Refuses to overwrite an existing .env, and that is not politeness: the database passwords are
# baked into the Postgres volume when it is first created, so replacing them on a stack that has
# already run locks the server out of its own data until `just clean` drops the volume.
#
# (The blank line below matters: `just --list` shows only the last comment line before a recipe,
# so the one-line summary has to stand on its own.)

# Write .env from .env.example, generating every machine credential. Run once, per clone.
setup:
    @node scripts/setup-env.mjs
    @just render-secrets
    @echo ""
    @echo "  The login passwords in .env are development defaults — see README."
    @echo "  Next: just dev"

# Keycloak does no variable substitution of its own — it stores `${env.VAR}` as that literal
# string (D-023) — so the passwords have to be substituted before it ever sees them.

# Render compose/keycloak/*.template into the files Keycloak imports, using .env.
render-secrets:
    @node compose/keycloak/render.mjs

# ---------------------------------------------------------------------------- the stack

# Build everything and bring the whole stack up, then load the Assistants. Idempotent.
dev: build up wait bootstrap
    @echo ""
    @echo "  Assistants   http://localhost:8081   (human / human, via Keycloak)"
    @echo "  Bookkeeping  http://localhost:8084   (the same login, through oauth2-proxy)"
    @echo "  Keycloak     http://localhost:8089   (console: admin / admin)"
    @echo "  ThingStore   http://localhost:8082/actuator/health"
    @echo ""
    @echo "  Next: just demo-data     — load a demo household"
    @echo "        just logs runtime  — watch the Assistants work"

# Build the models, the server jars, the client bundle and all images.
#
# `npm ci` in runtime/ is not redundant with the Dockerfile: the image installs its own copy, but
# `just bootstrap`, `demo-data`, `pause`, `resume` and the test tiers all run from the HOST, and
# on a fresh clone there is no node_modules for them to run from.
build:
    @cd runtime && npm ci --no-audit --no-fund
    {{gradle}} convertModels
    {{gradle}} buildImages
    {{compose}} build runtime

# `render-secrets` first, on every `up` and not only in `setup`: the files Keycloak imports are
# generated from .env, and .env can be edited afterwards. Rendering here is what keeps the two
# from drifting apart — silently, since a stale password fails only at login.

# Start the stack in the background (assumes images are built).
up: render-secrets
    {{compose}} --profile server-init up -d

# Wait until every service is answering.
wait:
    @echo "waiting for the stack..."
    @for i in $(seq 1 120); do \
        if curl -fsS http://localhost:8082/actuator/health >/dev/null 2>&1 \
           && curl -fsS http://localhost:8084/healthcheck >/dev/null 2>&1 \
           && curl -fsS http://localhost:8089/realms/A12Realm >/dev/null 2>&1 \
           && curl -fsS http://localhost:8081 >/dev/null 2>&1; then \
            echo "the stack is up"; exit 0; \
        fi; \
        sleep 2; \
    done; \
    echo "the stack did not come up in time — try: just logs"; exit 1

# Stop the stack, keeping the data.
down:
    {{compose}} --profile server-init down

# Restart one service, or all of them.
#
# Restarting `server` on its own is a trap: nginx in the frontend resolves its upstreams once at
# startup, so the server's new container IP leaves every /api call answering 502 and the login
# form never renders. Restarting the server therefore takes the frontend with it.
restart service="":
    #!/usr/bin/env bash
    set -uo pipefail
    if [ "{{service}}" = "server" ]; then
        {{compose}} restart server frontend
    else
        {{compose}} restart {{service}}
    fi

# Show what is running.
ps:
    {{compose}} ps

# Follow the logs. `just logs runtime` is the debugging surface for the agentic loop.
logs service="":
    {{compose}} logs -f --tail=200 {{service}}

# ---------------------------------------------------------------------------- data

# Every recipe below runs on the HOST, so it needs the host's spelling of each service. The
# Runtime's own defaults are the compose network's names (`server:8080`, `keycloak:8080`), which
# do not resolve out here. Keycloak in particular is easy to forget: the token comes from there
# now, not from the ThingStore, so a recipe that overrides only THINGSTORE_URL fails at login.
host_urls := "THINGSTORE_URL=http://localhost:8082 KEYCLOAK_URL=http://localhost:8089"

# Load what the system IS: the two Assistants and the runtime state. Idempotent.
bootstrap:
    @cd runtime && {{host_urls}} npm run --silent bootstrap

# Load what the household HAS: parties, processes, documents, invoices and the books.
# Pauses the Runtime while loading so the demo set lands as history, not as a work queue.
demo-data:
    @cd runtime && {{host_urls}} FIREFLY_URL=http://localhost:8084 \
        FIREFLY_TOKEN="$(just firefly-token)" npm run --silent demo

# Wipe everything and rebuild from scratch, including the books.
# `build` is not optional here: `clean` deletes build/wcf-output/data/models, which `up`
# bind-mounts -- Docker would recreate it empty and the server would import zero models.
# Firefly has no bulk delete and its data lives in a named volume, so a full teardown is the
# only reset that is symmetric across both Authorities (ADR-0006, as an operational consequence).
demo-reset: clean build up wait bootstrap demo-data

# Read it through the Runtime, which already has the token volume mounted -- no volume name to
# guess and no second, differently-prefixed spelling of it to keep in sync.
# Print the Firefly personal access token the bootstrap container minted.
firefly-token:
    @{{compose}} exec -T runtime cat /run/firefly/pat.txt

# Stop the Runtime from doing anything (the global kill switch).
pause:
    @cd runtime && {{host_urls}} npx tsx src/bootstrap/cli.ts pause

# Let it work again.
resume:
    @cd runtime && {{host_urls}} npx tsx src/bootstrap/cli.ts resume

# ---------------------------------------------------------------------------- tests

# Everything: models, runtime units, the live-stack integration tier, the client, and
# end-to-end through the real UI.
test: test-models test-runtime test-integration test-client test-e2e

# Both directions of form-model validation, including the ADR-0008 hint.
test-models:
    node import/validate-models.mjs
    {{gradle}} convertModels

# The loop driver's branching: suspension, continuation, recovery, tool gating.
test-runtime:
    @cd runtime && npm test

# Against the LIVE stack: the A12 client, the watcher's queries, the Firefly connector. Skipped
# rather than failed when the stack is down. The tier that catches what the unit fakes cannot.
test-integration:
    @cd runtime && npm run --silent test:integration

# The markdown editor and the client's own units.
test-client:
    @cd client && npm test

# Playwright against the running stack, with a deterministic scripted model.
test-e2e:
    @cd e2e && npm test

# The same end-to-end specs against a live LLM. Skipped without LLM_API_KEY.
test-live:
    @cd e2e && LLM_PROVIDER=openai npm test

# ---------------------------------------------------------------------------- housekeeping

# Typecheck and lint everything that has an opinion.
check:
    @cd runtime && npm run typecheck
    @cd client && npx tsc --noEmit && npm run lint
    node import/validate-models.mjs

# Remove containers, volumes and every build output. Takes the books with it.
clean:
    -{{compose}} --profile server-init down -v --remove-orphans
    -{{gradle}} clean
    rm -rf build client/build runtime/dist e2e/test-results e2e/playwright-report
    @echo 'cleaned. `just dev` will rebuild from scratch.'

# Remove node_modules too — for when a dependency tree has gone wrong.
clean-all: clean
    rm -rf runtime/node_modules client/node_modules e2e/node_modules

# Install every workspace's dependencies. `just build` covers runtime/ and client/; e2e/ is only
# needed to run the end-to-end tier.
install:
    @cd runtime && npm install
    @cd client && npm install
    @cd e2e && npm install

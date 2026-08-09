# Assistants — the command surface.
#
# `just` with no arguments lists everything. Every recipe here is documented in README.md.

set shell := ["bash", "-uc"]

compose := "docker compose -p assistants -f compose/docker-compose.yml --env-file compose/.env"
gradle  := "gradle --no-daemon"

# Show the available commands.
default:
    @just --list --unsorted

# ---------------------------------------------------------------------------- the stack

# Build everything and bring the whole stack up, then load the Assistants. Idempotent.
dev: build up wait bootstrap
    @echo ""
    @echo "  Assistants   http://localhost:8081   (admin / A12PT-admintest)"
    @echo "  ThingStore   http://localhost:8082/actuator/health"
    @echo "  Bookkeeping  http://localhost:8084"
    @echo ""
    @echo "  Next: just demo-data     — load a demo household"
    @echo "        just logs runtime  — watch the Assistants work"

# Build the models, the server jars, the client bundle and all images.
build:
    {{gradle}} convertModels
    {{gradle}} buildImages
    {{compose}} build runtime

# Start the stack in the background (assumes images are built).
up:
    {{compose}} --profile server-init up -d

# Wait until every service is answering.
wait:
    @echo "waiting for the stack..."
    @for i in $(seq 1 120); do \
        if curl -fsS http://localhost:8082/actuator/health >/dev/null 2>&1 \
           && curl -fsS http://localhost:8084/healthcheck >/dev/null 2>&1 \
           && curl -fsS http://localhost:8081 >/dev/null 2>&1; then \
            echo "the stack is up"; exit 0; \
        fi; \
        sleep 2; \
    done; \
    echo "the stack did not come up in time — try: just logs"; exit 1

# Stop the stack, keeping the data.
down:
    {{compose}} --profile server-init down

# Restart one service, or all of them. Used by the ADR-0004 restart test.
restart service="":
    {{compose}} restart {{service}}

# Show what is running.
ps:
    {{compose}} ps

# Follow the logs. `just logs runtime` is the debugging surface for the agentic loop.
logs service="":
    {{compose}} logs -f --tail=200 {{service}}

# ---------------------------------------------------------------------------- data

# Load what the system IS: the two Assistants and the runtime state. Idempotent.
bootstrap:
    @cd runtime && THINGSTORE_URL=http://localhost:8082 npm run --silent bootstrap

# Load what the household HAS: parties, processes, documents, invoices and the books.
# Pauses the Runtime while loading so the demo set lands as history, not as a work queue.
demo-data:
    @cd runtime && THINGSTORE_URL=http://localhost:8082 FIREFLY_URL=http://localhost:8084 \
        FIREFLY_TOKEN="$(just --quiet firefly-token)" npm run --silent demo

# Wipe everything and rebuild from scratch, including the books.
# Firefly has no bulk delete and its data lives in a named volume, so a full teardown is the
# only reset that is symmetric across both Authorities (ADR-0006, as an operational consequence).
demo-reset: clean up wait bootstrap demo-data

# Print the Firefly personal access token the bootstrap container minted.
firefly-token:
    @{{compose}} run --rm --no-deps -v firefly_token:/t --entrypoint sh firefly-bootstrap -c 'cat /t/pat.txt' 2>/dev/null \
        || docker run --rm -v assistants_firefly_token:/t alpine cat /t/pat.txt

# Stop the Runtime from doing anything (the global kill switch).
pause:
    @cd runtime && THINGSTORE_URL=http://localhost:8082 npx tsx src/bootstrap/cli.ts pause

# Let it work again.
resume:
    @cd runtime && THINGSTORE_URL=http://localhost:8082 npx tsx src/bootstrap/cli.ts resume

# ---------------------------------------------------------------------------- tests

# Everything: models, runtime, client, and end-to-end through the real UI.
test: test-models test-runtime test-client test-e2e

# Both directions of form-model validation, including the ADR-0008 hint.
test-models:
    node import/validate-models.mjs
    {{gradle}} convertModels

# The loop driver's branching: suspension, continuation, recovery, tool gating.
test-runtime:
    @cd runtime && npm test

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
    @echo "cleaned. `just dev` will rebuild from scratch."

# Remove node_modules too — for when a dependency tree has gone wrong.
clean-all: clean
    rm -rf runtime/node_modules client/node_modules e2e/node_modules

# Install the toolchain's dependencies (usually not needed; the builds do it).
install:
    @cd runtime && npm install
    @cd client && npm install
    @cd e2e && npm install

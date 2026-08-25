# Plan — go-live

Ordered so each phase leaves a working system. Read [architecture.md](architecture.md) for the why of
each decision referenced. Every variable introduced **defaults to a localhost value**, so the laptop
stack (`just dev`) must keep passing after every phase — that is the standing verify. The one
intentional break from "identical to today" is the port renumber in Phase 0 (`8080–8084`,
architecture Decision 1): `just dev` still works, on the new contiguous block.

## Phase 0 — Make the stack origin-configurable (code + compose, no server yet)

The riskiest work, done first and entirely on the laptop where it can be tested against `just dev`.

- [ ] Turn the frontend's bookkeeping URL into runtime config: replace the compiled constant in
      `client/src/components/dashboard/BookkeepingButton.tsx:27` with a read from injected runtime config
      (`window.__CONFIG__.bookkeepingUrl`), and have the frontend image's nginx entrypoint write that
      config from a `BOOKKEEPING_URL` env var at container start (default `http://localhost:8084`).
      Update the constant's now-false doc comment (it currently argues the URL is deliberately *not*
      configurable) to describe the runtime-config read.
- [ ] Update the client tests that assert `BOOKKEEPING_URL` to assert the runtime read instead
      (`client/src/test/.../*Bookkeeping*`), without weakening them. **Verify:** `just test-client`.
- [ ] Parameterise the compose host port bindings and renumber to the contiguous block (architecture
      Decision 1): `FRONTEND_HOST_PORT:-8080`, `SERVER_HOST_PORT:-8081`, `KEYCLOAK_HOST_PORT:-8082`,
      `POSTGRES_HOST_PORT:-8083`, `FIREFLY_PROXY_HOST_PORT:-8084` in `docker-compose.yml`. Move the
      references that hardcode the old numbers onto the new base: `justfile` (the `dev` banner, the
      `wait` health-check curls, `host_urls`), `.env.example` (`KEYCLOAK_PUBLIC_URL` → `:8082`),
      `README.md` (the port table and every `localhost:PORT` link), `client/webpack.dev.js` (dev-proxy
      target `8082` → `8081`), and `e2e/utils/config.ts` (`BASE_URL` → `:8080`, `THINGSTORE_URL` →
      `:8081`, `KEYCLOAK_URL` → `:8082`; `FIREFLY_URL` stays `:8084`). The client dashboard tests that
      assert `http://localhost:8084` are unaffected (books port unchanged).
      **Verify:** `just dev` binds `8080/8081/8082/8083/8084`; `just test-client` and `just test-e2e` pass.
- [ ] Parameterise the baked origins in `docker-compose.yml`: `firefly` `APP_URL` → `${FIREFLY_APP_URL}`,
      `firefly-proxy` `OAUTH2_PROXY_REDIRECT_URL` → `${FIREFLY_REDIRECT_URL}` and
      `OAUTH2_PROXY_COOKIE_SECURE` → `${OAUTH2_COOKIE_SECURE:-false}`, `runtime` `UI_BASE_URL` →
      `${UI_BASE_URL}`. Add the defaults to `.env.example`.
- [ ] Parameterise the Keycloak realm template: add `APP_ORIGIN`/`BOOKKEEPING_ORIGIN` vars to
      `compose/keycloak/A12Realm-realm.json.template` (SPA client `redirectUris`/`webOrigins`, the
      Firefly-proxy client, and post-logout URIs) and to `compose/keycloak/render.mjs`'s var set, with
      localhost defaults in `.env.example`. **Verify:** `just render-secrets` produces byte-identical
      realm files to before when the defaults are used; `just demo-reset` logs in end to end.
- [ ] Confirm `PROJECT_NAME` is a first-class per-Environment variable (architecture Decision 1): the
      explicit `container_name: ${PROJECT_NAME}_<svc>` bindings are what isolate containers, since `-p`
      does not namespace explicit container names. Keep the `${PROJECT_NAME:-assistants}` default on the
      services that lack one so `just dev` is unchanged, and reconcile `COMPOSE_PROJECT_NAME` in
      `.env.example` (drop it, or keep it equal to the project name). **Verify:** `just dev` still names
      containers `assistants_*`.
- [ ] Make the four image references uniform and decouple the runtime image from `PROJECT_NAME`
      (architecture Decision 5): all of `frontend`, `server`, `server-init`, `runtime` become
      `${IMAGE_REGISTRY:-assistants}/<svc>:${IMAGE_TAG:-0.1.0}`. This replaces the whole-string
      `${FRONTEND_IMAGE}`/`${SERVER_IMAGE}`/`${SERVER_INIT_IMAGE}` vars **and** the composed
      `${PROJECT_NAME}/runtime:${PROJECT_VERSION}` ref (compose line 386), so `PROJECT_NAME` no longer
      names an image. **Verify:** `just build && just up` (defaults still resolve to `assistants/…:0.1.0`).
- [ ] Full regression on the laptop: `just check` and `just test`. This is the gate out of Phase 0.

## Phase 1 — The GitHub Actions pipeline (build → ghcr)

- [ ] Add `.github/workflows/images.yml`: on push to `main` and on tags, set up JDK 21 / Node 24 /
      Gradle, run `gradle convertModels`, `gradle buildImages`, and the runtime image build; log in to
      ghcr with `GITHUB_TOKEN` (`packages: write`); tag images `ghcr.io/tillg/assistants/<svc>:<version>`
      and `:<git-sha>`; push all four (frontend, server, server-init, runtime).
- [ ] Wire the registry knobs in `gradle.properties` (`dockerRegistryForPublish`, `dockerUseCredentials`)
      to target ghcr, matching the image names the compose refs expect.
- [ ] **Verify:** the workflow run pushes four tags; confirm they are pullable
      (`docker pull ghcr.io/tillg/assistants/frontend:<sha>` from a machine with a read token).

## Phase 2 — DNS + secrets

- [ ] Create a GoDaddy API token (key+secret) for `grtnr.com` and a ghcr read-only PAT for the box.
      **Spike first (blocks the whole edge):** confirm the key actually works — create and delete one
      TXT record via the GoDaddy API. GoDaddy restricted API access for smaller accounts in 2024; if the
      key is inert, switch `grtnr.com`'s DNS to a Caddy-supported DNS-01 provider (e.g. Cloudflare) and
      use that provider's module/token instead — the rest of Phase 4's `caddy` role is unchanged bar the
      provider name. **Verify:** the test TXT record appears and clears.
- [ ] At GoDaddy, add A records for the six hostnames (`assistants`, `auth.assistants`,
      `books.assistants`, `test.assistants`, `auth.test.assistants`, `books.test.assistants`
      under `grtnr.com`) → clawdia's LAN IP. **Verify:** the names resolve to the LAN IP from the VPN.
- [ ] Give clawdia a static LAN lease so the A records stay valid.
- [ ] Create `deploy/vault/{test,prod}.vault.yml` (ansible-vault): LLM API key, the four login passwords
      (replacing the weak dev defaults), the ghcr PAT, the GoDaddy token.

## Phase 3 — `deploy/` scaffolding (Ansible)

- [ ] Create the `deploy/` tree per architecture Decision 6: `ansible.cfg`, `inventory.yml`
      (clawdia, `ansible_user=tillg`), `group_vars/{all,prod,test}.yml`, `roles/{docker,caddy,environment,app}`,
      `playbooks/{provision,wipe,deploy}.yml`, `Caddyfile.j2`.
- [ ] `group_vars`: define the hostname scheme, `IMAGE_REGISTRY=ghcr.io/tillg/assistants`, the port
      base (`8080`), PROD with offset `0` and TEST with offset `+10`, and `PROJECT_NAME` /
      project names `assistants-prod` / `assistants-test`.
- [ ] **Verify:** `ansible-inventory --list` and `ansible clawdia -m ping` succeed over SSH/VPN.

## Phase 4 — Provision clawdia

- [ ] `wipe.yml`: first *report* what is on the box (containers, compose projects, listening ports, web
      servers, systemd units), then remove only what is clearly not ours — never a blanket prune or a
      data-volume wipe. Run it and **read the report before confirming** the removal step.
- [ ] `docker` role: install Docker Engine + compose plugin (≥2.20.3) on Ubuntu; add `tillg` to the
      `docker` group. Confirm outbound reachability to the registries the box pulls from — **ghcr.io,
      docker.io and quay.io** (base images come from the latter two, architecture Decision 5); if Docker
      Hub's anonymous pull-rate limit bites, authenticate the box to docker.io as well. **Verify:**
      `docker compose version`, and a test pull of one image from each of the three registries.
- [ ] `caddy` role: install Caddy **with the `caddy-dns/godaddy` module**; render `Caddyfile.j2` with all
      six hostnames and the `acme_dns godaddy {env.GODADDY_API_TOKEN}` block; run Caddy as a host service
      with the GoDaddy token from the vault. **Verify:** Caddy obtains a valid certificate for each of
      the six hostnames (check its logs / cert store) — no service behind it yet.

## Phase 5 — Roll out TEST (prove the sequence on throwaway data first)

- [ ] `environment` role: generate `deploy/env/test.env` (setup-env semantics; secrets from the vault),
      set the TEST hostnames, `PROJECT_NAME=assistants-test`, the `+10` ports (`8090–8094`),
      `OAUTH2_COOKIE_SECURE=true`, `KEYCLOAK_PUBLIC_URL` and the origins to the
      `…test.assistants.grtnr.com` names; render the Keycloak files for TEST.
- [ ] Switch TEST's Keycloak to production mode in compose via env (`start`, `KC_HOSTNAME`,
      `KC_PROXY_HEADERS=xforwarded`, `KC_HTTP_ENABLED=true`) — driven by an env flag so `just dev` keeps
      `start-dev`.
- [ ] `app`/`deploy.yml` for TEST: `docker login ghcr`, pull the four tags, `compose -p assistants-test
      --env-file test.env up -d` (with the `server-init` profile), wait, bootstrap.
- [ ] **Verify (the real acceptance test):** from a VPN browser, `https://test.assistants.grtnr.com`
      loads with a trusted cert, login via `auth.test.…` succeeds over HTTPS, the dashboard opens the
      books at `books.test.…`, and no `localhost` appears in any request. Run a `just test-e2e`-equivalent
      smoke against the TEST hostname (`BASE_URL=https://test.assistants.grtnr.com`) — this is the
      automated half of TEST's acceptance, not an optional extra.

## Phase 6 — Roll out PROD

- [ ] Repeat the Phase 5 env/render/deploy steps for PROD with `deploy/env/prod.env`, the
      `assistants.grtnr.com` hostnames, `PROJECT_NAME=assistants-prod`, and offset `0` (ports
      `8080–8084`) — the sequence now proven on TEST.
- [ ] Do **not** load demo data on PROD; bootstrap the Assistants and runtime state only.
- [ ] **Verify:** `https://assistants.grtnr.com` end to end as in Phase 5; confirm TEST and PROD share
      no volume (`docker volume ls` shows the two prefixes) and that pausing/dropping TEST leaves PROD
      untouched.

## Phase 7 — Documentation

- [ ] Update `README.md` with a "Deploying to a server" section: the `deploy/` commands (provision,
      wipe, deploy per env), the hostname scheme, and where secrets live. (Per the standing rule to
      document user-visible capability in the same change.)
- [ ] Record the load-bearing choices in `DECISIONS.md`: two compose projects on one host, Caddy +
      DNS-01 via GoDaddy, one image per registry tag serving both Environments, and Keycloak production
      mode — each with its rejected alternative and reversal cost.

## Definition of done

- One command each provisions, wipes, and rolls out an Environment from the home network.
- Both application URLs load over HTTPS with a trusted certificate, log in through Keycloak, and open
  the books — no `localhost`, no cert warning.
- TEST and PROD share nothing; `just dev` on the laptop still works (on the renumbered `8080–8084`).
- `just check` and `just test` pass on the laptop after all code changes.

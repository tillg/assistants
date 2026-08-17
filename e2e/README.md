<!--
SPDX-License-Identifier: EUPL-1.2

Copyright (c) 2026 Till Gartner

Part of Assistants.

Licensed under the European Union Public Licence, version 1.2 - see
https://eupl.eu/ and the LICENSE file at the root of this repository.
Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.
-->

# End-to-end tests

Playwright, driving the **real** stack: the A12 web application, the ThingStore, the Runtime and
Firefly III. Nothing here is mocked. The only substitution is the LLM itself — the Runtime runs
on the `scripted` profile in `llm.json`, replaying `runtime/fixtures/llm-script.json`, which is what makes a
loop driven by a paid, non-deterministic third party assertable at all.

## Running them

The stack has to be up first:

```bash
just dev            # build, start, wait, bootstrap the two Assistants
just test-e2e       # == cd e2e && npm test
```

or, from this directory:

```bash
npm install
npx playwright install chromium     # first time only
npm test                            # the whole suite, in order
```

Useful subsets:

```bash
npm run e2e:test        # the base project only — fast, no Assistants involved
npm run e2e:test-flow   # the two flow specs only
npm run e2e:test-ui     # the Playwright UI runner
npm run e2e:report      # open the last HTML report
npm run typecheck       # tsc --noEmit
```

Against a live model instead of the scripted one: point `active` in `llm.json` at a live profile,
`just restart runtime`, then from the repository root:

```bash
just test-live          # refuses to run while llm.json is on `scripted`
```

These specs drive the browser and never knew which model was behind the stack, which is why the
switch is the Runtime's configuration rather than a variable on this command.

Environment overrides: `BASE_URL` (8081), `THINGSTORE_URL` (8082), `FIREFLY_URL` (8084),
`KEYCLOAK_URL` (8089), `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`,
`FIREFLY_TOKEN` (otherwise read out of the running `runtime` container), `AGENT_TIMEOUT_MS`.

## What is in here

| Spec | Proves |
|---|---|
| `tests/base/0-clean.setup.ts` | Setup: removes Things earlier runs left behind (`E2E`-prefixed Parties and Documents), behind the Runtime's kill switch |
| `tests/base/1-login.spec.ts` | Every user can log in and the application frame renders |
| `tests/base/2-navigation.spec.ts` | All eight modules are reachable from the menu and their overviews render |
| `tests/base/3-crud.spec.ts` | Full CRUD on a Party through the UI: create, read, update, delete, each verified after a reload |
| `tests/base/4-markdown-editor.spec.ts` | An Assistant's `systemPrompt` renders the Lexical markdown editor, not a text area, and markdown round-trips through a save |
| `tests/base/5-localization.spec.ts` | The language switch |
| `tests/base/6-favicon.spec.ts` | The favicon |
| `tests/flow/1-invoice-slice.spec.ts` | A Document arrives → Receptionist classifies it → Invoice → Accountant asks → the User answers in the UI → a real transaction in Firefly |
| `tests/flow/2-restart.spec.ts` | ADR-0004: restarting the Runtime and the ThingStore mid-wait loses nothing, and the answer still continues the Conversation |

## How the suite is ordered

Playwright projects, chained by `dependencies`:

```
setup-auth → setup-base → base → flow-invoice → flow-restart
                                                     ↓
                                                  cleanup
```

`base` runs in parallel; the two flow specs are separate projects precisely because Playwright
has no per-project worker limit, and the restart spec pulls the stack out from under anything
running beside it.

## Two rules for anything added here

1. **Never delete a `Conversation` or an `OpenQuestion`.** They are Runtime-owned. Removing one
   mid-flight strands a Conversation on a question that no longer exists, and the failure shows up
   somewhere else entirely.
2. **Destructive setup runs behind the kill switch.** `ThingStore.withRuntimePaused()` sets
   `RuntimeState.paused`, does the work and clears it again. Deleting Things the watcher is
   scanning, without it, is how this suite would become flaky.

Everything the tests create is prefixed `E2E`, so the clean-up pass can tell its own leftovers
from the demo household (`just demo-data`) and never touches the latter.

## The pieces

- `pages/` — page objects. `BasePage` (navigation), `FormPage` (fields, read-only/edit mode,
  markdown controls), `OverviewPage` (tables, search, row actions), `OpenQuestionPage` (answering).
- `utils/thingstore.ts` — JSON-RPC client for the ThingStore. The store runs UAA with
  `authentication.types=OAUTH2` and has no login endpoint at all, so the token comes from
  Keycloak's direct access grant and goes out as a plain `Bearer`. Also the `waitFor` poll every
  cross-component assertion uses, and the kill switch.
- `utils/agents.ts` — the agentic domain as the tests see it: drop a Document in, wait for the
  Conversation, wait for the Open Question, wait for `done`.
- `utils/firefly.ts` — Firefly III's REST API, and reading the bootstrap token out of the running
  Runtime container. Port 8084 is oauth2-proxy, not Firefly, but `/api/` is a route the proxy
  passes straight through — Firefly checks the personal access token on a guard of its own.
- `utils/stack.ts` — `docker compose restart`, for the ADR-0004 spec only.

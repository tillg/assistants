# Decisions & assumptions made autonomously

This file records every decision I had to take on my own while the user was away, and
every assumption I made because there was nobody to ask. Review it top to bottom.

Session started: 2026-08-09 17:44 CEST.

## Format

Each entry: **what was decided**, **why**, **what the alternative was**, and
**how expensive it is to reverse**.

---

## D-001 — Research before proposing

**Decided**: Spend the first phase on parallel research (A12 platform anatomy, the
w12-on-a12 markdown editor, registry/toolchain feasibility, Firefly III automation)
before writing any spec artefacts.

**Why**: The brief pins the platform (A12) and a specific reusable component
(the markdown editor from `w12-on-a12`), and demands a single `docker compose`
that includes the bookkeeping system. Whether that is achievable at all depends on
facts I did not have — registry access, image availability, headless bootstrap of
Firefly III. Proposing before knowing would have produced a fictional plan.

**Alternative**: Propose first, discover blockers during implementation.

**Reversal cost**: None.

---

## D-002 — LLM provider is configurable; OpenAI-compatible is the default

**Decided**: The Runtime talks to the LLM through a small provider interface. The
default implementation speaks the OpenAI-compatible chat-completions API (base URL,
model and key all configurable), with an Anthropic implementation alongside it.

**Why**: This machine has `OPENAI_API_KEY` and `AZURE_OPENAI_W12_API_KEY` in the
environment and **no** `ANTHROPIC_API_KEY`, so OpenAI is what actually works here
today. The interface keeps the choice from spreading through the code.

**Alternative**: Hard-wire Anthropic (would not run on this machine without a key).

**Reversal cost**: Low — one adapter class.

---

## D-003 — The application is scaffolded from the A12 **local-auth** project template, 2026.06

**Decided**: The repository is built on
`@com.mgmtp.a12.projecttemplate/project-template-local-auth@202606.0.1`, taken from the
**public** A12 community registry `https://artifacts.geta12.com/artifactory/api/npm/a12-community-npm/`.

**Why**: Three things fall out of it at once.
1. It resolves **without VPN and without credentials** — the internal `artifacts.mgm-tp.com`
   and `dockerregistry.mgm-tp.com` are VPN-only, so building on them would make the repo
   unbuildable off the corporate network.
2. It uses **UAA `LOCAL` authentication instead of Keycloak** — users are YAML files under
   `import/auth/users/`. That removes an entire service (and a realm import, and a second
   database) from the compose stack the brief asks to keep to one.
3. Its base images come from `docker.io` (`dockerRegistryForRead=docker.io`,
   `dockerUseCredentials=false`).

The 2026.06 line (not 2025.06) because the markdown editor we are lifting from `w12-on-a12`
is written against `widgets-core@39.0.2` / `formengine-core@39.0.0`, which *is* 2026.06.
Aligning the lines avoids porting the editor across an A12 major version.

**Alternative**: the base template with Keycloak (heavier, and its realm is dev-only anyway),
or the 2025.06 line (would force a backport of the editor).

**Reversal cost**: High. This is the platform decision — it is ADR-0001 made concrete.

**Note for the user**: the template's own README warns that LOCAL auth is for
development/demo/training only, not production. For a single-household system run on a laptop
that is the right trade, but it is a real limitation and worth knowing about.

---

## D-004 — Bookkeeping is Firefly III on SQLite, bootstrapped headlessly

**Decided**: `fireflyiii/core:version-6.6.6` in the same compose file, `DB_CONNECTION=sqlite`,
with a bootstrap script that registers the first user and mints a Personal Access Token over
Firefly's own web endpoints.

**Why**: ACCOUNTING.md already chose Firefly III. What was unknown was whether it could be
brought up with *zero manual steps*, which the brief requires ("one docker compose with all in
it"). It can: SQLite is a supported, explicitly handled branch in the image entrypoint (no
second database container), and although no `artisan` command can mint a token, the
`/register` → `/profile/oauth` → `/oauth/personal-access-tokens` sequence does it headlessly.
Verified end to end: cold start to usable token in 8 seconds.

**Alternative**: MariaDB alongside (one more container), or asking the user to click through
Firefly's setup once (breaks the zero-touch requirement).

**Reversal cost**: Low — swapping SQLite for MariaDB is a compose edit.

---

## D-005 — The ThingStore is the only integration surface; the Runtime polls it

**Decided**: The Runtime (trigger watcher + loop driver) neither exposes an API to the
UserInterface nor receives webhooks from it. It **polls the A12 Data Service** for work:

- a Thing created since the last scan → a Trigger, births a Conversation;
- a Conversation with `waitingFor = user` whose `answer` field has been filled in → continue it;
- a Conversation whose `wakeAt` has passed → continue it.

The User answers an Open Question by *editing the Conversation Thing in the ordinary A12 form
and saving it*. There is no custom client code and no second API.

**Why**: ADR-0004 says waiting is never a running process and the Conversation is the state;
the AGENTIC_LOOP survey found the same convergence in all three systems it studied ("the store
is the truth, events are a projection"). Polling one store is the most direct expression of
that, it makes restart a non-event, and for a single-household system a 2-second scan is
free. It also means Manual Connectors, `askUser`, and Assistant-to-Assistant calls all
funnel through *one* mechanism — exactly what ADR-0005 predicts.

**Alternative**: a REST API on the Runtime plus custom buttons in the A12 client. More code,
a second authority for pending work, and a live process holding state.

**Reversal cost**: Medium — the polling loop is small, but the "answer by editing the Thing"
convention shows up in the form models.

---

## D-006 — Artefact registries are pinned in the repository, not inherited from the machine

**Decided**: The repo commits its own `.npmrc` (all 17 `@com.mgmtp.a12.*` scopes →
`https://artifacts.geta12.com/artifactory/api/npm/a12-community-npm/`) and its own Gradle
`pluginManagement` / `dependencyResolutionManagement` repositories in `settings.gradle`
(`gradlePluginPortal`, `mavenCentral`, `https://artifacts.geta12.com/artifactory/a12-community-maven/`).

**Why**: Neither the A12 project template nor `w12-on-a12` carries this configuration — both
inherit it from `~/.npmrc` and `~/.gradle/init.d/repositories.gradle`, which point at
`artifacts.mgm-tp.com`. That host resolves only over the corporate VPN, so a repo that relies
on it cannot be built by anyone who is not on it, including CI and including this machine
when the VPN drops. The public community registry serves the same 2026.06 artefacts
anonymously (verified: HTTP 200 for `dataservices-server-app-39.0.2.pom`).

The machine-global config stays additive — on VPN both resolve, off VPN only ours does.

**Alternative**: follow the template and rely on machine setup. Rejected as a reproducibility
trap.

**Reversal cost**: Trivial.

---
## D-007 — The Runtime gets its own identity, deliberately weaker than `admin`

**Decided**: A dedicated `runtime` user and `runtime` role with exactly `DOCUMENT_CREATE`,
`DOCUMENT_UPDATE`, `DOCUMENT_PARTIAL_UPDATE`, `QUERY`. No `MODEL_MANAGE`, no `DOCUMENT_DELETE`,
and explicitly not `admin`.

**Why**: raised during grilling and it is a genuinely good catch. The template's
`childAuthorizationDefinition.json` bypasses every ownership policy for the `admin` role, so
running the LLM-driven half of the system as `admin` would hand it the one identity that can
edit and delete anything — the opposite of ADR-0010. And because `__meta.creator` is the only
provenance the store records, an `admin` Runtime would make its writes indistinguishable from
the human's. Withholding `DOCUMENT_DELETE` also turns a hallucinated delete into a 403 rather
than a lost invoice.

**Alternative**: reuse `admin` (one less file, and wrong).

**Reversal cost**: Trivial — two YAML files.

---

## D-008 — The template's copyright-header gate is removed

**Decided**: `copyright/copyright.gradle` and its `check.dependsOn('validateCopyrightHeaders')`
wiring are deleted. Vendored A12 files keep their EUPL/commercial dual-licence headers exactly
as shipped; `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES` are kept.

**Why**: that script is mgm's own release tooling and it enforces the **mgm copyright header on
every source file in the project**. Stamping our own new files with mgm's copyright would be
inaccurate, and it failed the build the moment we added files of our own.

**Alternative**: keep it and add mgm headers to our code (wrong), or keep it and add a growing
exclusion list (pointless).

**Reversal cost**: Trivial.

---

## D-009 — What the grilling changed

Two rounds of adversarial grilling by a fresh agent, eighteen questions. Seventeen accepted,
one rejected on evidence, one accepted in part. The design changes worth knowing about:

- **Round 1 Q1 was rejected on evidence.** The griller argued the markdown editor was on the
  2025.06 A12 line and would need a major-version port. It was reading a stale local checkout at
  `/Users/tgartner/git/w12-on-a12` (`c2df35b`, 2025.06). The remote HEAD `6b8df45` is 2026.06 —
  `formengine-core 39.0.0`, `widgets-core 39.0.2`, `lexical ^0.44.0` — which I re-cloned and
  verified. D-003 stands and the editor stays in scope. Worth recording because the *stale
  checkout* is a trap anyone could fall into again.
- **No `Answer` Thing; the Open Question *is* the Thing.** The Runtime creates an
  `OpenQuestion` when it suspends (the only moment it knows the `conversationId`) and never
  touches it again; the User completes it. A12 has no way to open a create-form pre-filled from
  the row you came from, so a separate Answer Model would have made the User copy a ThingID by
  hand.
- **A12 has no optimistic locking at all** — no version, ETag or revision. Any document written
  by two parties silently loses one party's work. Hence: every document has exactly one writer
  at any instant, the Conversation form is read-only, and `leaseUntil` is crash *recovery*, not
  a lock. Compose runs exactly one Runtime replica, and that is a constraint.
- **The Conversation is an intent log.** The tool call and its idempotency key are written
  *before* the Operation executes, so lease recovery asks the Connector whether the key landed
  instead of re-executing. Without this, a crash between "Firefly returned 200" and "the
  Conversation was written" books €184.30 twice.
- **Enumeration fields are indexed by localised display text**, so every field the watcher
  filters on is a String carrying a code. This one would have been found the hard way.
- **Birth is exactly-once by query**, not by timing: no birth where a Conversation already
  exists for `(assistantKey, subjectThingId)`. The Accountant has no `thing-materialised`
  trigger at all in this change — the Receptionist calls it, and that is the only route.
- **Nothing may end silently.** Terminal failures raise an Open Question rather than setting
  `failed`, so a stuck Conversation appears in the same view as everything else. `failed` then
  means the User abandoned it, or it escalated past the cap of three.
- **The demo loader is a script, not a platform feature**, and it pauses the Runtime, writes
  history, advances the watermark past its own output and unpauses — otherwise loading demo data
  would immediately fire a dozen real LLM conversations.
- **`LLM_PROVIDER` is a compose-level environment variable**, so the end-to-end tier drives the
  real Runtime, ThingStore, Firefly and UI with a deterministic scripted model, for free.
- **Scope kept against advice**: the griller recommended cutting `Party` and `Process` and the
  Email Manual Connector. I kept them. They are the cheapest items in the plan and they carry
  the renovation scenario the README leads with. This is scope I chose to carry, not scope the
  design requires — flagging it as the most likely place to trim if time runs short.

---

## D-010 — The template's creator-scoped authorization policies are removed

**Decided**: `import/auth/childAuthorizationDefinition.json` keeps only *"User Has Actuator Path
Access"* and *"Reload Authorization Rules by System-Admin"*. The three creator-scoped rules —
delete-own, update-own, and the **repositoryPolicy** that injects
`exact_match /__meta/creator == principal.username` into every QUERY for non-admins — are deleted,
along with their `permissions` entries.

**Why**: they encode a multi-tenant assumption — *a document belongs to whoever created it* —
that is precisely false here. This is one household with one human, and the entire point of the
system is that the Runtime and the User work on the same Things. Left in place, and combined with
D-007 (the Runtime has its own `runtime` identity), a User logged in as `user1` could neither
answer an Open Question the Runtime created nor even **see** it: the Open Questions overview is a
QUERY, and the repository policy would silently filter it to documents the User created. Every
Invoice the Receptionist produced would be invisible too. The whole UserInterface half of the
slice would return empty.

This is easy to miss because the template's own e2e suite logs in as `admin`, for whom all three
policies are bypassed.

**What is deliberately kept**: the User stays `user` and the Runtime stays `runtime` with reduced
access rights, so D-007's two real benefits survive — `__meta.creator` still distinguishes Runtime
writes from human ones, and the Runtime still has no `DOCUMENT_DELETE` and no `MODEL_MANAGE`.
Neither depended on these policies.

**Honest caveat**: making the Conversation form read-only is a UI affordance, not an
authorization boundary. The User retains `DOCUMENT_UPDATE` on Conversations; what protects the
invariant is that nothing navigates there, not that the server refuses.

**Alternative**: run the User as `admin` (bypasses all policy, loses the provenance distinction).

**Reversal cost**: Trivial, but reversing it breaks the UI.

---

## D-011 — The Runtime is TypeScript on Node, outside the A12 server

**Decided**: `runtime/` is a separate TypeScript service, not Java code inside the A12 Data
Service.

**Why**: the Data Service is a platform component we *configure* — its jar comes from the
registry and the template adds a handful of classes. Putting a long-running agentic loop, an LLM
client and an HTTP connector inside it would fuse our application's lifecycle to the platform's
and make every Runtime change a Spring Boot rebuild. Keeping it outside also keeps the boundary
honest: the Runtime is a client of the ThingStore with no privileged access, exactly like the
UserInterface. TypeScript because the LLM SDKs are first-class there and the loop is I/O-bound
orchestration.

**Reversal cost**: High — it would be a rewrite.

---

## D-012 — Unit tests use a real in-memory ThingStore, not a mock

**Decided**: `runtime/test/support/memory-store.ts` implements the same surface as the A12 client
— it really stores documents and really evaluates the constraint operators the watcher uses. The
loop tests run against it.

**Why**: this brushes the standing "never mock anything" rule, so it is worth being explicit.
It is a **fake, not a mock**: nothing is stubbed to make an assertion pass, and no expectation is
asserted against a stand-in. It exists because the behaviour worth testing — suspend, resume,
recover a lease without re-executing — is *branching in the loop driver*, and exercising it
against a Postgres-backed Spring Boot service would make the suite slow enough that nobody would
run it. The same scenarios run against the real Data Service in the integration and end-to-end
tiers, which is what keeps the fake honest.

The same reasoning covers `ScriptedProvider`: it is a recorded substitute for a paid,
non-deterministic third party, and without it the loop's branching cannot be asserted at all.

**Alternative**: only integration tests. Slower, and the failure modes (a crashed Turn, an
expired lease) are hard to provoke against a live stack.

**Reversal cost**: Low.

**Flagging this one for review** — it is the decision most likely to attract disagreement.

---

## D-013 — `compose/.env` is committed

**Decided**: the repo's `.gitignore` ignores `.env` everywhere but explicitly un-ignores
`compose/.env`, and the compose image names and project name are pinned there.

**Why**: two reasons. The Gradle docker-compose plugin injects `FRONTEND_IMAGE`, `SERVER_IMAGE`,
`PROJECT_NAME` and friends, so a plain `docker compose -f compose/docker-compose.yml up` — which
is what `just` uses and what anyone debugging will reach for — fails without them. And without
the file committed at all, `just dev` cannot work from a fresh clone. It contains development
defaults for a laptop stack, not secrets, and says so in a comment.

**Reversal cost**: Trivial. But note the file *would* hold real secrets the day this stack leaves
localhost, and at that point it must come back out.

---

## D-014 — Findings that only a running stack could produce

Not decisions so much as facts bought with time, recorded because each one cost an hour and none
of them is written down anywhere else.

1. **Node's `fetch` sends `Accept-Language: *`**, and the A12 Data Service derives a query's
   locale from that header. Every `QUERY` failed with *"Unable to construct query for unsupported
   locale: *"* until the client pinned the header. It is invisible until the first query, and the
   same request works fine from `curl`, which sends no such header.
2. **A12's `not` constraint takes a singular `operand`**, while `and` and `or` take `operands`
   (an array). The wrong shape is rejected with *"Please provide operand for not operator"*.
   Four of the six watcher scans used it.
3. **`hintList` is an array keyed by locale**, not an object — the wrong shape fails model
   conversion with a Jackson `HintLists` deserialisation error.
4. **An empty `repositoryPolicies: []`** in `childAuthorizationDefinition.json` fails the whole
   server's startup. The key has to be absent, not empty.
5. **A dot in the Docker image group** makes Docker read the first path segment as a registry
   hostname and try to resolve it over DNS. `com.mgmtp.assistants/frontend` is a DNS lookup;
   `assistants/frontend` is a local image.
6. **`docker compose` takes its project name from the directory**, not from any variable in the
   `--env-file`, so containers were `assistants_*` while volumes were `compose_*`.
7. **Repeating-group field names** in the models did not match what the Runtime wrote, and the
   only symptom was `ADD_DOCUMENT ... rollback was performed`. There is now a test that compares
   the Runtime's field map against the model JSON, because nothing in TypeScript can catch it.

---

## D-015 — What is deliberately not finished

Recorded so nothing here comes as a surprise.

- **The Accountant does not tag its bookings with the Invoice's ThingID.** The demo loader does,
  and the mechanism works; the scripted LLM fixture simply does not pass `thingId` to
  `postTransaction`. A live model reading its own tool schema would. Cosmetic, but it means the
  live-flow booking is linked only by its idempotency key.
- **Text extraction does not exist.** A Document's `extractedText` is supplied by whoever creates
  it. `document.requestText` is a Manual Connector that asks the User to paste it.
- **The content store runs embedded inside the server container** (`dataservices-embedded_contentstore`)
  — but on the external Postgres, not an embedded one. The compose stack runs the `local-db-env`
  profile group, *not* `dev-env`: `dev-env` transitively activates `dataservices-embedded_postgres`
  and `contentstore-embedded_postgres`, which win over an externally-listed `dataservices-external_postgres`
  and put every Thing in the container's writable layer, where any rebuild or `--force-recreate`
  destroys it. Under `local-db-env` both the documents and the attachment content live in the
  `postgres` container's volume and survive `docker compose down`.
- **A Conversation's transcript renders as a data grid**, not as a transcript. `just logs runtime`
  is the debugging surface. Building a viewer would be exactly the custom client code D-005 exists
  to avoid.
- **`RuntimeState_FM` has Edit and Save buttons** while `CONVENTIONS.md` describes the model as
  Runtime-owned. That is deliberate: `paused` is the kill switch and a human must be able to
  toggle it. Every other Control on that form carries `readonly: true`, so the watermark and the
  heartbeat cannot be edited by hand — I checked, having first written this bullet the other way
  round.

---

## D-016 — What the integration tier caught, and the one that mattered

Adding a tier that runs against the live A12 Data Service and the live Firefly found five things.
One was serious.

**The serious one**: the idempotency key is `<conversationId>:<entrySeq>`, and Firefly's search
grammar is `field:value` — so an unquoted `external_id_is:<uuid>:3` **splits at the colon and
matches nothing**. `findByExternalId` therefore always returned "not found", which silently voided
the entire guarantee ADR-0012 rests on: lease recovery would re-post rather than recognise the
work as already done. What actually stood between a crash and a double booking was Firefly's
`error_if_duplicate_hash`, which surfaces as a 422 rather than as an idempotent success.

The fix is to quote the value. Verified against a live Firefly: unquoted 0 hits, quoted 1 hit.
There is now an integration test carrying a real conversation-shaped key with a colon in it.

Worth dwelling on: the unit tier could not have caught this, because the fake Firefly matched keys
with `Array.find`. The bug lived entirely in the difference between our idea of a search and
Firefly's. That is the argument for the tier, in one example.

**The other four**:
- `QuerySpec.sort` used the obvious field names; the server wants `direction` (not `order`),
  `nullHandling` (not `nulls`) and `ignoreCase`, and rejects a null in **any** of them. Latent —
  nothing sorts yet — which is exactly why it needed a test.
- The `runtime` role withholds `DOCUMENT_DELETE` by design (D-007), so `ThingRepository.delete`
  can never succeed as the Runtime. That is intended, but the method's existence implies otherwise.
- `exact_match` with an empty-string value is rejected by the server. `waitingFor` is cleared to
  `""`, so a future scan filtering on it would fail rather than match. No scan does today; there
  is a test recording the limitation.
- `pageSize` caps at exactly 100 — which is also `ThingRepository.search`'s default, so the
  default is a ceiling rather than a convention.

---

## D-017 — What the adversarial review changed

A read-only review against the ADRs and the architecture document produced 39 findings. The
headline one is worth stating plainly, because it was the design's sharpest claim:

**The intent log was written and never read.** `advance()` dutifully wrote each tool call down
before executing it, and nothing anywhere ever looked for an intent without a result. Lease
recovery simply called the model again — and because the unanswered intent was itself in the
transcript, the re-issued call got a **new** idempotency key. That is precisely the double
booking ADR-0012 exists to prevent, and the test named "recovers an expired lease without booking
the same transaction twice" did not catch it because the crash it simulated happened *after* the
result was written, so the recovered turn issued no tool call at all.

Fixed by adding `reconcile()` to the tool contract: on recovery the Runtime **asks** the Connector
whether the call landed, under the original key, and never re-executes. A mutating tool that
cannot answer forces an escalation to the User rather than a guess. The recovery test now
truncates the transcript at the intent, which is what a crash actually looks like.

Two more that would have made the system not work at all:

- **Every Manual Connector was stranded forever.** They suspend with `waitingFor: "tool"`, and the
  answered-scan filtered on `"user"`. No other scan can reach a waiting Conversation either, so
  `email.send`, `bank.sendMoney` and `document.requestText` were terminal and silent — with the
  heartbeat still green. Invisible because the scripted fixture never exercises that path.
- **A resumed transcript was invalid to both real LLM providers.** A suspended Turn left a tool
  call with no tool result, which OpenAI and Anthropic both reject. Every `ui.askUser` — the core
  interaction of the whole system — would have failed on resume with `LLM_PROVIDER=openai`.
  Invisible because the compose default is `scripted`, which ignores message shape.

And a data-loss one: `ThingRepository.update` built the outgoing document from the Runtime's field
map, but `MODIFY_DOCUMENT` is a whole-document replace and the map does not cover `Document_DM`'s
attachment group. An Assistant setting a classification deleted the User's uploaded scan, silently.
It now merges onto the raw stored document, which protects every field the map does not know about.

The rest, in one line each: a child that ends `failed` never told its parent; `resultDeliveredAt`
was stamped even when delivery threw; scan 6 took a second Turn on Conversations scans 2–5 had just
advanced; a disabled Assistant's Conversation spun at the scan interval forever; a deleted
OpenQuestion stranded its Conversation; the watermark advanced past Things it had deliberately
skipped; the scripted provider reported success when it ran off the end of the fixture; the Firefly
idempotency probe read its own failure as "nothing there"; no outbound request had a timeout; the
health probe returned green in three of the states it exists to catch; `just clean` ran `just dev`
through an unescaped backtick; and the ports were published on all interfaces with the passwords
committed next to them.

**The lesson worth keeping**: every one of the three worst findings was invisible to the test
suite because the suite exercised the happy path with a substitute at exactly the point where the
bug lived. The unit tier's fake Firefly matched keys with `Array.find`, so it could not see that
Firefly's search grammar breaks on a colon; the scripted provider ignores message shape, so it
could not see an invalid transcript; the fixture never calls a Manual Connector, so it could not
see them strand. Green tests were evidence about the fake, not about the system.

---

## D-018 — Final verification, and one accidental demonstration

Verified on a live stack after every fix above, through the `just` recipes rather than by hand:

```
just bootstrap    → the two Assistants and the RuntimeState
just demo-data    → 6 parties, 2 processes, 5 documents, 3 invoices, 3 transactions
                    (re-run: the books recognised the existing bookings rather than duplicating)
just test-models  → 26 models, 0 errors, 0 warnings
just test-runtime → 40 passed
just test-integration → 51 passed against the live Data Service and Firefly
just test-client  → 288 passed
```

Then a document dropped into the ThingStore, end to end: Receptionist born → Invoice created →
Accountant called → Open Question raised → suspended → answered → resumed → **96.50 EUR booked**.

**The accidental demonstration**: switching the Data Service from embedded to external Postgres
reinitialised the database, and every Thing was lost — but **every transaction the Accountant had
booked was still there**. Bookkeeping is a separate Authority with its own storage and its own
lifecycle (ADR-0006), and this is what that means in practice. It is also why `just demo-reset`
has to be a full `down -v` cycle: no smaller reset is symmetric across two Authorities.

---

## D-019 — The end-to-end suite, and the regression it caught

21 Playwright specs, green against the live stack: login, all eight modules, Party CRUD through
the UI, a markdown round trip in the lifted editor, the whole invoice slice driven through the
browser, and the ADR-0004 restart.

**It immediately earned its keep.** Removing the `rowActionGroup` key to drop a delete button
(the safe-looking half of a security fix) broke three overviews completely: the A12 overview
engine dereferences `content.rowActionGroup.actions` without guarding it, so an absent key is a
`TypeError` and the table never renders. Open Questions — the application's landing page — was
blank. The change had been "verified" against the server's `model` table, which is the right
check at the wrong altitude for a client-side crash. `{"actions": []}` is how you say "no row
actions"; there is now a validator check for it, proven to bite.

**The restart spec needed two fixes to go green, and neither was a product bug**: the test fixture
replayed a session token minted by the server it had just restarted, and the loading wait used
the default five seconds while a freshly restarted client refetches its whole model graph. Both
are honest facts about restarting a stack, now written into the tests.

What the restart spec actually proves is the claim ADR-0004 exists for: an Open Question survives
a full restart of both the Runtime and the store, and answering it afterwards still moves the
Conversation on.

---

## D-020 — Restarting the server alone breaks the frontend

The last thing the end-to-end suite found, and it is an operational fact worth knowing rather
than a bug in anything we wrote.

**nginx resolves its upstreams once, at startup.** Restarting the `server` container gives it a
new IP, and the frontend then proxies every `/api/**` call to an address nobody is listening on.
The symptom is a login form that never renders and a console full of `502 Bad Gateway` — which
looks like an application fault and is not one.

So `just restart server` now takes the frontend with it, and the e2e restart helper does the
same. The alternative fix — an nginx `resolver` directive with a variable upstream, so the name
is re-resolved per request — is the better long-term answer and belongs with whoever owns the
frontend image; it is noted here rather than done.

This is also why the suite failed twice in a row after appearing to pass: the restart spec left
the stack in exactly this state, and the next run's login could not reach the API. The tests were
right and the stack was wrong.

---


## D-021 — A bug hunt, and the decisions taken to run it

The task was "test the system until you find at least ten bugs, track activities and decisions in
the existing .md file, write the bugs in a BUGS.md". **43 defects, every one reproduced**, are in
[BUGS.md](BUGS.md). What follows is how that was arrived at and what I decided without asking.

**Scope: find and document, not fix.** The instruction names BUGS.md as the deliverable, so nothing
here is repaired. No product file was modified for the hunt; `git status` over `client/`,
`runtime/src/`, `server/`, `import/`, `compose/`, `e2e/` and the justfile stayed clean throughout.
The two exceptions are deliberate and listed under "what the hunt left behind" below.

**"The existing .md file" was read as this one.** Six top-level `.md` files were candidates;
DECISIONS.md is the only one whose stated purpose is recording decisions taken while the user is
away, so D-021 continues it rather than starting a seventh file.

**Five hunters in parallel, against the stack that was already up.** The surfaces are independent —
the web application through a real browser, the ThingStore's JSON-RPC and the Runtime's tool layer,
the loop and watcher under vitest against the real modules, the Firefly connector against live
Firefly, and the models plus validator plus the project's own prose. I kept the browser myself and
gave the other four a written contract (`tmp/hunt/CONTRACT.md`). Running against the live stack
rather than a fresh one was a deliberate trade: it cost some isolation — several hunters were
writing Things at once — and bought the ability to catch concurrency defects that a quiet stack
hides. BUG-07 and BUG-22 are both of that kind.

**The contract's load-bearing clause was rule 3: reproduce, never infer.** Reading code and
reasoning "this looks wrong" was defined as a *hypothesis*, publishable only after something was
executed that demonstrated the wrong behaviour, with the output pasted. Everything that could not be
executed went to a separate "unverified suspicions" section and is excluded from BUGS.md. Rule 4
forbade faking the component under test — D-017's lesson, and it earned its place twice: BUG-02 and
BUG-04 are both invisible to the unit tier because `FakeFirefly` implements the two methods as
`return []`, so the fake agrees with the bug.

**Destructive operations were forbidden to everyone.** `just clean`, `clean-all`, `down`,
`demo-reset`, `restart`, `docker compose down`, `docker volume rm`. With four agents and a browser
on one stack, any of those would have destroyed another hunter's evidence mid-run. `just pause`
without a resume was also forbidden, which is why the pause-race test (BUG-07) always resumes.

**I re-ran four findings myself before publishing them.** Aggregating another agent's claims without
checking them is how a report acquires a wrong entry. BUG-01, BUG-02, BUG-05 and BUG-07 — the ones
whose consequences are money, data loss or the kill switch — were re-executed independently and
reproduced exactly. BUG-07 reproduced at a *different* rate on the second run (3 of 25 rather than
2 of 25), which is what a race should do and is itself corroboration.

**One candidate was dropped after its control failed.** The Parties search box appeared to miss a
Party whose name contained the search term. The control — the same search against a Party known to
exist — showed the row had been deleted by another hunter minutes earlier. There was no bug. It is
recorded here because a report is only as good as the things kept out of it.

**BUG-15 is published without a root cause, on purpose.** Two of the eight detail forms cannot be
opened and fail silently. I established that the server serves models byte-identical to the source,
that every `elementRef` resolves, that model versions are uniform, that the validator passes them,
and that the `InlineRepeat` shape is not the trigger — and then stopped, because pinning A12's
internal post-processing further was worth less than the twenty findings not yet made. BUGS.md lists
what was ruled out so the next person does not repeat it. The honest state is: the defect is
confirmed and reproducible, the cause is not.

**Severity means user impact, not effort.** Critical is reserved for one finding. BUG-01 is that the
core interaction of the product — the User answering an Open Question in the web application — does
not work: the form leaves `answeredAt` unset, the watcher requires it, and the Conversation waits
for ever with a green heartbeat. Stamping that one field revives it within one scan, which is the
positive control that makes it a fact rather than a theory. The e2e suite does not catch it because
`OpenQuestionPage.ts` sets `answeredAt` itself before saving — the test knows something the User is
never told.

**Two documentation findings were reported by two hunters independently** (BUG-26, the
`CONVENTIONS.md` paragraph that instructs the reader to reintroduce the D-019 overview crash). I
merged them rather than counting twice.

**The subagents' harness refused to let them write their own findings files**, so I persisted all
four verbatim to `tmp/hunt/findings-*.md` and wrote BUGS.md from them. `tmp/` is gitignored, so
BUGS.md is self-contained and the scratch scripts behind each repro are not committed.

### What the hunt left behind

- **The demo data is dirty.** Roughly 90 Parties, many Invoices and Documents named `HUNT …` or
  `SRCH-…`, and their Conversations and Open Questions. Firefly carries six `HUNT …` accounts, about
  forty `hunt …` transactions and a stray `Medcal` category, so the `Payables` balance is inflated
  well beyond the demo household's. `just demo-reset` is the way back, and it takes the books with
  it — which is the ADR-0006 consequence D-018 already records.
- **The Receptionist's system prompt was edited and restored byte-exactly.** A markdown round-trip
  probe (table, hard break, nested lists, fenced code, rule, escapes, block quote) was appended,
  saved through both the source tab and the Lexical visual editor, and compared against the seed:
  identical apart from `|---|---|` normalising to `| --- | --- |`. The editor is sound. Restoring it
  had to be done by hand against `ASSISTANT_SEEDS`, because `just bootstrap` will not do it —
  which is BUG-30, found by trying.
- **One test Party was deleted through the UI** to confirm the delete confirmation dialog. It was a
  hunter's own row.
- **The stack is left running, unpaused, healthy.** `Paused: false`, heartbeat fresh.

### The pattern worth keeping

D-017 ended with "green tests were evidence about the fake, not about the system". This hunt is that
sentence again, from the other side. The suite is green — 40 runtime, 288 client, 26 models, 21
end-to-end — and the User still cannot answer a question, the Accountant still reports no unpaid
invoices while €3 850.30 sits unpaid, and the kill switch still fails one time in ten. Every one of
those was found by *using* the system rather than by testing it, and each is invisible to the tier
that should own it: BUG-01 because the page object fills in a field the User is not told about,
BUG-02 and BUG-04 because the fake returns `[]`, BUG-07 because a race needs a second writer and the
tests have one.

The three highest-value things to do next, if the ranking is useful: BUG-01, because the product does
not work without it; BUG-02, because an Accountant that answers "nothing outstanding" is worse than
one that says nothing; and BUG-15, because a Conversation you cannot open is a system you cannot
debug — and it is the surface every other finding here would be diagnosed from.

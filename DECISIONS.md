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
   *(Superseded by [D-022](#d-022--keycloak-is-the-only-place-a-password-is-checked): the service,
   the realm import and the database are all back, on purpose. The rest of this entry stands — the
   template choice, the registries and the 2026.06 line are unaffected.)*
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
that is the right trade, but it is a real limitation and worth knowing about. *(This note is what
D-022 acted on.)*

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

**Superseded 2026-08-10, on the storage half only** (the headless bootstrap stands unchanged):
Firefly now runs on the stack's existing `postgres` container, in its own database
`assistants-firefly` under its own role, provisioned by the same
`compose/postgres/db-init.sh` that already creates the data-service and content-store
databases. The reversal cost quoted above was accurate — it was a compose edit plus nine lines
of shell. What changed the trade is that the second engine the original decision was avoiding
turned out not to be a second *container*: Postgres was already in the stack for the
ThingStore, so putting Firefly on it removes a storage engine rather than adding one, and the
books become reachable by the same `psql`, backup and inspection commands as everything else.
The cost is that Firefly's data no longer survives independently of the ThingStore's database
volume — `just clean` already took the books with it, so nothing changes operationally there.

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

## D-007a — `Assistant_DM` is withheld from the `runtime` role, in the store

**Decided**: a project-defined access right `ASSISTANT_WRITE`, held by the `admin` and `user` roles
and by no machine one, plus a permission in `import/auth/childAuthorizationDefinition.json` on the
`Document Create`, `Document Update` and `Document Partial Update` scopes that demands it whenever
the target document model is `Assistant_DM`. `just bootstrap` therefore runs as the User
(`BOOTSTRAP_USER`, default `human`) rather than as the Runtime.

**Why**: D-007 makes exactly this argument for `DOCUMENT_DELETE` and then stops one model short.
README's Things table says an Assistant is written by "**User only** — the Runtime reads it", and
until this decision nothing enforced it: the `runtime` identity could create an Assistant and
rewrite an existing one's `SystemPrompt`, `Enabled`, `MaxTurns` and `Tools` (BUG-23). `Tools` is the
list of Operations an Assistant may call, so the only thing between an LLM and granting itself
`bookkeeping.postTransaction` was the `WRITABLE_MODELS` array in `runtime/src/tools/tools.ts` — a
guard enforced inside the same LLM-driven process it exists to constrain. D-007's own sentence
applies verbatim: it turns a hallucinated privilege escalation into a `-32059` rather than a Runtime
that has rewritten its own instructions.

Bootstrap moving to the User is not a workaround for the guard, it is the guard being consistent.
Bootstrap seeds what the User owns, so `__meta.creator` on a seeded Assistant now says `human`,
which is what actually happened.

**Scope, honestly stated**: this closes the *write* half only. `thingstore.search` still has no read
restriction (same BUG-23 entry), so an Assistant granted it can still read every other Assistant's
system prompt. And an Assistant only reaches `thingstore.create` at all if the Operation is in its
own `tools[]`, which the User controls. What this buys is that the last line of defence is the store
rather than an array inside the process being defended against — the same reason D-007 exists.

**Alternative**: name the role in the policy (`!containsAnyRole({'runtime'})`). Rejected: a
deny-list that must be edited for every future machine identity, where a positive grant is inherited
correctly by every future human one.

**Also considered**: leaving it, and relying on `WRITABLE_MODELS`. Rejected for the reason D-007
gives — a guard that lives inside the LLM-driven process is not a boundary.

**Cost**: the rule has to recognise all three shapes the Data Service passes as `#resource` for
those scopes — the model name alone (`checkDocumentCreatePermissionByModel`, a pre-check in
`DefaultDocumentService`), the `DocumentV2` being created, and the `DocumentUpdateResource` on an
update. Any other shape deliberately falls through to "not an Assistant", so an unforeseen call path
can never be denied by this rule.

**Reversal cost**: Trivial — two files under `import/auth/`, and two lines of `config.ts`.

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

**Amended (2026-08-13)**: the original wording knows two kinds of file — mgm's and ours — but
the sweep that finally corrected the notices found three, and the difference is legal, not
cosmetic. EUPL Art. 5 requires *preserving* an upstream copyright notice, not replacing it, so a
template file we have since edited must carry both names:

| Origin | Count | Header |
| --- | --- | --- |
| Written here, mgm header copy-pasted in error | 21 | `(c) Till Gartner`, `EUPL-1.2` |
| From the template, modified since | 30 | both copyrights, `EUPL-1.2` |
| From the template, untouched since `f9b27ba` | 56 | left exactly as shipped |

The split is mechanical — `git log f9b27ba..HEAD -- <file>` decides it — so it can be recomputed
rather than remembered. `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES` no longer describe the
"mgm A12 Platform"; they describe Assistants, credit the template under *Portions of this work*,
and disclaim mgm affiliation. A12 is dual-licensed (EUPL-1.2 or commercial) and we consume it
unmodified, so nothing obliged us to any licence: we take the EUPL-1.2 option and drop the
commercial half, which was never ours to offer.

Three files sit on the boundary — `AssistantsServerApplication`, `MimeTypeValidator`,
`AttachmentEventListener` are our application's classes but arrived with the template and were
never edited, so they counted as untouched and kept mgm's header. Editing any of them moves it
to the middle row.

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

**Superseded by [D-023](#d-023--every-secret-lives-in-one-gitignored-env), 2026-08-10.** It came
back out. The trigger was not the stack leaving localhost but D-022 adding an oauth2-proxy cookie
secret — session-forging material rather than another laptop database password — and GitGuardian
flagging the file on every push. The two reasons above were real and both survive: `.env` is still
one file that a plain `docker compose --env-file` can read, and a fresh clone is still one command
away from running. It is `just setup` now instead of `git clone`.

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
   hostname and try to resolve it over DNS. `com.grtnr.assistants/frontend` is a DNS lookup;
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

---

## D-022 — Keycloak is the only place a password is checked

**Decided**: The stack authenticates through Keycloak, the way A12 intends, and nothing else
verifies a credential. Concretely: the A12 server moves from `mgmtp.a12.uaa.authentication.types=
LOCAL` to `OAUTH2`, `import/auth/users/*.yaml` is deleted, the web application loses its login form
and gains a redirect, the Runtime gets its token from Keycloak's direct access grant, and Firefly
III sits behind an oauth2-proxy that does the OIDC flow on its behalf. Realm `A12Realm` holds
`human` / `human`, the service account `runtime`, and `admin` / `user1` / `user2` for the test
tiers; the Keycloak console is `admin` / `admin`.

**Why**: the ask was to use Keycloak, and to use it *the A12 way* rather than invent an
integration. So the realm, the client (`a12-spa-client`), the property names and the client-side
wiring are all lifted from the A12 Project Template's own Keycloak variant, not designed here. Two
of the three pieces were straightforward; the third was not, and is the substance of this entry.

**The one real finding: Firefly III cannot speak OIDC.** Version 6.6.6 has exactly two
authentication modes — `AUTHENTICATION_GUARD=web` (its own login form) and `remote_user_guard`
(take the user from an HTTP header, validate nothing). Native OIDC is an open feature request. So
"Firefly uses the same Keycloak and the same users" is only achievable with an authenticating proxy
in front, and I confirmed with the user before adding a container for it.

There is a second, sharper reason it had to be the proxy rather than Firefly's own login: Firefly
validates registration passwords with `min:16|secure_password` and wants an email address as the
username. **`human` / `human` is not a password Firefly will accept.** The requested credential is
therefore only possible if Keycloak holds it and Firefly never sees one — which is precisely what
`remote_user_guard` behind oauth2-proxy gives.

**What the proxy costs, and the four things that were not obvious**:
1. **Firefly must publish no host port.** The guard trusts `X-Forwarded-Email` blindly, so any
   reachable path to Firefly is an authentication bypass. The proxy owning 8084 is the entire
   security argument.
2. **But `/api/` bypasses the proxy on purpose.** Firefly's REST API authenticates on a separate
   Passport guard, so the Runtime's personal access token is checked whether or not the proxy has a
   session. Routing those requests through OIDC would break the Runtime, `just demo-data` and both
   test tiers, and would buy nothing. `OAUTH2_PROXY_SKIP_AUTH_ROUTES` covers `^/api/` and
   `^/healthcheck`.
3. **`KC_HOSTNAME` is load-bearing.** oauth2-proxy redeems its authorization code over the internal
   `keycloak:8080` address while the browser uses `localhost:8089`. Without a pinned hostname
   Keycloak derives `iss` from the request host, so tokens minted internally and externally claim
   different issuers and exactly one of the two fails validation. Pinning it also lets the server
   fetch keys internally while checking `iss` against the public URL.
4. **`FIREFLY_EMAIL` and Keycloak's `human` must agree.** Firefly identifies its user by that
   address, and the bootstrap container mints the Runtime's token against it. Disagreement is
   silent and nasty: the human browses one set of books while the Runtime writes to another. There
   is no longer a `FIREFLY_PASSWORD` at all.

**Two settings were relaxed for the development stack, deliberately**: the realm's password policy
(the stock A12 policy demands twelve characters with mixed classes, which forbids `human`), and
`accessTokenLifespan`, from 300 s to 1800 s. The second is not cosmetic — the end-to-end tier
restores a captured session into a *fresh* browser context, which has no Keycloak SSO cookie, so a
silent renewal cannot succeed and a five-minute token would expire mid-suite. 1800 s restores the
property the UAA `LOCAL` token had.

**Alternative considered and rejected**: leave Firefly on its own login and give it a separate
16-character password, so only A12 uses Keycloak. Cheaper by one container, but it cannot deliver
`human` / `human` on Firefly and it leaves two identity stores. Put to the user, who chose the
proxy.

**Reversal cost**: Moderate. The server-side switch is a handful of properties; the client-side
wiring is four small files under `client/src/uaa/`; the proxy is one compose service. The realm
import, however, is create-only — Keycloak reads `compose/keycloak/*.json` once and never again, so
changing a user or a client means `just clean` to drop the volume. That is the sharpest edge this
decision leaves behind.

**Note for the user**: the *mechanism* is now production-shaped; the *configuration* is not.
Keycloak runs `start-dev` over plain HTTP, its console is `admin` / `admin`, the realm password
policy is relaxed, the user passwords are committed in plaintext under `compose/keycloak/`, and
oauth2-proxy's client and cookie secrets are committed in `compose/.env`. All of that is a
development default for a stack bound to `127.0.0.1` (D-013) and all of it must be replaced before
the stack is reachable from anywhere else.

---

## D-023 — Every secret lives in one gitignored `.env`

**Decided**: `compose/.env` moves to `.env` at the repository root, is gitignored, and is the only
file in the stack that holds a credential. `.env.example` is committed in its place, and
`just setup` turns one into the other — generating the four database passwords, Firefly's app key
and cron token, and oauth2-proxy's client and cookie secrets, so no two clones share any of them.
This reverses [D-013](#d-013--composeenv-is-committed).

**Why**: the user asked for it, after GitGuardian flagged `compose/.env` on two consecutive pushes.
Their framing was the right one — all the secrets in one file, that file ignored, a sample committed
so a reader can see what is required — and it is worth being precise about which part of that is
the actual improvement. Most of what was flagged was a laptop database password, a true positive in
shape and close to a non-incident in blast radius. But D-022 had just added
`FIREFLY_PROXY_COOKIE_SECRET`, which signs browser session cookies: on any host reachable by
somebody else, that one is forgeable-session material, and it does not belong in git. So the
scanner was noisy and also right.

**The finding that shaped the design: Keycloak substitutes nothing.** The obvious way to keep the
realm's user passwords in `.env` is a `${env.HUMAN_PASSWORD}` placeholder in the realm JSON. The
Keycloak documentation suggests this works. It does not — I booted a throwaway 26.5.3 with a realm
containing `"secret": "${env.PROBE_SECRET}"` and read it back through the admin API, and the stored
value was that literal string. It is a long-standing gap (keycloak/keycloak#20199, #12069) and the
usual workaround is a third-party tool, keycloak-config-cli, with a different syntax.

Hence the templates. `compose/keycloak/*.template` is committed with `${VAR}` markers, the rendered
files are gitignored, and `just render-secrets` produces them from `.env`. It runs on every
`just up` rather than only in `just setup`, because `.env` can be edited afterwards and a realm
rendered from a stale password fails only at login — the worst place to discover it. The renderer
is node, not `envsubst` (absent on macOS by default) and not `sed -i` (different arguments on macOS
and Linux); node is already required by the Runtime and the client. It substitutes strictly and
writes nothing unless every variable resolved, because a missing one would otherwise reach Keycloak
as a literal `${HUMAN_PASSWORD}` — an import that succeeds and a password nobody can guess.

**What is deliberately *not* generated**: the four login passwords — `human`/`human`, the Keycloak
console's `admin`/`admin`, and the `A12PT-*` accounts the end-to-end tier uses. They are quoted in
README.md as the way to sign in, so hiding them in a generated file would be theatre, and the
e2e fixtures have to agree with them anyway. They are weak on purpose and are safe only because
every port binds to `127.0.0.1`. This is the honest limit of what this change buys: it removes
machine credentials from git, not the development logins.

**`just setup` refuses to overwrite an existing `.env`**, which is not politeness. The database
passwords are baked into the Postgres volume when it is first created, so regenerating them on a
stack that has already run locks the server out of its own data until `just clean` drops the volume
— taking the Things and the books with it.

**Alternative**: keep `compose/.env` committed and add a `.gitguardian.yaml` to silence the
scanner. Cheaper, and defensible for the database passwords alone, but it would have left the
cookie secret in git and it does not answer the question the user actually asked.

**Reversal cost**: Low, and worth stating precisely because it is asymmetric. Undoing the file move
is trivial. Undoing the *generation* is not: once a clone has a `.env` with generated passwords and
a Postgres volume built on them, going back to committed fixed values needs `just clean`.

**Note for the user**: `.env.example` still contains the four development login passwords in
plaintext, so GitGuardian may flag it. That would be a true positive about credentials this README
publishes on purpose. If the mail is unwelcome, a `.gitguardian.yaml` scoping `.env.example` out is
the right answer — say so and I will add one.

**Follow-up, 2026-08-10.** It did flag it, and the user asked for the file, so `.gitguardian.yaml`
now scopes out `.env.example` and `e2e/fixtures/users.json` and nothing else. One caveat worth
recording: that file is read by ggshield, in a pre-commit hook or in CI. GitGuardian's GitHub
integration — which is what sends the mail — does not read it, so those two occurrences still have
to be resolved once in the dashboard.

The same mail turned up a genuine violation of the invariant above: `compose/docker-compose.yml`
passed the Runtime's ThingStore password as a literal, `assistants-runtime-dev`, while the realm's
`runtime` user got `${RUNTIME_PASSWORD}` from `.env`. Changing that variable would therefore have
re-provisioned Keycloak and left the Runtime sending the old value — an authentication failure at
the first authenticated call, not at startup. It reads from `.env` now.

**Follow-up, 2026-08-11.** `runtime/src/config.ts` kept the same string as its default, and this
document recorded that as correct on the grounds that it only served "a Runtime started outside
compose, against a stack whose password nothing has changed". Both halves were wrong. It served
`just demo-data`, which runs `demo/cli.ts` on the host through `host_urls` — a variable that passed
no password — so the literal was the credential that path actually used, not a fallback nobody
reached. And "a stack whose password nothing has changed" is the assumption the invariant exists to
survive: change `RUNTIME_PASSWORD` and `just demo-reset` breaks at login, for the same reason the
compose literal did.

So the third copy is gone. `THINGSTORE_PASSWORD` is `required` in `config.ts`, and `host_urls`
carries it from `.env` exactly as `just bootstrap` already carried `BOOTSTRAP_PASSWORD`. A host
recipe that forgets it now fails at startup naming the variable, rather than authenticating with a
stale copy. `BOOTSTRAP_PASSWORD` keeps its `human` default deliberately: that login is published in
README and is not generated, so a default for it is not a second source of truth for a secret.

---

## D-024 — `Operation.Enabled` cannot be indexed

*Decided 2026-08-13 22:52 CEST, during the autonomous run of `operations-as-things`.*

**Decided**: ship `Operation_DM.f_enabled` **without** the `indexed` annotation, and correct both
artefacts that asked for it.

`specs/changes/operations-as-things/architecture.md`'s field table and `plan.md`'s phase A both
marked `Enabled` indexed, with the rationale *"the kill switch. Indexed so 'what is switched off' is
one query"*. `import/validate-models.mjs` refuses it:

```
ERROR Operation_DM.f_enabled (Enabled) is annotated "indexed" but is a BooleanType — only
StringType and DateTimeType can be filtered on, so a query on it returns nothing
```

**Why**: the validator's rule is the load-bearing one and the annotation would have been a lie. A12
cannot filter a Boolean at all, so the "one query" the rationale promised was never on offer — the
annotation would have bought a false sense that a constraint existed. `Assistant_DM.f_enabled` is
unindexed for exactly this reason, and the watcher reads `enabled === false` after fetching rather
than filtering on it. The catalogue now matches its sibling.

**Cost**: nil in practice. The per-Turn snapshot is one unconstrained query that loads the whole
catalogue, so *"what is switched off"* is a filter over seventeen rows already in memory.

**Alternative**: make `Enabled` a `StringType` code (`on`/`off`) with a `hintList`, which would be
queryable. Rejected: it trades a checkbox for a text field on the control the User reaches for most,
to enable a query nothing in the change needs.

**Reversal cost**: Low — a field-type change plus a reindex, if a real query is ever wanted.

## D-025 — `Operation.Parameters` renders as a text area

*Decided 2026-08-13 22:54 CEST.*

**Decided**: `f_parameters` carries `exposition: "AREA"` alongside its `readonly: true`.

Unspecified in the artefacts. architecture.md wants the field *"last and collapsed: raw JSON Schema
is not what a form is for, and it is the first thing anyone wants on the day they are working out
why the model called something oddly."* Without `AREA` a JSON Schema renders in a one-line input,
which satisfies "last" and defeats the second half. No `markdown-editor` annotation: it is JSON,
not prose.

**Reversal cost**: Trivial — one key.

## D-026 — The Operation form's layout follows the Assistant pair

*Decided 2026-08-13 22:54 CEST.*

The AM module entry, section grouping, grid layouts, column widths and `sortable` flags were all
unspecified. Every one of them copies the Assistant pair's structure verbatim, so the menu reads
Assistants → Operations → Conversations and the two halves of *the system's own definition* sit
together. `Enabled` sits in the identity row beside `Key` and `Name`, because `Mutating` and
`RequiresApproval` had to be a two-cell row of their own (architecture.md requires them adjacent).

**Reversal cost**: Trivial.

## D-027 — ⚠ The `Tools` → `Grants` rename needs a real migration, and the artefacts said it did not

*Diagnosed and fixed 2026-08-13 23:20–23:30 CEST.*

**What the artefacts claimed.** `specs/changes/operations-as-things/architecture.md` was explicit
that renaming the A12 group was free in this repo:

> the stored Assistant documents hold a `Tools` group, the new Model reads `Grants`, and
> `fromDocument` will find nothing, so an Assistant's grants read as empty until bootstrap re-seeds
> them. In *this* repo the cost is zero.

`plan.md`'s phase B repeated it as *"the expected, recoverable state … not a bug to chase"*.

**What actually happens.** A12 does not ignore a group it cannot find — it **fails the document's
validation**, and it does so inside the query re-index the server runs at startup:

```
Batch indexing failed (rolled back the batch, interrupting). model=Assistant_DM, batchSize=2
The validation of document with document reference 'Assistant_DM/75db…' failed.
For the entity instance 'Assistant/Tools', the corresponding entity was not found in the
corresponding document model.
```

The batch failure aborts startup. The server never came up: **34 restarts** before I caught it. The
blast radius is the entire stack — server, and therefore the Runtime and the web application — not
one Assistant's empty grant list. `just wait` reported *"the stack did not come up in time"*, which
is what surfaced it.

**Decided**: ship the migration the change needs, as
`import/migrations/2026-08-13-assistant-tools-to-grants.sql`. It rewrites the stored group in place
— `Assistant.Tools` → `Assistant.Grants`, `ToolOperation` → `OperationKey` — is idempotent (its
`WHERE` clause matches only documents still carrying the old group), and preserves `__meta.creator`
and `__meta.createdAt`. Applied to both stored Assistants; the server then started clean
(`restarts=0`, health `UP`) and `just bootstrap` reported `updated: [receptionist, accountant]`.

**Why in place rather than delete-and-re-bootstrap**: deleting the two documents would also have
worked *here*, and only here — precisely because there are no hand-edited Assistants, which is the
assumption the original claim leaned on. A rename is the migration a repo with hand-edited
Assistants would actually need, and it costs the same to write.

**Alternative**: `just clean`. Rejected — it drops the Postgres volume, taking the Things and the
books with it, to avoid writing twelve lines of SQL.

**Reversal cost**: Low. The inverse SQL is the same statement with the two names swapped.

**Artefact corrected**: architecture.md's *"the cost is zero"* paragraph now says what happens
instead and points at the migration file. This is the one place in this session where an artefact
asserted something about A12's behaviour that turned out to be false rather than merely unspecified,
so it is worth reading the corrected paragraph rather than trusting the old one from memory.

## D-028 — Resolution details the artefacts left open

*Decided 2026-08-14 00:30 CEST, phase D of operations-as-things.*

architecture.md fixes the two explicit directions of `requiresApproval` and the four drop reasons,
but a working registry needs answers to several questions it does not ask. Each of these is a
one-line change if you disagree; all are in `runtime/src/operations/registry.ts`.

- **`requiresApproval` *unset* on the Thing falls back to the seed.** Only an explicit `false`
  weakens the guarantee, and only that warns. This matters because `Enabled` is tri-state and so is
  this: a hand-created Operation with the box untouched must not silently switch a money guard off.
  Same reasoning architecture.md applies to `Enabled`, applied one field over.
- **`description` unset on the Thing falls back to the seed's.** A blank description is not a
  sentence worth offering to a model. When the Thing has one it always wins, which is the case the
  proposal cares about.
- **`parameters` missing or blank is `unparseable`.** There is no fifth reason in the enumeration
  and the failure is the same class — a hand-edited document or a bad seed.
- **`DroppedGrant.key` carries the full declared grant** (`assistant.call:receptionist`, not
  `assistant.call`), so phase E's belt message can match what the model actually called.
- **The weakening warning is deduplicated on the registry instance**, of which there is exactly one
  per process. That is what makes *"once per process"* both true and testable.
- **Every drop is logged at `warn`**, naming the Assistant, the key and the reason — and for
  `unparseable`, the parser's own message. The proposal's complaint was that a mistyped grant is
  *silent*; a returned reason nobody logs would only half fix it.
- **`OperationImplementation.name` is the key; `seed.name` is the human label.** architecture.md
  gives both without distinguishing them, and the Model has both `Key` and `Name` ("human label for
  the overview"). Seventeen labels were invented ("Book a transaction", "Check the post", …).
  Bootstrap writes them into `Name` in phase F — that is the one place to change the words.

## D-029 — The auth rule has three literals, not four sites

*Found 2026-08-14 00:35 CEST, phase G.*

plan.md asks for `Operation_DM` in *"all three resource shapes — the bare model-name string, the
`DocumentV2`, and both sides of the `DocumentUpdateResource`"*, which reads as four edits. The rule
has **three** `{'Assistant_DM'}` literals: the bare string and the `DocumentV2` share one set via a
ternary, and the two sides of `DocumentUpdateResource` are separate. All three were widened, so the
intent is fully covered; the count in the plan is what is wrong, not the coverage.

Two adjacent comments in `roles.yaml` were corrected as well, because the change made them false
rather than merely incomplete: the `runtime` block comment still said *"a self-granted Tool"* (a word
commit `1120ecb` retired), and the `runtime` role description said it *"never writes an Assistant"*,
which is now only half of what it is denied.

**Still outstanding**: architecture.md wants the narrow-name caveat documented in the roles table and
the permissions table as well. Those live outside `import/auth/` and are picked up in phase I.

## D-030 — `readonly` goes on the Control, not in `fieldConfiguration`

*Found in the browser and fixed 2026-08-14 00:40 CEST.*

`Operation_FM` was authored with `"readonly": true` inside `content.fieldConfiguration.field[]` for
the five code-owned fields (`Key`, `System`, `Kind`, `Mutating`, `Parameters`). Opening the form in
the web application showed all five **editable** — `document.querySelectorAll('input')` reported
`readOnly: false` on `a12-Key-f_key`, `a12-System-f_system` and `a12-Kind-f_kind`.

`CONVENTIONS.md` already warns that `"readonly": true` in `fieldConfiguration` *"has no effect on an
`EnumerationType` — put it on the Control instead"*. The measured behaviour here is broader than
that note: these are `StringType`s and it had no effect on them either. `Conversation_FM` — the one
genuinely read-only form in the repo, and the one that demonstrably works — puts `readonly` on the
**Control**, every time.

**Decided**: moved `readonly` onto the five Controls, and kept `fieldConfiguration` entries only
where they still carry an `exposition` (`f_description`, `f_notes`, `f_parameters`). This also
respects the "each `elementRef` at most once" rule, since `f_parameters` needs both and now gets its
`readonly` from one place and its `AREA` from the other.

**Confirmed 2026-08-14 02:05 CEST**, against a seeded Operation (`bookkeeping.getBudgetReport`)
after bootstrap and a model re-import: `Key`, `System` and `Kind` render greyed-out and
non-editable, while `Name` and `Enabled` stay editable — exactly the intended split. So `readonly`
on the **Control** binds, and `readonly` in `fieldConfiguration` does not, on a plain `StringType`
and not only on an `EnumerationType`.

`CONVENTIONS.md`'s note is therefore narrower than the truth. I have **not** widened it: the claim
now rests on two observations of the same field type in the same form, and the note is a document
other models were authored against. Widening it from "has no effect on an `EnumerationType`" to
"has no effect, full stop" wants one more data point on a different field type — worth doing, worth
doing deliberately.

## D-031 — The UI change's ADR is renumbered 0021

*Decided 2026-08-14 01:05 CEST.*

`specs/changes/ui-for-conversation-and-question/plan.md`'s phase F asked for
`docs/adr/0019-a-question-is-answered-in-its-conversation.md`. That artefact was written before
`operations-as-things` landed, and that change has since taken **0019** (*An Operation is a Thing*)
and **0020** (*"Tool" is the provider's word*). Renumbered to **0021** in the plan. Two ADRs sharing
a number is worse than a gap in the sequence, and `scripts/check-docs.mjs` counts the directory and
checks the count-word in README against it.

## D-032 — The transcript fixture carries zero token counts

*Decided 2026-08-14 01:10 CEST.*

The UI change's phase B says to capture the transcript fixture *"from a running stack, not by hand"*.
Done — `client/src/test/fixtures/conversation.json` is Conversation
`7681648a-85dc-4680-95c0-a357a962a4e9`, thirteen Entries covering `prompt`, two `tool-intent` /
`tool-result` pairs, an `askUser` intent, two `answer`s, an `approval-request` and a closing
`assistant`.

Its five token-bearing Entries all read `0/0`, because this stack runs the **scripted** LLM provider
— which `domain/types.ts` already documents (*"Zero from a scripted provider"*). So the fixture
cannot carry the plan's *"the fixture's tokens sum to the expected figure"* case in any interesting
way.

**Decided**: keep the real document as the fixture, and let `cost.test.ts` build its own small Entry
arrays for the arithmetic. A pure summing function should not need a captured document to test its
arithmetic, and the fixture's job is to be *real* — which is exactly what makes it useless for
asserting a non-zero total. The fixture still carries the two cases that matter for it: Entries
without usage contribute nothing, and a Conversation with no Entries yields zero rather than `NaN`.

## D-033 — ⚠ The ADR-0008 coverage check counts `fieldConfiguration`, so it is weaker than advertised

*Found 2026-08-14 01:35 CEST, implementing the UI change's `exposes` validator rule.*

`specs/changes/ui-for-conversation-and-question/plan.md` predicts that replacing `Conversation_FM`'s
Entries `InlineRepeat` with a `CustomScreenElement` would produce *"12 warnings … for the Entry
fields"*, and that the `exposes` annotation is what suppresses them. I built the rule, then tested
the claim by removing the repeat **without** any `exposes` annotation.

**No warnings appeared.** The reason: `validate-models.mjs` collects `referenced` by walking
`model.content` for any `elementRef` or `groupRef` — and `content.fieldConfiguration` is part of
`content`. `Conversation_FM` lists all thirteen Entry fields there (presentation overrides), so every
one of them already counts as referenced regardless of whether any Control renders it.

Two consequences, and I have acted on the first only:

1. **The selftest case had to be strengthened or it proved nothing.** The "a `CustomScreenElement`
   exposing a group covers the fields under it" case now also strips the `f_entry_*` entries from
   `fieldConfiguration` — which is what phase C will really do, since with the repeat gone there is
   no Control left for them to configure. With that, the case fails without the rule and passes with
   it, which I verified by disabling the rule and re-running. So does the typo case.

2. **The check itself is looser than ADR-0008 implies, and I have not changed it.** A field mentioned
   only in `fieldConfiguration` is not on the screen — `fieldConfiguration` configures a Control that
   may not exist — yet the check treats it as exposed. Tightening this to count only `Control` /
   `InlineRepeat` references is a one-line change with an unknown blast radius across nine form
   models, and it is not what either change asked for. **Recommend doing it as its own change**, with
   the warnings it surfaces triaged rather than bulk-suppressed. Flagging rather than fixing, because
   a validator that suddenly warns about thirty fields in the middle of two other changes is how a
   useful check gets switched off.

The `exposes` rule is worth having either way: its **error** half — an annotation naming a group the
bound Document Model does not have — is load-bearing today and catches a typo that would otherwise
claim coverage of nothing.

## D-034 — ⚠ The Operations overview loses its *Add* button

*Decided 2026-08-14 01:55 CEST, after phase F surfaced the hazard.*

Phase A modelled `Operation_OM` on `Assistant_OM`, which gave it an **Add** button. Phase F then
found what that button costs: an Operation Thing created by hand carries **no `operation:<key>`
idempotency key**, so the next `just bootstrap` does not recognise it, creates a *second* Thing with
the same `Key`, and `grantedTo`'s `catalogue.find(…)` then resolves whichever the store returns
first. Two Operations with one key, and which one wins is arbitrary.

**Decided**: empty `subHeaderBox.leftSlot`, keeping search, filter and the confirmed `delete` row
action. This is the treatment `CONVENTIONS.md` already documents for overviews whose lifecycle the
User does not own.

**Why this and not a bootstrap fix**: the proposal is explicit that *"Operations authored entirely in
the UI"* is out of scope — *"An Operation with no Implementation is not an Operation; it is a
description of one."* The Add button was therefore inviting the User to create something that can
never work **and** opening the duplicate-key hole. Removing it addresses both, and it is the smaller
change. Making bootstrap fall back to matching on `Key` would paper over a screen that should not
have existed.

**Delete stays**, deliberately: architecture.md requires it — *"An Implementation that has been
deleted leaves its Operation Thing behind … Cleaning it up is one click in the form, and only the
User can do it (D-007: the Runtime holds no `DOCUMENT_DELETE`)."*

**What is still open, and is not fixed here**: nothing stops a duplicate arriving through the
JSON-RPC API directly, since `Operation_DM` is writable by any identity holding `ASSISTANT_WRITE`.
The resolution would still be arbitrary. A `document_unique_constraint` on `Operation.Key` is the
real answer and is a Model-level change nobody asked for in this change — worth its own commit.

## D-035 — Phase E and F decisions the artefacts left open

*Decided 2026-08-14 01:20–01:40 CEST.*

- **The watcher reports "unhealthy" by leaving the heartbeat unstamped.** architecture.md says an
  empty catalogue must "report unhealthy" without saying by what mechanism. The existing `paused`
  early return sets the precedent and `health.ts` already reads `heartbeatAt`, so no new signal was
  invented. `report.errors` is incremented alongside.
- **The missing-catalogue error is logged once per outage, not once per scan**, following the
  existing `noteBadCron` / `noteFrozenFrontier` pattern. The heartbeat is the continuous signal; a
  line every two seconds is how a log stops being read.
- **The catalogue read sits after the disabled / max-turns guards**, so a Conversation that was never
  going to run costs no query.
- **The `absent` wording departs from architecture.md's failure-mode table.** That table says an
  absent grant means the model is told *"it is not granted"*, which is false: the grant is right
  there in the Assistant's definition — the *Operation* is what is missing. The message reads
  *"`X` is granted to you, but no such Operation exists in this system"*, and *"is not granted to
  you"* is reserved for a call that was never granted at all.
- **Drop reasons are matched by wire name.** `operationFromLlm` maps `__`→`.` unconditionally, so
  `assistant__call__accountant` reverses to `assistant.call.accountant` and matches no grant. The
  lookup compares in the direction the mapping is total.
- **`bootstrap()` takes the Implementations as a parameter** rather than constructing them. The seeds
  live inside `buildOperations(deps)` and architecture.md wants them there ("a seed in a second file
  is a seed that drifts from its `execute`"). The alternative was fake dependencies inside bootstrap;
  the parameter keeps `bootstrap()` free of Firefly and config, and `cli.ts` — the composition root —
  is the only place that wires seed-only stubs.

## D-036 — UI phase B decisions

*Decided 2026-08-14 01:45 CEST.*

- **`kernel-md-facade` has a documented accessor, and it is not used.**
  `DocumentServiceFactory().getDocumentService().getAssignedObject(document, path)` works — verified
  against the real fixture. Rejected anyway: it pulls ~3 MB of `kernel-core-runtime-ts` into the
  bundle to read one array, and each Entry's own eleven fields must be read by name regardless, so it
  would have covered 1 access in 14 — inconsistent rather than safer, with an index-1-vs-0 trap
  attached. `entries.ts`'s module comment records this at the call site. The swap is one function if
  you disagree.
- **`ui.askUser`'s orphaned `tool-result` renders as a result-only Receipt.** Its `tool-intent` is
  Assistant speech and opens no Receipt, so the result has nothing to pair with. The artefacts do not
  say what becomes of it; dropping it silently would violate *"must degrade, never disappear"*.
- **domain.md contradicts itself on collapsing** — the **Machinery** vocabulary entry says Machinery
  renders collapsed; the Speaker table marks only `system` and `prompt` collapsed. The **table** was
  followed, since it is the normative one. One line in domain.md fixes it either way.
- **The separator format was unified.** domain.md's diagram uses two (`— Thu 23 Jul at 15:09 —` and
  `— Yesterday 14:40 —`); the implementation renders `Today/Yesterday at HH:mm` plus the absolute
  form.
- **The fixture is a *called* Assistant's Conversation**, so it carries no `system`, `note`,
  `timeout` or `error` Entry and no subject link. Those Speaker rows are tested synthetically. If a
  second fixture is ever captured, capture a **top-level** Conversation with a subject.

## D-037 — Counts corrected that were already wrong before this change

*Found 2026-08-14 01:50 CEST, phase I.*

Three of these predate `operations-as-things` and were found only because every number was recounted
from the filesystem rather than carried over:

| Where | Said | Actually |
|---|---|---|
| `specs/system/architecture.md` — Models | seven `_OM`s | **eight** before this change, nine after |
| `specs/system/architecture.md` — grant matrix | Accountant gets "all six reads" | **five** |
| `README.md` — Runtime | "six `bookkeeping.*` operations" | **seven** |

`README.md` also gained a **fourth** entry under *Status and limitations* beyond the three the plan
named — that a description improved in code does not reach a running system, which is the visible
cost of bootstrap's asymmetry rule and belongs beside the other three.

**Left deliberately stale**: README's e2e limitation still says *"a row opened in each of the eight
modules"*, and `specs/research/ASSISTANTS_VS_OPENCLAW.md` still describes `grantedTo(assistant)`
reading `tools[]`. The first becomes nine in the e2e phase; the second raises a question this session
should not answer alone — **are research documents dated snapshots or living documents?** They read
as snapshots of an argument made at a point in time, which is an argument for leaving them.

## D-038 — Phase G: how the auth deny was proved, and what it could not prove

*Decided 2026-08-14 01:15 CEST.*

The load-bearing test of this whole change is *"the `runtime` identity is refused a write to
`Operation_DM`"*. A passing deny test is exactly the kind of test that can pass for the wrong
reason — a typo in the model name denies just as convincingly as a policy does — so the rule was
proved to be in force four independent ways before the assertion was trusted:

1. the `md5` of `childAuthorizationDefinition.json` is identical on the host and inside
   `assistants_server`, and `grep -c Operation_DM` returns 3 in both;
2. the server booted **after** the file's mtime, and logged
   `AuthorizationAutoConfiguration … childAuthorizationDefinitions=[file:…]`;
3. `git show 04882e4^:import/auth/childAuthorizationDefinition.json | grep -c Operation_DM` → `0`, and
   the model appears in no other policy, so nothing pre-existing could produce the refusal;
4. the refusal is **scoped**: the same `runtime` identity, in the same run, reads `Operation_DM` and
   writes `Conversation_DM`, while the `human` identity succeeds on the byte-identical call.

**What could not be done, and why**: there is no negative control. Demonstrating the test goes red
without the rule would mean editing `import/auth/**` and restarting the stack mid-suite. The
triangulation above is the strongest available substitute, and it is recorded here rather than
assumed.

**The victim is `bookkeeping.createAccount`, not `bookkeeping.postTransaction`.** The deny leg never
lands so either would be safe; the **allow** leg does land, and a suite that opens even a short
window in which the Operation that moves money is differently configured is not one to run against a
live stack. `postTransaction` is asserted on in the read test instead.

## D-039 — A pre-existing integration test was a time bomb, and is fixed here

*Fixed 2026-08-14 01:20 CEST, outside phase G's scope.*

`runtime/test/integration/watcher-queries.itest.ts`'s *"finds a scheduled Conversation by its due
instant — scan 7's whole exactly-once guarantee"* seeds a Conversation under the **fixed**
`assistantKey: "itest-scheduled"` and never deletes it (the tier's `Trash` refuses Conversations),
then queries with **`pageSize: 5`**. Every run leaves one more row behind. On the sixth run the row
the run just seeded falls off the end of the page and the test goes red — **and stays red for ever**.
Today was run six, which is how it surfaced.

**Decided**: give the seeded row a **per-run** Assistant key (the run's unique idempotency key), so
the three queries match only the row this run created. The `exact_match` on `scheduledFor`, the
neighbouring-instant negative and the skip-rule check are all unchanged — the assertion is preserved,
not weakened.

**Unrelated to this change**, and flagged rather than buried: it is twelve lines in a file phase G had
no business touching, and it is easy to revert. **The six stale Conversations are still in the
store** and the tier cannot delete them; they are inert (the Assistant key matches no Assistant) but
they are there.

## D-040 — UI phase C decisions

*Decided 2026-08-14 01:25 CEST.*

- **`client/tsconfig.json` gained `"@testing-library/jest-dom/vitest"` in `types`.** The matchers were
  registered at *run time* by `vitest.setup.ts` but had never been type-checked, so every
  `toBeInTheDocument()` was a latent TS2339 — invisible only because no test had ever used one. This
  is the one configuration change the change needed, and it is a pre-existing gap rather than a new
  requirement.
- **⚠ The transcript stays inside `SectionEntries`**, still titled *Entries* / *Einträge*, and
  therefore still sits **below** *Result* and *Last error*. plan.md says "keep the Result and Last
  error sections and their order", which reads as *do not disturb them* rather than *the thread goes
  last*. **This is the one phase C decision I am least sure of** — a reader opening a Conversation
  arguably wants the thread first, and the section title *Entries* now names a data-grid that is no
  longer there. Both are one-line changes; flagged for the browser check rather than guessed at.
- **`OpenForeignFormAction` is a `type`, not an `interface`.** Only a type alias gets the implicit
  index signature that makes it assignable to redux's `UnknownAction` at the `dispatch()` call site.
  A non-obvious constraint worth not rediscovering.
- **The token footnote is suppressed at zero.** Every Turn in this stack records `0/0` (scripted
  provider), and rendering *"0 + 0 tokens"* under every bubble is noise. The Header's total still
  reads `≥ N tokens recorded` unconditionally, because the `≥` is the point.
- **`CustomScreenElements` warns once per unknown widget value**, through `LoggerFactory` rather than
  `console` (`no-console` is an error in this repo), and renders `null`. A modelled placeholder no
  developer has filled in must not break a form.
- **RTL needed no accommodation.** I had briefed the agent to expect first-run friction — React 19.2
  + RTL 16.3 + jsdom + styled-components, never exercised in this repo. There was none: the smoke
  probe passed first try and every component test passed on first write. Worth recording because the
  risk was real and the budget for it was not needed.

## D-041 — ⚠ `collapsible` on a `MultiColumnSection` is declared and never read

*Found in the browser and fixed 2026-08-14 02:15 CEST.*

plan.md's phase C says: *"Set `collapsible: true, initiallyCollapsed: true` on `Conversation_FM`'s
`ConversationHeader` **MultiColumnSection**."* That was done, the model carried both flags, the
converted output carried both flags — and the section rendered fully expanded.

The typings are the trap. `FormModel.MultiColumnSection` **declares** `collapsible` and
`initiallyCollapsed`, identically to `Section`, so a model carrying them type-checks and validates.
But the renderer only reads them in one place:

```
formengine-core/lib/view/internal/components/form-engine/layout/section.js   → 5 occurrences
formengine-core/lib/view/internal/components/form-engine/layout/multi-column-section.js → 0
```

`multi-column-section.js` never mentions `collapsible`. The flags are silently ignored.

**Decided**: convert `ConversationHeader` from `MultiColumnSection` to `Section` and drop its
`layout`. This is safe because the outer layout was only `{"lg": "12"}` — full width — and the actual
`4-4-4` column layout lives on the inner `ControlGrid`, which is untouched. Verified in the browser:
the section now renders collapsed, as `› Conversation`, with all thirteen Controls one click away.

**Worth generalising**: a `MultiColumnSection` that wants collapsing must become a `Section` wrapping
a `ControlGrid`. That belongs in `CONVENTIONS.md`, and phase F adds it.

## D-042 — ⚠ The transcript leads, and the section is renamed

*Decided 2026-08-14 02:20 CEST, on the evidence of the browser check.*

Phase C left the transcript inside `SectionEntries`, still titled *Entries* / *Einträge*, and
therefore **below** *Result* and *Last error*. Opening a running Conversation showed what that costs:
a large empty *Result* box occupying the top of the pane, with the thread — the thing the change
exists to produce — pushed under it and below the fold.

**Decided**, two changes:
- the section moves directly under the header, so **the thread leads**;
- it is retitled **Transcript** / **Verlauf**, because *Entries* named the data grid that is no
  longer there.

**On the instruction it appears to bend**: plan.md says *"Keep the Result and Last error sections and
their order."* Those two keep their sections and keep their order relative to each other; only the
transcript moved past them. I read the sentence as *do not disturb them*, not *the thread goes last*
— and phase C's own checklist ends with *"It has to look like a thread … if either fails, this is the
phase to fix it, not a later one"*, which is an instruction to judge it on screen. Both changes are
one line each and trivially reversible if you disagree.

## D-043 — The pinned header works, which phase A never established

*Verified 2026-08-14 02:18 CEST.*

plan.md called the sticky header *"the one step that decides whether the Header design holds"* and
told phase A to settle it by spiking, with a documented fallback if `position: sticky` would not
stick inside the form engine's container. **Phase A's spikes were never run** — the change was
implemented straight from the artefacts — so this was still open when the code landed.

Measured on the built article: with the transcript box scrolled to its bottom, the header sits **1px
from the box top**, `position: sticky`, `top: 0px`, and content scrolls beneath it. The design holds
and the fallback is not needed. The header reads:

```
🤖 accountant · Accountant (called by receptionist) · called by 6156e9a7 · 🛑 waiting for you · turn 2/20 · ≥ 0 tokens recorded
```

which is every fact the Header was specified to carry. `≥ 0` is correct here and not a bug: this
stack runs the scripted provider, which records no tokens.

## D-044 — UI phase D decisions

*Decided 2026-08-14 02:30 CEST.*

- **`useThingById` is a plain effect, not a saga.** `dataservices-access` exports
  `Dispatcher.rpc(language, [request])` — a promise API that reaches
  `ConnectorLocator.getInstance().getServerConnector()` internally and needs nothing from the store.
  A saga would have bought a channel, an action and a slice of state no reducer wants.
  `loadModelGraph.ts` is a saga because it is triggered by `UaaActions.loggedIn`; this is triggered
  by a mount. Phase A was supposed to settle this by spiking and never ran.
- **One widget value serves two document types.** Nothing in the artefacts says how
  `conversation-transcript` behaves on a form bound to `OpenQuestion_DM`. The dispatcher branches on
  the **document's root group** — an `OpenQuestion` root goes to `QuestionContext`, anything else to
  `ConversationTranscript` — rather than introducing a second annotation value. A `question-context`
  value is a two-line change if you would rather model it explicitly.
- **The element sits above *Question* on `OpenQuestion_FM`.** plan.md says "above `section_answer`";
  architecture.md's table puts it above *Question*. First satisfies both, so first it is.
  `height: 480` rather than the Conversation form's `640`, since it shares the screen with the prompt
  and the answer controls — a number no artefact settles.
- **Loading renders nothing.** No artefact specifies a loading state, and a spinner that flashes on
  every mount is worse than nothing for a read this fast.
- **`Dispatcher.rpc`'s `language` is hardcoded `"en"`.** It reaches only the `Accept-Language`
  header, and `GET_DOCUMENT` takes a docRef and nothing else. Wiring it to the application locale
  would give the hook a store dependency it otherwise does not have — and the application's
  localisation is being removed in a separate change anyway.
- **`vitest.setup.ts` gained a no-op `ResizeObserver` stub.** jsdom has none and the rich-text editor
  asks for one on mount. A test-environment gap, not a product change.

## D-045 — The stack's host port forwarding broke, and I did not restart Rancher Desktop

*Encountered 2026-08-14 02:50 CEST. **Not a code problem** — recorded so the state is legible.*

Every `127.0.0.1` port the stack publishes started answering `000` — 8081 frontend, 8082 server,
8084 firefly-proxy, 8089 keycloak — **and so did another project's containers that I never touched**
(`w12-free-*`, up two days, on `0.0.0.0`). That last fact is what ruled my changes out.

Where it actually is:

| Layer | State |
|---|---|
| The apps | **alive** — nginx listening on `0.0.0.0:8081` inside its container; `w12-free-backend-1` answers `401` to `curl localhost:8080` *inside itself* |
| `docker-proxy` in the VM | **alive**, bound for every mapping |
| `lima-guestagent` in the VM | **running**, pid 4266 |
| `limactl` on macOS | **holding** `127.0.0.1:8081` and `:8082` (`lsof`) |
| The vsock/SSH hop between them | **wedged** — this is the break |

Host socket open, guest listener open, nothing in between. Restarting a container does not fix it;
neither does `just down && just up` (both tried).

**Decided: do not restart Rancher Desktop.** The fix is almost certainly `rdctl shutdown` + start,
which is non-destructive — volumes persist. But it restarts **two other agents' containers**, I had
already told the peer session managing this machine that I would not do it without them, and going
back on that after saying it is worse than waiting. Escalated with the diagnosis; continuing on
everything that does not need ports.

**A red herring worth writing down**, because it looks alarming in the logs and is not the cause:
the frontend's nginx logs `[emerg] io_setup() failed (38: Function not implemented)` on every worker
start. That is non-fatal — nginx falls back when file-AIO returns `ENOSYS` — and the worker goes on
to listen normally. The container also runs under `qemu-x86_64` emulation, because the image is
`linux/amd64` on an arm64 host.

**What this blocks**: browser verification of UI phases D–F, `just test-e2e` (including the phase H
kill-switch spec), and `operations-as-things` phase J's full-stack run. Everything else is green and
pushed.

## D-046 — ⚠ The plan's way of addressing a Conversation row does not work

*Found and corrected 2026-08-14 03:05 CEST, phase E.*

`architecture.md`'s *Addressing one Conversation row* section — added earlier in this very session,
in the commit that opened it — says to find a Conversation by the pair **(subject, assistant)**, on
the grounds that *"a called Assistant inherits its caller's subject (`services.ts:90`)"*.

**That citation is about the wrong object.** `services.ts:90` is the **OpenQuestion**'s inheritance.
A *Conversation* born by `assistant.call` takes its subject from `args["subjectThingId"]`
(`implementations.ts:633`) — whatever the model chose to pass — and `runtime/fixtures/llm-script.json`
passes none. Both invoice-slice questions are raised inside the **accountant's** Conversation, which
is exactly such a child, so its `subjectThingId` is `""` and the pair matches nothing.
`e2e/utils/agents.ts` had been saying so all along: its `conversationsFor` finds children by
`ParentConversationId`, never by subject.

**Decided**: address the row by **`question.thingId`** instead. `Conversation.currentQuestionId` is
indexed, so the overview's `simple_search` reaches it, and it identifies exactly one row by
construction — a Conversation has one current question. The plan's rejection of an id-based address
was right about the Conversation's *own* id (nothing carries it) and simply missed the inverse link.

**Consequence**: `subjectThingId` was **not** added to `RaisedQuestion` — `thingId` was already
there. `e2e/utils/agents.ts` is unchanged. Both `plan.md` and `architecture.md` now carry the
correction with its evidence.

## D-047 — A collapsed `Section` renders no children at all

*Found 2026-08-14 03:05 CEST.*

Beyond D-041 (`collapsible` ignored on `MultiColumnSection`), the `Section` renderer does something
a page object has to know: when collapsed it **does not render its children into the DOM**
(`section.js:37-40`) — it is not merely hidden. So `OpenQuestion_FM`'s `Conversation` Control, now
inside the collapsed *Details* section, is **absent** on landing, and `OpenQuestionPage`'s old
`toHaveValue(conversationThingId)` assertion would have failed for a reason nothing in the change
would have explained. Replaced with a header check on `transcript-who`. Both facts are now in
`CONVENTIONS.md`.

## D-048 — The 🛑 survives a model file, and the expression is now written down

*Settled 2026-08-14 03:00 CEST — phase A's spike, run at last.*

```
kontext(Conversation) {
    case [WaitingFor] = "user" { "🛑" }
}
```

The glyph survives: `just test-models` green, and the WCF converter writes it byte-for-byte into
`build/wcf-output/data/models/Conversation_OM.json`. With the browser unavailable, it was verified by
driving the **shipped** `ExpressionBuilder` and `ExpressionInterpreter` over the **built** column:
`"user"` → 🛑; `"assistant"`, `"tool"`, `""` and absent → empty. No fallback needed.

`CONVENTIONS.md`'s `ZeichenNichtImZeichensatz` rule turns out to be about a `StringType` field's
**data**; a model file is not document data, which is why the emoji is fine here and would not be in
a Title.

Four things an implementer needs that no artefact contained, now recorded: `expression` is an
**ANTLR string, not a JSON node tree**; it addresses elements by **`name`, not `id`**, and only
inside a `kontext`; `ExpressionColumn` takes `id`/`width`/`name`/`expression` and has **no**
`sortable`; and an absent value renders an empty cell rather than throwing, because the overview
engine's getter is `getAssignedObject(…) ?? null`.

---

# Where this session stopped

## Done, verified, committed and pushed

| Tier | Result |
|---|---|
| `just test-runtime` | **162 passed** |
| `just test-client` | **401 passed** |
| `just test-integration` | **78 passed** |
| `just test-models` | **29 models, 0 errors, 0 warnings** |
| validator selftest | **13 checks, 0 not enforced** |
| `just check` | clean (typecheck, lint, prettier, models, docs) |
| `scripts/check-docs.mjs` | 28 recipes, 21 ADRs, 0 problems |

Verified **in the browser** before the outage: the Operations catalogue (17 seeded, correct Systems
and Kinds, six columns), the read-only split on a seeded Operation, the Add button's removal, the
renamed *Granted operations* section rendering its values, the Conversation transcript rendering as
a thread, and the pinned header holding when the box is scrolled to its bottom.

## Not done — one cause

**Browser verification of UI phases D–F, `just test-e2e`, and `operations-as-things` phase J's
full-stack run.** All blocked by D-045: the stack's host port forwarding broke VM-wide, the fix is a
Rancher Desktop restart, and neither this session nor the peer session managing the machine may take
that unilaterally — the peer's classifier blocked the narrower equivalent, so acting on their
say-so would be permission laundering. **It needs you.**

Two e2e specs are written and have **never executed**:
`e2e/tests/base/8-operations-catalogue.spec.ts` (the catalogue and its kill switch) and
`e2e/tests/base/9-conversation-transcript.spec.ts` (the thread, the marker, the pending question),
plus five edited existing specs. Expect first-run breakage there; it will be real findings, not noise.

## What to do when you are back

1. Restart Rancher Desktop (or `rdctl shutdown` then start). Volumes persist.
2. `just build && just up && just wait && just bootstrap`.
3. `just test-e2e` — and treat what it finds as a to-do list, not a regression.
4. Read the ⚠ entries above first: **D-027, D-033, D-034, D-041, D-042, D-046**. Those are the six
   places where I departed from something the artefacts had written down, rather than filling a gap
   they left.

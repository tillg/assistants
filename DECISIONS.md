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
  `failed`, so a stuck Conversation appears in the same view as everything else. `failed` now
  means only "the User abandoned it".
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


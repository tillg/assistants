# Banking — can the Assistant do the transactions itself?

The **Bank** external system (see [README](../../README.md)) is a **Manual Connector** today:
`bank.sendMoney` raises an Open Question of kind `perform` and the User does the transfer in an
online-banking tab. The README says *"a FinTS call tomorrow; the dashed box is the whole of the
change."* This paper asks whether that tomorrow exists — whether a self-hosted household agent in
Germany can read the account and initiate payments **without a human in the loop**, and what the
honest version of the dashed box is. Research date: 2026-08-25.

[TOC]

## Verdict in one paragraph

**Reading: yes. Paying: no — and not because of tooling.** Balances and transactions can be pulled
unattended over FinTS (or a licensed aggregator) with one human authentication every ~90 days. A
SEPA credit transfer, however, needs the account holder's Strong Customer Authentication (PSD2 SCA)
*per transfer*, and none of the exemptions can be invoked by a third-party program: the trusted-payee
list and the low-value exemption belong to the bank's own channel, EBICS (signature-based, no TAN)
is for business accounts only, and PSD3/PSR (texts agreed 2026-04-23, applying ~2028) changes none
of this for a consumer agent. The realistic end state is **the Assistant prepares, the human
approves with one tap in the banking app** — which is a real improvement over today, but a
different sentence than "does them by himself".

## 1. Reading the account

### FinTS/HBCI 3.0 — the direct route

* Still the Deutsche Kreditwirtschaft standard; **product registration mandatory since 2019-08,
  free**, 10–15 working days by form ([fints.org](https://www.fints.org/de/hersteller/produktregistrierung)).
  Open-source libraries ship a default product ID that works but is against the rules;
  Subsembly sells a registration token for €80/year.
* **Bank support** (read / transfer): Sparkassen, Volksbanken, Commerzbank, comdirect, DKB,
  Deutsche Bank — both, with pushTAN/chipTAN/decoupled approval. **ING** — read only, transfers
  disabled since 2019 ([ING](https://www.ing.de/hilfe/log-in/fints/)). **Postbank** — degraded since
  the 2023 migration. **N26** — never had it.
* **SCA for reads:** the RTS amendment 2022/2360 raised the renewal to 180 days, but only for
  licensed AISPs; direct customer access (which FinTS is) stays at the bank's discretion, and German
  banks apply **90 days**. So: unattended polling, one TAN per quarter, and some banks want a TAN
  for transactions older than 90 days.
* **Libraries:** `python-fints` 5.0 (decoupled TAN, maintained), `hbci4java` (Java, active 2025),
  **`lib-fints`** (TypeScript, FinTS 3.0, decoupled TAN, Node ≥18, active — the one that fits our
  Runtime), `aqbanking-cli` ≥6.5.5 for decoupled TAN.

### Aggregators (PSD2 XS2A via a licensed party)

Direct XS2A needs a BaFin licence plus eIDAS certificates — not for a household. Via a licensee:

| Provider | Read | Pay | For us |
|---|---|---|---|
| GoCardless Bank Account Data (ex-Nordigen) | ✅ | ❌ | **New signups closed since mid-2025.** Dead for newcomers |
| Enable Banking | ✅ | ✅ (SCA per payment) | "Own accounts" mode without contract — best Nordigen replacement |
| finAPI | ✅ | ✅ | B2B pricing, own-use allowed, no hobby tier |
| Salt Edge / Spectre | ✅ | — | Free tier ended 2025-10-31; Firefly dropping it |
| Tink, Klarna Kosma, banksapi | — | — | Enterprise only / folded / B2B |

### Firefly III side

The Firefly data importer still does CSV/CAMT.053 and GoCardless (useless without credentials).
Community FinTS importers exist and are current: [bnw/firefly-iii-fints-importer](https://github.com/bnw/firefly-iii-fints-importer)
(PHP, Docker, Jan 2026, listed in Firefly's third-party tools), a Node port, and a Home Assistant
add-on. This is the cheapest way to make `importStatement` and `markCleared`
([ACCOUNTING.md](ACCOUNTING.md), both deferred *because nothing produces statement lines*) real.

## 2. Paying

* **Every credit transfer needs the payer's SCA.** Over FinTS the TAN is asked inside the dialog;
  a decoupled TAN means the library waits while the User taps "approve" in the bank's app. Over a
  PISP the bank redirects the User to authenticate. Either way a human acts per payment.
* **Exemptions do not help a third-party agent.** Trusted beneficiaries: only for payments initiated
  in the bank's own channel, a PISP cannot use or populate the list (EBA Q&A 2020_5135). Low value
  (€30 / €100 cumulative / 5 tx): bank's option, not applied to transfers in practice.
* **What a batch buys:** a FinTS *Sammelüberweisung* signs N transfers with one TAN. Fewer taps,
  not zero.
* **What runs without a TAN:** standing orders and SEPA direct-debit mandates — SCA once at setup,
  then autonomous. An agent over FinTS can create/modify standing orders (with a TAN).
* **EBICS** — signature-based, no per-transaction TAN — is what businesses use for exactly this. Banks
  exclude private Girokonten; a small business account (Qonto, Kontist, GLS …) would get it, at a
  fee and with tax-side questions. Not recommended for a household.
* **PSD3/PSR:** SCA exemptions retained, delegated SCA allowed for wallets/acquirers, nothing for a
  consumer's own agent. **Agentic payments** (Visa Intelligent Commerce, Mastercard Agent Pay, live in
  Europe 2026) are card-checkout schemes for registered commercial agents — not SEPA, not us.

## 3. What this means for the architecture

The dashed box is real, but it is **two boxes** and one of them keeps a human inside:

```
bank.listTransactions / bank.getBalance   →  real Connector (lib-fints), unattended,
                                             one Open Question every ~90 days: "please re-approve"
bank.sendMoney                            →  real Connector that *drafts* the transfer, then an
                                             Open Question of kind perform: "approve in your app";
                                             decoupled-TAN polling completes the Operation
```

Consequences, in order of how much they matter:

1. **`bank.sendMoney` stays a suspend-and-resume Operation forever.** Today it suspends for the User
   to type the transfer; with FinTS it suspends for the User to tap approve. ADR-0004's shape is
   unchanged; ADR-0018 becomes load-bearing here the day the Connector is real, exactly as ADR-0010
   warned — the manual step stops being a safety mechanism once the agent can fill the form itself.
2. **Reads unlock the deferred bookkeeping Operations.** A real `bank.listTransactions` is what
   `importStatement` and `markCleared` were waiting for. Cheapest path: run the community FinTS
   importer into Firefly and let the Accountant read Firefly, so the Runtime never holds bank
   credentials at all (consistent with ADR-0023's data-minimisation instinct).
3. **Recurring payments should move rails, not gain automation.** The Accountant's job for a
   predictable bill is to propose a standing order or a mandate once, not to "send money" monthly.
4. **Credentials are a new class of secret.** FinTS PIN + registered product ID in the Runtime, and a
   90-day human re-authentication the Runtime must schedule and surface as an Open Question.

## 4. Recommendation

* **Now:** run `bnw/firefly-iii-fints-importer` against the household bank (any of the Sparkasse /
  Volksbank / DKB / comdirect / Commerzbank family; not ING for payments, not N26 at all). Un-defer
  `importStatement`/`markCleared` on the Firefly side. Register a product ID.
* **Next:** `bank.sendMoney` on `lib-fints` with decoupled TAN, batched, behind `requiresApproval`.
  Sentence for the README: *"the Assistant fills in the transfer; you approve it in your banking app."*
* **Don't:** open a business account for EBICS, wait for PSD3, or plan around aggregators' free
  tiers — two of them died in the last twelve months.

/**
 * `just demo-data` — load what the household *has*.
 *
 * The delicate part is not the data, it is the sequencing. The watcher births a Conversation for
 * every trigger-eligible Thing that appears, so loading a dozen Documents into a running stack
 * would fire a dozen real LLM conversations and a dozen Open Questions before the User had looked
 * at anything. So the loader:
 *
 *   1. pauses the Runtime,
 *   2. creates Things in dependency order, each with an authored idempotency key,
 *   3. books the matching transactions in Firefly,
 *   4. advances the watermark past everything it created — the demo set is *history*, not a queue,
 *   5. unpauses.
 *
 * The system's promise then still holds, and for the right reason: dropping **a new** Document in
 * afterwards is what causes an Open Question to appear within seconds.
 */

import { loadConfig } from "../config.js";
import { describeError, log } from "../log.js";
import { A12Client } from "../a12/client.js";
import { eq, nowIso, path as fieldPath, SPECS, ThingRepository } from "../a12/things.js";
import { FireflyConnector } from "../connectors/firefly.js";
import { RUNTIME_STATE_KEY } from "../watcher/watcher.js";
import { isPaused, setPaused } from "../bootstrap/bootstrap.js";
import { sleep } from "../loop/advance.js";
import {
    DEMO_ACCOUNTS,
    DEMO_BUDGET_WINDOW,
    DEMO_BUDGETS,
    DEMO_DOCUMENTS,
    DEMO_INVOICES,
    DEMO_PARTIES,
    DEMO_PROCESSES,
} from "./data.js";

export interface DemoReport {
    parties: number;
    processes: number;
    documents: number;
    invoices: number;
    accounts: number;
    budgets: number;
    transactions: number;
    questions: number;
}

export async function loadDemo(
    things: ThingRepository,
    firefly: FireflyConnector | undefined,
): Promise<DemoReport> {
    const report: DemoReport = {
        parties: 0,
        processes: 0,
        documents: 0,
        invoices: 0,
        accounts: 0,
        budgets: 0,
        transactions: 0,
        questions: 0,
    };

    // Remember whether the User had already paused it: unconditionally resuming at the end
    // revoked their kill switch, which is the opposite of what they asked for.
    const wasPaused = await isPaused(things);
    await setPaused(things, true);
    log.info("runtime paused for the demo load", { wasAlreadyPaused: wasPaused });

    try {
        const partyIds = new Map<string, string>();
        for (const party of DEMO_PARTIES) {
            const created = await things.create<Record<string, unknown>>(SPECS.Party_DM, {
                kind: party.kind,
                role: party.role,
                name: party.name,
                legalName: party.legalName ?? "",
                email: party.email ?? "",
                phone: party.phone ?? "",
                street: party.street ?? "",
                postcode: party.postcode ?? "",
                city: party.city ?? "",
                country: party.country ?? "",
                iban: party.iban ?? "",
                notes: party.notes ?? "",
                idempotencyKey: party.key,
            });
            partyIds.set(party.key, created.thingId);
            report.parties += 1;
        }

        const processIds = new Map<string, string>();
        for (const process of DEMO_PROCESSES) {
            const created = await things.create<Record<string, unknown>>(SPECS.Process_DM, {
                title: process.title,
                kind: process.kind,
                status: process.status,
                summary: process.summary,
                steps: process.steps,
                idempotencyKey: process.key,
            });
            processIds.set(process.key, created.thingId);
            report.processes += 1;
        }

        const documentIds = new Map<string, string>();
        for (const document of DEMO_DOCUMENTS) {
            const created = await things.create<Record<string, unknown>>(SPECS.Document_DM, {
                title: document.title,
                receivedAt: document.receivedAt,
                source: document.source,
                mediaType: document.mediaType,
                extractedText: document.extractedText,
                classification: document.classification,
                classificationNote: document.classificationNote ?? "",
                idempotencyKey: document.key,
            });
            documentIds.set(document.key, created.thingId);
            report.documents += 1;
        }

        const invoiceIds = new Map<string, string>();
        for (const invoice of DEMO_INVOICES) {
            const created = await things.create<Record<string, unknown>>(SPECS.Invoice_DM, {
                invoiceNumber: invoice.invoiceNumber,
                issuedByPartyThingId: partyIds.get(invoice.partyKey) ?? "",
                issuerName: invoice.issuerName,
                issueDate: invoice.issueDate,
                dueDate: invoice.dueDate,
                serviceDate: invoice.serviceDate,
                amountGross: invoice.amountGross,
                ...(invoice.amountNet === undefined ? {} : { amountNet: invoice.amountNet }),
                currency: invoice.currency,
                subject: invoice.subject,
                recipientName: invoice.recipientName,
                documentThingId: documentIds.get(invoice.documentKey) ?? "",
                processThingId: processIds.get(invoice.processKey) ?? "",
                notes: invoice.notes ?? "",
                idempotencyKey: invoice.key,
            });
            invoiceIds.set(invoice.key, created.thingId);
            report.invoices += 1;
        }

        // Link each classified Document back to the Invoice it produced.
        for (const invoice of DEMO_INVOICES) {
            const documentId = documentIds.get(invoice.documentKey);
            const invoiceId = invoiceIds.get(invoice.key);
            if (!documentId || !invoiceId) continue;
            const document = DEMO_DOCUMENTS.find((candidate) => candidate.key === invoice.documentKey);
            if (!document || document.classification !== "invoice") continue;
            const stored = await things.get<Record<string, unknown>>(
                SPECS.Document_DM,
                `Document_DM/${documentId}`,
            );
            await things.update(SPECS.Document_DM, stored.docRef, {
                ...stored.data,
                classifiedThingId: invoiceId,
                classifiedModel: "Invoice_DM",
            });
        }

        // --- the books -------------------------------------------------------------------
        if (firefly) {
            const existing = await firefly.listAccounts(true).catch(() => []);
            const known = new Set(existing.map((account) => account.name));
            for (const account of DEMO_ACCOUNTS) {
                if (known.has(account.name)) continue;
                await firefly.createAccount({
                    name: account.name,
                    type: account.type,
                    role: "role" in account ? account.role : undefined,
                    openingBalance: "openingBalance" in account ? account.openingBalance : undefined,
                    openingBalanceDate:
                        "openingBalanceDate" in account ? account.openingBalanceDate : undefined,
                });
                report.accounts += 1;
            }

            // The loader only needs each budget's *identity*, not its numbers, and `listBudgets` now
            // requires a period — so ask over the window the demo limits themselves cover.
            const budgets = await firefly
                .listBudgets({ start: DEMO_BUDGET_WINDOW.start, end: DEMO_BUDGET_WINDOW.end })
                .catch(() => [] as Array<{ id: string; name: string }>);
            for (const budget of DEMO_BUDGETS) {
                let budgetId = budgets.find((candidate) => candidate.name === budget.name)?.id;
                if (!budgetId) {
                    const created = await firefly.createBudget(budget.name);
                    budgetId = created.id;
                    report.budgets += 1;
                }
                await firefly
                    .setBudgetLimit({
                        budgetId,
                        start: budget.start,
                        end: budget.end,
                        amount: budget.amount,
                    })
                    .catch((error: unknown) =>
                        log.warn("could not set a budget limit", {
                            budget: budget.name,
                            error: describeError(error),
                        }),
                    );
            }

            for (const invoice of DEMO_INVOICES) {
                if (!invoice.booked) continue;
                const thingId = invoiceIds.get(invoice.key);
                const renovation = invoice.processKey === "process:renovation";
                const expenseAccount = renovation ? "Expenses:House:Renovation" : "Expenses:Health";
                // Carry the budget on the split, not only the expense account: Firefly computes a
                // budget's "spent" from the transactions tagged with it, so a booking with no
                // budget_name leaves the budget report at zero — which is exactly the number the
                // Accountant's budget-checking skill demo must not show. (data.ts: "booked to the
                // renovation account so the budget report stays honest".)
                const budgetName = renovation ? "Renovation" : "Health";
                await firefly.postTransaction({
                    groupTitle: `${invoice.issuerName} ${invoice.invoiceNumber}`,
                    externalId: `demo:${invoice.key}`,
                    thingId,
                    splits: [
                        {
                            type: "withdrawal",
                            date: invoice.issueDate,
                            amount: invoice.amountGross.toFixed(2),
                            description: invoice.subject,
                            currencyCode: invoice.currency,
                            sourceAccount: "Payables",
                            destinationAccount: expenseAccount,
                            budgetName,
                            notes: `Invoice ${invoice.invoiceNumber} — ThingID ${thingId ?? "unknown"}`,
                        },
                    ],
                });
                report.transactions += 1;
            }
        }

        // The demo set is history, not a work queue: move the watermark past everything above.
        const state = (
            await things.search<Record<string, unknown>>(
                SPECS.RuntimeState_DM,
                eq(fieldPath(SPECS.RuntimeState_DM, "singletonKey"), RUNTIME_STATE_KEY),
                2,
            )
        )[0];
        if (state) {
            await things.update(SPECS.RuntimeState_DM, state.docRef, {
                ...state.data,
                watermark: nowIso(new Date(Date.now() + 1000)),
                watermarkDocRefs: [],
            });
        }
    } finally {
        await setPaused(things, wasPaused);
        log.info(wasPaused ? "runtime left paused, as it was before" : "runtime resumed");
    }

    return report;
}

async function main(): Promise<void> {
    const config = loadConfig();
    const client = new A12Client({
        baseUrl: config.thingStoreUrl,
        username: config.thingStoreUser,
        password: config.thingStorePassword,
        keycloakUrl: config.keycloakUrl,
        keycloakRealm: config.keycloakRealm,
        keycloakClientId: config.keycloakClientId,
        locale: config.locale,
    });

    for (let attempt = 1; attempt <= 90; attempt += 1) {
        if (await client.isReachable()) break;
        if (attempt === 90) throw new Error(`ThingStore never became reachable at ${config.thingStoreUrl}`);
        await sleep(2000);
    }
    await client.login();

    const things = new ThingRepository(client);
    const firefly = new FireflyConnector(
        config.fireflyUrl,
        config.fireflyToken,
        config.fireflyTokenFile,
        config.uiBaseUrl,
    );
    const fireflyUp = await firefly.isReachable();
    if (!fireflyUp) {
        log.warn("Firefly is not reachable; loading the Things but not the books", {
            url: config.fireflyUrl,
        });
    }

    const report = await loadDemo(things, fireflyUp ? firefly : undefined);
    log.info("demo data loaded", { ...report });
}

main().catch((error: unknown) => {
    log.error("loading the demo data failed", { error: describeError(error) });
    process.exitCode = 1;
});

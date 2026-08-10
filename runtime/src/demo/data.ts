/**
 * The demo household.
 *
 * Everything here carries a stable, authored `idempotencyKey`, so loading twice is a no-op rather
 * than a second household.
 */

export interface DemoParty {
    key: string;
    kind: string;
    role: string;
    name: string;
    legalName?: string;
    email?: string;
    phone?: string;
    street?: string;
    postcode?: string;
    city?: string;
    country?: string;
    iban?: string;
    notes?: string;
}

export const DEMO_PARTIES: DemoParty[] = [
    {
        key: "party:meyer",
        kind: "organisation",
        role: "doctor",
        name: "Praxis Dr. Meyer",
        legalName: "Gemeinschaftspraxis Dr. med. A. Meyer & Kollegen",
        email: "abrechnung@praxis-meyer.example",
        phone: "+49 2234 55010",
        street: "Hauptstraße 14",
        postcode: "50226",
        city: "Frechen",
        country: "Germany",
        iban: "DE02120300000000202051",
        notes: "General practice. Bills privately, usually 3–4 weeks after treatment.\n\nAlways sends paper.",
    },
    {
        key: "party:zahn",
        kind: "organisation",
        role: "doctor",
        name: "Zahnarztpraxis Lindner",
        email: "praxis@lindner-zahn.example",
        street: "Bahnstraße 3",
        postcode: "50226",
        city: "Frechen",
        country: "Germany",
        notes: "Dentist. Bills through a factoring service, so the payee is not the practice.",
    },
    {
        key: "party:versicherung",
        kind: "organisation",
        role: "insurer",
        name: "Continentale Krankenversicherung",
        email: "leistung@continentale.example",
        street: "Ruhrallee 92",
        postcode: "44139",
        city: "Dortmund",
        country: "Germany",
        notes: "Private health insurer.\n\nClaims go in through the portal; reimbursement usually lands within three weeks.",
    },
    {
        key: "party:dachdecker",
        kind: "organisation",
        role: "craftsman",
        name: "Bedachungen Wilms GmbH",
        email: "buero@wilms-dach.example",
        phone: "+49 2234 91180",
        street: "Industriestraße 7",
        postcode: "50226",
        city: "Frechen",
        country: "Germany",
        iban: "DE89370400440532013000",
        notes: "Roofer for the renovation. Quoted €12,400 for the roof; quote accepted, not yet invoiced.",
    },
    {
        key: "party:stadt",
        kind: "organisation",
        role: "authority",
        name: "Stadt Frechen — Bauaufsicht",
        email: "bauaufsicht@frechen.example",
        street: "Johann-Schmitz-Platz 1",
        postcode: "50226",
        city: "Frechen",
        country: "Germany",
        notes: "Building control. Handles the construction permit for the loft conversion.",
    },
    {
        key: "party:till",
        kind: "person",
        role: "other",
        name: "Till Gartner",
        email: "till@example.com",
        city: "Frechen",
        country: "Germany",
        notes: "The User. Everything in this system is done on their behalf.",
    },
];

export interface DemoProcess {
    key: string;
    title: string;
    kind: string;
    status: string;
    summary: string;
    steps: Array<{ seq: number; title: string; state: string; note?: string; doneAt?: string }>;
}

export const DEMO_PROCESSES: DemoProcess[] = [
    {
        key: "process:renovation",
        title: "Loft conversion",
        kind: "renovation",
        status: "open",
        summary: `Converting the loft into two rooms and a shower room.

**Budget**: €48,000 all in. The roof is the big unknown — the structural report is what decides
whether the dormer is possible at all.

Everything that costs money against this project should be booked to the renovation account so the
budget report stays honest.`,
        steps: [
            {
                seq: 1,
                title: "Get an architect's drawing",
                state: "done",
                note: "Drawings received 2026-03-04.",
                doneAt: "2026-03-04T10:00:00",
            },
            {
                seq: 2,
                title: "Structural report on the roof",
                state: "done",
                note: "Roof will carry a dormer. Report filed.",
                doneAt: "2026-04-18T09:30:00",
            },
            {
                seq: 3,
                title: "Apply for the construction permit",
                state: "pending",
                note: "Submitted to Stadt Frechen 2026-06-02. No answer yet — chase after 8 weeks.",
            },
            { seq: 4, title: "Accept the roofer's quote", state: "done", note: "€12,400 accepted 2026-07-11.", doneAt: "2026-07-11T16:00:00" },
            { seq: 5, title: "Schedule the work", state: "pending", note: "Blocked on the permit." },
        ],
    },
    {
        key: "process:health-2026",
        title: "Medical invoices 2026",
        kind: "invoice-handling",
        status: "open",
        summary: `The standing routine for a private medical invoice.

1. It arrives and becomes a Document.
2. The Receptionist classifies it and extracts the facts.
3. The Accountant checks it and books it against **Expenses:Health** and the payable account.
4. We pay it.
5. We claim it from the insurer, and it sits on the receivable account until they pay.

An invoice is only finished when the receivable balance is back to zero.`,
        steps: [
            { seq: 1, title: "Receive", state: "done" },
            { seq: 2, title: "Check and book", state: "pending" },
            { seq: 3, title: "Pay", state: "pending" },
            { seq: 4, title: "Claim from the insurer", state: "pending" },
            { seq: 5, title: "Reimbursement received", state: "pending" },
        ],
    },
];

export interface DemoInvoice {
    key: string;
    documentKey: string;
    partyKey: string;
    processKey: string;
    invoiceNumber: string;
    issuerName: string;
    issueDate: string;
    dueDate: string;
    serviceDate: string;
    amountGross: number;
    amountNet?: number;
    currency: string;
    subject: string;
    recipientName: string;
    notes?: string;
    /** Whether the demo should also book it in Firefly, so the books and the Things agree. */
    booked: boolean;
}

export interface DemoDocument {
    key: string;
    title: string;
    receivedAt: string;
    source: string;
    mediaType: string;
    extractedText: string;
    classification: string;
    classificationNote?: string;
}

export const DEMO_DOCUMENTS: DemoDocument[] = [
    {
        key: "doc:meyer-2026-117",
        title: "Praxis Dr. Meyer — Rechnung 2026-117",
        receivedAt: "2026-07-02T08:14:00",
        source: "post",
        mediaType: "application/pdf",
        classification: "invoice",
        classificationNote:
            "Private medical invoice (Privatliquidation) from a general practice. GOÄ line items, a single gross total, and a payment deadline.",
        extractedText: `**Gemeinschaftspraxis Dr. med. A. Meyer & Kollegen**
Hauptstraße 14, 50226 Frechen

PRIVATLIQUIDATION

Rechnungsnummer: 2026-117
Rechnungsdatum: 28.06.2026
Patient: Till Gartner
Behandlungsdatum: 12.06.2026

| GOÄ | Leistung | Faktor | Betrag |
|-----|----------|--------|--------|
| 1   | Beratung | 2,3    | 10,72 |
| 5   | Symptombezogene Untersuchung | 2,3 | 10,72 |
| 250 | Blutentnahme | 1,8 | 4,20 |
| 3550| Laborleistungen (Sammelposition) | 1,15 | 158,66 |

**Gesamtbetrag: 184,30 EUR**

Zahlbar bis 28.07.2026 auf das Konto DE02 1203 0000 0000 2020 51.`,
    },
    {
        key: "doc:lindner-4471",
        title: "Zahnarztpraxis Lindner — Rechnung 4471",
        receivedAt: "2026-05-19T09:02:00",
        source: "post",
        mediaType: "application/pdf",
        classification: "invoice",
        classificationNote: "Dental invoice, billed through a factoring service.",
        extractedText: `**Zahnarztpraxis Lindner**
Bahnstraße 3, 50226 Frechen

Rechnungsnummer: 4471
Rechnungsdatum: 15.05.2026
Behandlungsdatum: 06.05.2026
Patient: Till Gartner

Professionelle Zahnreinigung, Kontrolle.

**Rechnungsbetrag: 128,00 EUR**
Zahlbar bis 14.06.2026.`,
    },
    {
        key: "doc:continentale-erstattung",
        title: "Continentale — Leistungsabrechnung Mai 2026",
        receivedAt: "2026-06-08T11:40:00",
        source: "post",
        mediaType: "application/pdf",
        classification: "letter",
        classificationNote:
            "Not an invoice — a reimbursement statement from the insurer confirming they have paid 128,00 EUR for invoice 4471.",
        extractedText: `**Continentale Krankenversicherung a.G.**

Leistungsabrechnung

Zu Ihrer Einreichung vom 20.05.2026 erstatten wir:

Zahnarztpraxis Lindner, Rechnung 4471 vom 15.05.2026 ...... 128,00 EUR

Der Betrag wurde auf Ihr Konto überwiesen.`,
    },
    {
        key: "doc:stadt-eingang",
        title: "Stadt Frechen — Eingangsbestätigung Bauantrag",
        receivedAt: "2026-06-05T14:20:00",
        source: "post",
        mediaType: "application/pdf",
        classification: "letter",
        classificationNote: "Acknowledgement that the building application was received. No action needed yet.",
        extractedText: `**Stadt Frechen — Bauaufsicht**

Ihr Bauantrag vom 02.06.2026, Az. BA-2026-0412, ist bei uns eingegangen.

Die Bearbeitungsdauer beträgt in der Regel 8 bis 12 Wochen. Eine Rückfrage erfolgt bei
unvollständigen Unterlagen.`,
    },
    {
        key: "doc:wilms-mahnung",
        title: "Bedachungen Wilms — Zahlungserinnerung",
        receivedAt: "2026-08-04T07:55:00",
        source: "email",
        mediaType: "text/plain",
        classification: "unclassified",
        extractedText: `**Bedachungen Wilms GmbH**

Zahlungserinnerung

Sehr geehrter Herr Gartner,

zu unserer Rechnung 2026-0455 vom 02.07.2026 über 2.380,00 EUR konnten wir bisher keinen
Zahlungseingang feststellen.

Wir bitten um Ausgleich bis zum 18.08.2026. Mahngebühr: 5,00 EUR.`,
    },
];

export const DEMO_INVOICES: DemoInvoice[] = [
    {
        key: "invoice:meyer-2026-117",
        documentKey: "doc:meyer-2026-117",
        partyKey: "party:meyer",
        processKey: "process:health-2026",
        invoiceNumber: "2026-117",
        issuerName: "Gemeinschaftspraxis Dr. med. A. Meyer & Kollegen",
        issueDate: "2026-06-28",
        dueDate: "2026-07-28",
        serviceDate: "2026-06-12",
        amountGross: 184.3,
        currency: "EUR",
        subject: "Consultation, examination and blood work, 12 June",
        recipientName: "Till Gartner",
        notes: "Laboratory sammelposition is the bulk of it (158,66).",
        booked: true,
    },
    {
        key: "invoice:lindner-4471",
        documentKey: "doc:lindner-4471",
        partyKey: "party:zahn",
        processKey: "process:health-2026",
        invoiceNumber: "4471",
        issuerName: "Zahnarztpraxis Lindner",
        issueDate: "2026-05-15",
        dueDate: "2026-06-14",
        serviceDate: "2026-05-06",
        amountGross: 128.0,
        currency: "EUR",
        subject: "Hygiene appointment and check-up",
        recipientName: "Till Gartner",
        notes: "Paid and already reimbursed by the insurer — see the Continentale statement.",
        booked: true,
    },
    {
        key: "invoice:wilms-2026-0455",
        documentKey: "doc:wilms-mahnung",
        partyKey: "party:dachdecker",
        processKey: "process:renovation",
        invoiceNumber: "2026-0455",
        issuerName: "Bedachungen Wilms GmbH",
        issueDate: "2026-07-02",
        dueDate: "2026-08-01",
        serviceDate: "2026-06-25",
        amountGross: 2380.0,
        currency: "EUR",
        subject: "Scaffolding and roof survey for the loft conversion",
        recipientName: "Till Gartner",
        notes: "Overdue — a payment reminder arrived on 4 August.",
        booked: true,
    },
];

/** The chart of accounts, budgets and the transactions matching the booked invoices. */
export const DEMO_ACCOUNTS = [
    { name: "Checking", type: "asset", role: "defaultAsset", openingBalance: "8400.00", openingBalanceDate: "2026-01-01" },
    { name: "Payables", type: "liability" },
    { name: "Receivable from insurer", type: "asset", role: "savingAsset" },
    { name: "Expenses:Health", type: "expense" },
    { name: "Expenses:House:Renovation", type: "expense" },
    { name: "Expenses:Household", type: "expense" },
    { name: "Income:Reimbursements", type: "revenue" },
] as const;

/**
 * The window the demo budget limits span, used when looking budgets up by name — `listBudgets` needs
 * a period, and the loader only wants each budget's identity.
 */
export const DEMO_BUDGET_WINDOW = { start: "2026-01-01", end: "2027-12-31" };

export const DEMO_BUDGETS = [
    { name: "Health", amount: "300.00", start: "2026-08-01", end: "2026-08-31" },
    { name: "Renovation", amount: "48000.00", start: "2026-01-01", end: "2027-12-31" },
] as const;

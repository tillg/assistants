import { afterEach, describe, expect, it } from "vitest";

import { modelLabel, thingLabel } from "../../../components/conversation/thingLabel";

/**
 * How a Thing is named on screen: its own title, composed by the reader because no Thing carries one
 * (ADR-0002). There is no single "title" field — each subject Model carries its human identity
 * differently — so the table below is the concept, and the short-id fallback is what keeps a link from
 * ever going blank.
 */

/** A document as `useThingById` returns it: the fields under the Model's own root key. */
function doc(model: string, fields: Record<string, unknown>): object {
    return { [model.replace(/_DM$/, "")]: fields };
}

describe("thingLabel", () => {
    it("reads a Document's Title", () => {
        expect(thingLabel("Document_DM", doc("Document_DM", { Title: "Q3 Report" }), "a3f9c1de")).toBe("Q3 Report");
    });

    it("reads a Process's Title", () => {
        expect(thingLabel("Process_DM", doc("Process_DM", { Title: "Onboarding" }), "a3f9c1de")).toBe("Onboarding");
    });

    it("reads a Conversation's Title", () => {
        expect(thingLabel("Conversation_DM", doc("Conversation_DM", { Title: "Invoice 2026-118" }), "a3f9c1de")).toBe(
            "Invoice 2026-118"
        );
    });

    it("reads a Party's Name, then falls to LegalName", () => {
        expect(thingLabel("Party_DM", doc("Party_DM", { Name: "Acme", LegalName: "Acme GmbH" }), "a3f9c1de")).toBe(
            "Acme"
        );
        expect(thingLabel("Party_DM", doc("Party_DM", { Name: "", LegalName: "Acme GmbH" }), "a3f9c1de")).toBe(
            "Acme GmbH"
        );
    });

    it("composes an Invoice from IssuerName and #InvoiceNumber", () => {
        expect(
            thingLabel("Invoice_DM", doc("Invoice_DM", { IssuerName: "Acme GmbH", InvoiceNumber: "2024-0417" }), "x")
        ).toBe("Acme GmbH · #2024-0417");
    });

    it("shows just the issuer, or just the number, when only one is present", () => {
        expect(thingLabel("Invoice_DM", doc("Invoice_DM", { IssuerName: "Acme GmbH" }), "x")).toBe("Acme GmbH");
        expect(thingLabel("Invoice_DM", doc("Invoice_DM", { InvoiceNumber: "2024-0417" }), "x")).toBe("#2024-0417");
    });

    it("falls back to an Invoice's Subject when it has neither issuer nor number", () => {
        expect(thingLabel("Invoice_DM", doc("Invoice_DM", { Subject: "Cloud hosting, May" }), "x")).toBe(
            "Cloud hosting, May"
        );
    });

    it("falls back to a short id when every field is empty", () => {
        expect(thingLabel("Invoice_DM", doc("Invoice_DM", {}), "a3f9c1de-0000-4000-8000-000000000001")).toBe(
            "a3f9c1de"
        );
        expect(thingLabel("Document_DM", doc("Document_DM", { Title: "" }), "b7c2f100-abcd")).toBe("b7c2f100");
        expect(thingLabel("Party_DM", doc("Party_DM", {}), "c1")).toBe("c1");
    });

    it("falls back to a short id for a Model it does not know, and never throws on a shapeless document", () => {
        expect(thingLabel("Widget_DM", doc("Widget_DM", { Title: "ignored" }), "d4e5f6a7b8")).toBe("d4e5f6a7");
        expect(thingLabel("Invoice_DM", undefined, "e5f6a7b8c9")).toBe("e5f6a7b8");
        expect(thingLabel("Invoice_DM", { Invoice: null }, "f6a7b8c9d0")).toBe("f6a7b8c9");
    });
});

describe("modelLabel", () => {
    afterEach(() => localStorage.removeItem("locale"));

    it("gives the English Model name by default", () => {
        expect(modelLabel("Invoice_DM")).toBe("Invoice");
        expect(modelLabel("Party_DM")).toBe("Party");
        expect(modelLabel("Conversation_DM")).toBe("Conversation");
    });

    it("gives the German Model name when the User switched to German", () => {
        localStorage.setItem("locale", "de");
        expect(modelLabel("Invoice_DM")).toBe("Rechnung");
        expect(modelLabel("Process_DM")).toBe("Vorgang");
        expect(modelLabel("Party_DM")).toBe("Kontakt");
    });

    it("gives no label for a Model outside the closed set, so it gets no bracket rather than a wrong one", () => {
        expect(modelLabel("Widget_DM")).toBeUndefined();
        expect(modelLabel("Assistant_DM")).toBeUndefined();
    });
});

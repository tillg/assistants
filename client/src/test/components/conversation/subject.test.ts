import { describe, expect, it } from "vitest";

import { subjectDescriptor } from "../../../components/conversation/subject";
import fixture from "../../fixtures/conversation.json";

describe("subjectDescriptor", () => {
    it("points at the Document a Conversation is about", () => {
        expect(subjectDescriptor("Document_DM", "a3f9c1")).toEqual({
            module: "Document",
            instance: "Document_DM/a3f9c1",
            model: "Document_DM"
        });
    });

    it("points at the Invoice a Conversation is about", () => {
        expect(subjectDescriptor("Invoice_DM", "a3f9c1")).toEqual({
            module: "Invoice",
            instance: "Invoice_DM/a3f9c1",
            model: "Invoice_DM"
        });
    });

    it("points at the Process a Conversation is about", () => {
        expect(subjectDescriptor("Process_DM", "a3f9c1")).toEqual({
            module: "Process",
            instance: "Process_DM/a3f9c1",
            model: "Process_DM"
        });
    });

    it("points at the Party a Conversation is about", () => {
        expect(subjectDescriptor("Party_DM", "a3f9c1")).toEqual({
            module: "Party",
            instance: "Party_DM/a3f9c1",
            model: "Party_DM"
        });
    });

    it("takes the module from the whitelist rather than from stripping _DM", () => {
        // Stripping the suffix would answer for every Model, including the ones with no navigable
        // module — and a descriptor matching no scene renders nothing and reports nothing.
        expect(subjectDescriptor("Conversation_DM", "a3f9c1")).toBeUndefined();
        expect(subjectDescriptor("OpenQuestion_DM", "a3f9c1")).toBeUndefined();
        expect(subjectDescriptor("Assistant_DM", "a3f9c1")).toBeUndefined();
        expect(subjectDescriptor("Operation_DM", "a3f9c1")).toBeUndefined();
        expect(subjectDescriptor("RuntimeState_DM", "a3f9c1")).toBeUndefined();
    });

    it("composes a docRef, because the Thing carries a bare ThingID", () => {
        expect(subjectDescriptor("Invoice_DM", "a3f9c1")?.instance).toBe("Invoice_DM/a3f9c1");
    });

    it("yields nothing for a subjectModel nobody recognises", () => {
        expect(subjectDescriptor("Widget_DM", "a3f9c1")).toBeUndefined();
    });

    it("yields nothing for an empty subjectThingId", () => {
        expect(subjectDescriptor("Invoice_DM", "")).toBeUndefined();
        expect(subjectDescriptor("Invoice_DM", undefined)).toBeUndefined();
    });

    it("yields nothing for a Conversation born of a Schedule, which has no subject", () => {
        const scheduled = { SubjectModel: "", SubjectThingId: "", ScheduledFor: "2026-08-13T06:00:00" };

        expect(subjectDescriptor(scheduled.SubjectModel, scheduled.SubjectThingId)).toBeUndefined();
    });

    it("yields nothing for the fixture, which was called by another Assistant", () => {
        const conversation = fixture.Conversation;

        expect(subjectDescriptor(conversation.SubjectModel, conversation.SubjectThingId)).toBeUndefined();
    });
});

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { Receipt } from "../../../components/conversation/Receipt";
import type { Receipt as ReceiptItem, TranscriptEntry } from "../../../components/conversation/entries";

import { Frame } from "./harness";

function entry(rest: Partial<TranscriptEntry>): TranscriptEntry {
    return { seq: 1, at: "2026-08-13T18:42:19", role: "assistant", kind: "tool-intent", ...rest };
}

const CALL = entry({
    toolName: "bookkeeping.listAccounts",
    text: "Let me see which accounts exist.",
    toolArgs: '{"scope":"all"}'
});
const ANSWER = entry({ seq: 2, kind: "tool-result", role: "tool", toolResult: '[{"name":"Payables"}]' });

function renderReceipt(receipt: ReceiptItem) {
    return render(
        <Frame>
            <Receipt receipt={receipt} />
        </Frame>
    );
}

describe("Receipt", () => {
    it("is one Bubble for one act, closed, naming the Operation", () => {
        renderReceipt({ type: "receipt", intent: CALL, result: ANSWER });

        const receipt = screen.getByTestId("transcript-receipt");
        expect(receipt).toHaveTextContent("🛠️");
        expect(receipt).toHaveTextContent("bookkeeping.listAccounts");
        expect(screen.queryByTestId("transcript-receipt-body")).toBeNull();
    });

    it("opens onto its arguments and what came back", () => {
        renderReceipt({ type: "receipt", intent: CALL, result: ANSWER });

        fireEvent.click(screen.getByTestId("transcript-receipt-toggle"));

        const body = screen.getByTestId("transcript-receipt-body");
        expect(body).toHaveTextContent('{"scope":"all"}');
        expect(body).toHaveTextContent('[{"name":"Payables"}]');
    });

    it("closes again", () => {
        renderReceipt({ type: "receipt", intent: CALL, result: ANSWER });

        fireEvent.click(screen.getByTestId("transcript-receipt-toggle"));
        fireEvent.click(screen.getByTestId("transcript-receipt-toggle"));

        expect(screen.queryByTestId("transcript-receipt-body")).toBeNull();
    });

    it("says so when a call has no answer — in flight, or dead", () => {
        renderReceipt({ type: "receipt", intent: CALL });

        expect(screen.getByTestId("transcript-receipt")).toHaveTextContent("no result");
    });

    it("stands alone for a result with no call to attach it to", () => {
        renderReceipt({ type: "receipt", result: ANSWER });

        fireEvent.click(screen.getByTestId("transcript-receipt-toggle"));

        expect(screen.getByTestId("transcript-receipt-body")).toHaveTextContent('[{"name":"Payables"}]');
    });
});

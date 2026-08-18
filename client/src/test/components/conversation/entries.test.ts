import { afterEach, describe, expect, it, vi } from "vitest";

import {
    clusterEntries,
    readEntries,
    separatorLabel,
    type TranscriptEntry
} from "../../../components/conversation/entries";
import fixture from "../../fixtures/conversation.json";

/** A minimal Entry, so each test names only the fields it is about. */
function entry(seq: number, at: string, rest: Partial<TranscriptEntry> = {}): TranscriptEntry {
    return { seq, at, role: "assistant", kind: "assistant", ...rest };
}

describe("readEntries", () => {
    it("reads the instant whether the form engine parsed it or not", () => {
        // The store's JSON gives a string; the **form engine** hands the component a `Date`. The
        // fixture only ever carries the first, so this is the case that made every separator in
        // the running application empty while the suite stayed green.
        const parsed = readEntries({
            Conversation: {
                Entries: [
                    { Seq: 1, At: new Date("2026-08-16T13:07:16Z"), Role: "user", Kind: "prompt", Text: "go" },
                    { Seq: 2, At: "2026-08-16T13:07:20", Role: "assistant", Kind: "assistant", Text: "done" }
                ]
            }
        });

        expect(parsed[0]!.at).toBe("2026-08-16T13:07:16.000Z");
        expect(parsed[1]!.at).toBe("2026-08-16T13:07:20");
        expect(separatorLabel(parsed[0]!.at)).not.toBe("");
    });

    it("reads the fixture's Entries in seq order", () => {
        expect(readEntries(fixture).map((read) => read.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    });

    it("orders by seq rather than by the order the document happens to carry", () => {
        const document = {
            Conversation: { Entries: [{ Seq: 3 }, { Seq: 1 }, { Seq: 2 }] }
        };

        expect(readEntries(document).map((read) => read.seq)).toEqual([1, 2, 3]);
    });

    it("maps every field the Transcript renders, and ignores the ones it does not", () => {
        const document = {
            Conversation: {
                Entries: [
                    {
                        Seq: 2,
                        At: "2026-08-13T18:42:19",
                        Role: "assistant",
                        Kind: "tool-intent",
                        Text: "Let me see which accounts exist.",
                        ToolName: "bookkeeping.listAccounts",
                        ToolArgs: "{}",
                        ToolResult: "[]",
                        QuestionId: "45e95914",
                        PromptTokens: 1200,
                        CompletionTokens: 34,
                        ArgsHash: "9cfa62f8",
                        IdempotencyKey: "7681648a:2",
                        SomethingNobodyModelled: "ignored"
                    }
                ]
            }
        };

        expect(readEntries(document)).toEqual([
            {
                seq: 2,
                at: "2026-08-13T18:42:19",
                role: "assistant",
                kind: "tool-intent",
                text: "Let me see which accounts exist.",
                toolName: "bookkeeping.listAccounts",
                toolArgs: "{}",
                toolResult: "[]",
                questionId: "45e95914",
                promptTokens: 1200,
                completionTokens: 34
            }
        ]);
    });

    it("leaves absent fields absent rather than inventing values", () => {
        expect(readEntries({ Conversation: { Entries: [{ Seq: 1, Kind: "note" }] } })).toEqual([
            { seq: 1, at: "", role: "", kind: "note" }
        ]);
    });

    it("yields an empty list for a Conversation with no Entries", () => {
        expect(readEntries({ Conversation: { AssistantKey: "accountant" } })).toEqual([]);
    });

    it("yields an empty list rather than throwing for anything that is not a Conversation document", () => {
        expect(readEntries(undefined)).toEqual([]);
        expect(readEntries({})).toEqual([]);
        expect(readEntries({ Conversation: { Entries: "not a list" } })).toEqual([]);
        expect(readEntries({ Conversation: { Entries: ["not an Entry", 7, null] } })).toEqual([]);
    });
});

describe("separatorLabel", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("says Today, Yesterday, or the day itself", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 13, 20, 0, 0));

        expect(separatorLabel("2026-08-13T18:42:14")).toBe("Today at 18:42");
        expect(separatorLabel("2026-08-12T14:40:00")).toBe("Yesterday at 14:40");
        expect(separatorLabel("2026-07-23T15:09:00")).toBe("Thu 23 Jul at 15:09");
    });

    it("says nothing for an instant it cannot read", () => {
        expect(separatorLabel("")).toBe("");
    });
});

describe("clusterEntries", () => {
    it("keeps the Entries of one Turn in a single cluster", () => {
        const clusters = clusterEntries([
            entry(1, "2026-08-13T10:00:00"),
            entry(2, "2026-08-13T10:00:04"),
            entry(3, "2026-08-13T10:00:09")
        ]);

        expect(clusters).toHaveLength(1);
        expect(clusters[0]?.items).toHaveLength(3);
    });

    it("keeps fifty-nine minutes on the same day in one cluster", () => {
        const clusters = clusterEntries([entry(1, "2026-08-13T10:00:00"), entry(2, "2026-08-13T10:59:00")]);

        expect(clusters).toHaveLength(1);
    });

    it("starts a new cluster when the gap reaches one hour", () => {
        const clusters = clusterEntries([entry(1, "2026-08-13T10:00:00"), entry(2, "2026-08-13T11:00:00")]);

        expect(clusters).toHaveLength(2);
        expect(clusters[1]?.items).toHaveLength(1);
    });

    it("starts a new cluster when the day changes, however short the gap", () => {
        const clusters = clusterEntries([entry(1, "2026-08-13T23:50:00"), entry(2, "2026-08-14T00:05:00")]);

        expect(clusters).toHaveLength(2);
    });

    it("still sees the pause that follows an instant it could not read", () => {
        const clusters = clusterEntries([
            entry(1, "2026-08-10T10:00:00"),
            entry(2, "not-a-date", { kind: "note" }),
            entry(3, "2026-08-20T10:00:00")
        ]);

        // The unreadable Entry joins the cluster it arrived in, which is the best that can be said about
        // it. What must not happen is that it becomes the instant the ten-day gap after it is measured
        // from: every later comparison would then answer "no separator due", and the pause — the
        // Conversation's most characteristic feature — would vanish from the thread entirely.
        expect(clusters).toHaveLength(2);
        expect(clusters[0]?.items).toHaveLength(2);
        expect(clusters[1]?.items).toHaveLength(1);
    });

    it("labels each cluster from the instant it begins", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 13, 23, 59, 0));
        try {
            const clusters = clusterEntries([entry(1, "2026-08-12T09:00:00"), entry(2, "2026-08-13T15:09:00")]);

            expect(clusters.map((cluster) => cluster.separator)).toEqual(["Yesterday at 09:00", "Today at 15:09"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("pairs a tool-intent with its tool-result into one Receipt", () => {
        const intent = entry(1, "2026-08-13T10:00:00", { kind: "tool-intent", toolName: "bookkeeping.listAccounts" });
        const result = entry(2, "2026-08-13T10:00:01", { kind: "tool-result", toolName: "bookkeeping.listAccounts" });

        expect(clusterEntries([intent, result])[0]?.items).toEqual([{ type: "receipt", intent, result }]);
    });

    it("pairs across an Entry that came between the call and its answer", () => {
        const intent = entry(1, "2026-08-13T10:00:00", {
            kind: "tool-intent",
            toolName: "bookkeeping.postTransaction"
        });
        const between = entry(2, "2026-08-13T10:00:01", { kind: "approval-request" });
        const result = entry(3, "2026-08-13T10:00:02", {
            kind: "tool-result",
            toolName: "bookkeeping.postTransaction"
        });

        expect(clusterEntries([intent, between, result])[0]?.items).toEqual([
            { type: "receipt", intent, result },
            { type: "entry", entry: between }
        ]);
    });

    it("leaves an unpaired tool-intent standing alone as an open Receipt", () => {
        const intent = entry(1, "2026-08-13T10:00:00", {
            kind: "tool-intent",
            toolName: "bookkeeping.postTransaction"
        });

        expect(clusterEntries([intent])[0]?.items).toEqual([{ type: "receipt", intent }]);
    });

    it("gives each call its own Receipt when the same Operation is called twice", () => {
        const first = entry(1, "2026-08-13T10:00:00", { kind: "tool-intent", toolName: "bookkeeping.postTransaction" });
        const firstResult = entry(2, "2026-08-13T10:00:01", {
            kind: "tool-result",
            toolName: "bookkeeping.postTransaction"
        });
        const second = entry(3, "2026-08-13T10:00:02", {
            kind: "tool-intent",
            toolName: "bookkeeping.postTransaction"
        });
        const secondResult = entry(4, "2026-08-13T10:00:03", {
            kind: "tool-result",
            toolName: "bookkeeping.postTransaction"
        });

        expect(clusterEntries([first, firstResult, second, secondResult])[0]?.items).toEqual([
            { type: "receipt", intent: first, result: firstResult },
            { type: "receipt", intent: second, result: secondResult }
        ]);
    });

    it("does not let a call that died claim a later same-tool call's result", () => {
        // The first call produced no result (in flight, or it failed) and the assistant called the
        // same tool again, which returned. Matching purely by name let the dead first intent claim
        // the second call's result: the first Receipt showed call #1's args beside call #2's result,
        // and the successful call rendered as "no result".
        const first = entry(1, "2026-08-13T10:00:00", { kind: "tool-intent", toolName: "email.fetch" });
        const second = entry(2, "2026-08-13T10:00:01", { kind: "tool-intent", toolName: "email.fetch" });
        const secondResult = entry(3, "2026-08-13T10:00:02", { kind: "tool-result", toolName: "email.fetch" });

        expect(clusterEntries([first, second, secondResult])[0]?.items).toEqual([
            { type: "receipt", intent: first },
            { type: "receipt", intent: second, result: secondResult }
        ]);
    });

    it("does not make a Receipt of the Assistant asking a question", () => {
        const intent = entry(1, "2026-08-13T10:00:00", { kind: "tool-intent", toolName: "ui.askUser" });
        const result = entry(2, "2026-08-13T10:00:01", { kind: "tool-result", toolName: "ui.askUser" });

        expect(clusterEntries([intent, result])[0]?.items).toEqual([
            { type: "entry", entry: intent },
            { type: "receipt", result }
        ]);
    });

    it("clusters the fixture's thread into one run of six Entries and four Receipts", () => {
        const clusters = clusterEntries(readEntries(fixture));

        expect(clusters).toHaveLength(1);
        expect(clusters[0]?.items.filter((item) => item.type === "entry").map((item) => item.entry.seq)).toEqual([
            1, 4, 6, 8, 10, 13
        ]);
        expect(
            clusters[0]?.items
                .filter((item) => item.type === "receipt")
                .map((item) => [item.intent?.seq, item.result?.seq])
        ).toEqual([
            [2, 3],
            [undefined, 5],
            [7, 9],
            [11, 12]
        ]);
    });

    it("yields no clusters for no Entries", () => {
        expect(clusterEntries([])).toEqual([]);
    });
});

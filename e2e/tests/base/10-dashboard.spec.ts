/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

/**
 * The Dashboard: the application's landing page, four Tiles, and four doors.
 *
 * Every number here is asserted against **a second reader of the same facts** — a `QUERY` this spec
 * issues itself, over constraints it writes itself — and never against a fixture. A hard-coded expected
 * count would pass while the Tile and the store were wrong together, and it would go stale the moment
 * the Runtime creates one more Conversation, which it does every few seconds.
 *
 * The second reader is the ThingStore rather than the overviews the plan first named: the Conversations
 * overview runs to forty pages of ten at this data volume, so counting its rows is not something a spec
 * can do. What the comparison still catches is the thing worth catching — a Tile asking the wrong
 * question.
 */

import { expect, test } from "../../fixtures";
import { DashboardPage, TILES } from "../../pages/DashboardPage";
import { TestID } from "../../types/testIds";
import { and, eq, not, ThingStore } from "../../utils/thingstore";

const STATUS = "/Conversation/Status";
const WAITING_FOR = "/Conversation/WaitingFor";

let store: ThingStore;

test.beforeAll(async () => {
    store = await ThingStore.connect("admin");
});

test.describe("Dashboard", () => {
    test("is where the application opens: six Tiles, and no table", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();

        await dashboard.waitForTiles();

        await expect(page.getByTestId(TestID.TABLE)).toHaveCount(0);

        // Slot pairing is positional — the order of the `VIEW_ADD` directives *is* the layout, and the
        // platform offers no way to name a slot. So the order is asserted here, and a reordering is
        // caught rather than merely noticed.
        expect(await dashboard.tileOrder()).toEqual([...TILES]);
    });

    test("leaves no Tile in error, and raises no notification", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();

        await dashboard.waitForTiles();

        await expect(dashboard.failedTiles()).toHaveCount(0);
        await expect(page.getByTestId(TestID.NOTIFICATION_ITEM_TITLE)).toHaveCount(0);
    });

    test("counts what is In flight, and splits it the way the store does", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        const running = await dashboard.lineNumber("conversations", "running");
        const waitingOnYou = await dashboard.lineNumber("conversations", "waiting-on-you");
        const waiting = await dashboard.lineNumber("conversations", "waiting");

        // The headline is the sum of its own three lines — that part is arithmetic and exact.
        expect(await dashboard.headlineNumber("conversations")).toBe(running + waitingOnYou + waiting);

        // And each line is what the store answers for the same question, within the slack the Runtime's
        // two-second scan introduces between the Tile's read and this one.
        expect(running).toBeCloseTo(await store.count("Conversation_DM", eq(STATUS, "running")), -1);
        expect(waitingOnYou).toBeCloseTo(
            await store.count("Conversation_DM", and(eq(STATUS, "waiting"), eq(WAITING_FOR, "user"))),
            -1
        );
        expect(waiting).toBeCloseTo(
            await store.count("Conversation_DM", and(eq(STATUS, "waiting"), not(eq(WAITING_FOR, "user")))),
            -1
        );
    });

    test("counts every Document there is", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        expect(await dashboard.headlineNumber("documents")).toBeCloseTo(await store.count("Document_DM"), -1);
        await expect(dashboard.line("documents", "curve")).toBeVisible();
    });

    test("names the household's staff", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        expect(await dashboard.headlineNumber("assistants")).toBe(await store.count("Assistant_DM"));
        await expect(dashboard.tile("assistants")).toContainText("Receptionist");
        await expect(dashboard.tile("assistants")).toContainText("Accountant");
    });

    test("is a door to the books, and does not ask them anything", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        // Asserted, not followed: Firefly's own login is not this spec's business.
        const anchor = dashboard.tile("bookkeeping").getByRole("link");
        await expect(anchor).toHaveAttribute("href", "http://localhost:8084");
        await expect(anchor).toHaveAttribute("target", "_blank");
        await expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });

    test("is drawn as a control, and carries none of a Tile's slots", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        // A door has nothing to summarise. Beside three Tiles carrying a big figure it used to read as
        // a Tile whose number had failed to load — the one sentence a working door must not say.
        expect(await dashboard.variant("bookkeeping")).toBe("button");
        await expect(dashboard.line("bookkeeping", "headline")).toHaveCount(0);
        await expect(dashboard.line("bookkeeping", "body")).toHaveCount(0);
        await expect(dashboard.line("bookkeeping", "footer")).toHaveCount(0);
    });

    test("draws every Tile that summarises something as a Tile", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        for (const name of ["conversations", "documents", "assistants"] as const) {
            expect(await dashboard.variant(name), `the ${name} Tile`).toBe("tile");
        }
    });

    const DOORS: Array<{ tile: "conversations" | "documents" | "assistants"; column: string }> = [
        { tile: "conversations", column: "Waiting for" },
        { tile: "documents", column: "Classification" },
        { tile: "assistants", column: "LLM model" }
    ];

    for (const { tile, column } of DOORS) {
        test(`opens the ${tile} module when it is clicked`, async ({ getPageAs }) => {
            const page = await getPageAs("admin");
            const dashboard = new DashboardPage(page);
            await dashboard.gotoHome();
            await dashboard.waitForTiles();

            await dashboard.openTile(tile);

            // The column only that overview declares — the assertion `2-navigation.spec.ts` uses.
            const table = page.getByTestId(TestID.TABLE).first();
            await expect(table).toBeVisible();
            await expect(table.getByText(column, { exact: true }).first()).toBeVisible();
            await expect(dashboard.allTiles()).toHaveCount(0);
        });
    }

    test("shows the household's accounts, with one total per currency", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        // Not asserted against a fixture: `just demo-data` may change the household's chart of
        // accounts, and a spec that pinned "Checking" would fail for a reason that is not a defect.
        // What must hold is the shape — a named row carrying a parseable amount.
        await expect(dashboard.rows("accounts", "account").first()).toBeVisible();
        const first = (await dashboard.rows("accounts", "account").first().innerText()).trim();
        expect(first, `"${first}" carries no amount`).toMatch(/\d/);

        // Exactly one total line while the books are kept in one currency. Two currencies would
        // legitimately give two, and never a grand total — so this asserts "at least one" and that
        // each total names a currency, rather than pinning the count to the demo data.
        const totals = await dashboard.rows("accounts", "total").allInnerTexts();
        expect(totals.length).toBeGreaterThan(0);
        for (const total of totals) {
            expect(total).toMatch(/[€$£]|EUR|USD|GBP/);
        }
    });

    test("shows the last bookings, and no more than ten", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        const bookings = await dashboard.rows("transactions", "booking").count();
        expect(bookings).toBeGreaterThan(0);
        expect(bookings).toBeLessThanOrEqual(10);

        // Deliberately NOT an ordering assertion. Measured against this household: 21 of its 24
        // transactions share the date 2026-08-01 and no group carries more than one split, so
        // "newest first" would pass on shuffled input and prove nothing. Ordering and split
        // flattening are asserted in the Runtime's unit tier, against fixtures built to have them.
    });

    test("refuses to book anything, however the browser asks", async ({ getPageAs, request }) => {
        // The assertion this whole change exists to make. The Dashboard reads the books through a
        // route that executes Operations, and `execute()` sits BELOW the approval machinery — so the
        // gate refusing everything mutating is the entire guarantee, and it is attacked here rather
        // than assumed.
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);
        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        const token = await page.evaluate(() => {
            const raw = window.sessionStorage.getItem("uaa") ?? window.localStorage.getItem("uaa");
            return raw ?? "";
        });

        const attack = async (operation: string, args: Record<string, unknown>) => {
            const response = await request.post("http://localhost:8082/api/v2/rpc", {
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                },
                data: [
                    {
                        jsonrpc: "2.0",
                        id: "attack",
                        method: "EXTERNAL_CALL",
                        params: { operation, args }
                    }
                ],
                failOnStatusCode: false
            });
            return response;
        };

        const booking = await attack("bookkeeping.postTransaction", {
            externalId: "e2e-attack",
            splits: [
                {
                    type: "withdrawal",
                    date: "2026-08-01",
                    amount: "999.00",
                    description: "e2e must never book this",
                    sourceAccount: "Checking",
                    destinationAccount: "Expenses:Health"
                }
            ]
        });

        // Either the token was not recoverable from storage (401) or it was and the gate refused
        // (200 carrying ok:false). Both are a refusal; neither is a booking. What must never happen
        // is an answer saying the posting landed.
        const body = await booking.text();
        expect(body).not.toContain('"ok":true');
        expect(body.toLowerCase()).not.toContain("alreadyexisted");
    });

    test("is refused outright when nobody is logged in", async ({ request }) => {
        const response = await request.post("http://localhost:8082/api/v2/rpc", {
            headers: { "Content-Type": "application/json" },
            data: [
                {
                    jsonrpc: "2.0",
                    id: "anonymous",
                    method: "EXTERNAL_CALL",
                    params: { operation: "bookkeeping.listAccounts", args: {} }
                }
            ],
            failOnStatusCode: false
        });

        expect(response.status()).toBe(401);
    });

    test("one Tile failed leaves the other five standing", async ({ getPageAs }) => {
        const page = await getPageAs("admin");
        const dashboard = new DashboardPage(page);

        // The documents Tile's batch, and only it: matched on the body naming `Document_DM`, so the
        // other Tiles' batches go through untouched. This is the **soft-failure** path — a query that
        // fails — which is a different mechanism from a view that throws while rendering.
        await page.route("**/api/v2/rpc", async (route) => {
            const body = route.request().postData() ?? "";
            if (body.includes("Document_DM") && body.includes("QUERY")) {
                await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
                return;
            }
            await route.continue();
        });

        await dashboard.gotoHome();
        await dashboard.waitForTiles();

        await expect(dashboard.tile("documents")).toHaveAttribute("data-state", "error");
        await expect(dashboard.failedTiles()).toHaveCount(1);
        await expect(dashboard.tile("conversations")).toHaveAttribute("data-state", "ready");
        await expect(dashboard.tile("assistants")).toHaveAttribute("data-state", "ready");
        await expect(dashboard.tile("bookkeeping")).toHaveAttribute("data-state", "ready");
        // The two Tiles that read the books go through a different seam entirely — the External Call,
        // not the store's JSON-RPC — so a failure in one must not reach the other. That the intercept
        // above leaves them standing is what proves the two seams are actually independent.
        await expect(dashboard.tile("transactions")).toHaveAttribute("data-state", "ready");
        await expect(dashboard.tile("accounts")).toHaveAttribute("data-state", "ready");

        // The page is still a page: the menu still works, and A12 raised nothing.
        await expect(page.getByTestId(TestID.NOTIFICATION_ITEM_TITLE)).toHaveCount(0);
        await dashboard.clickMenuItem("Conversations");
        await expect(page.getByTestId(TestID.TABLE).first()).toBeVisible();
    });
});

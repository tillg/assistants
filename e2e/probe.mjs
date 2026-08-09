import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("requestfinished", async (r) => {
    if (r.url().includes("/api/v2/rpc")) {
        const resp = await r.response();
        console.log("RPC", r.method(), resp?.status(), (r.postData() ?? "").slice(0, 90));
    }
});
await page.goto("http://localhost:8081/");
await page.fill("#username", "admin");
await page.fill("#password", "A12PT-admintest");
await page.press("#password", "Enter");
await page.waitForTimeout(6000);

await page.locator("[data-role=menu-item]").filter({ hasText: "Open Questions" }).click();
await page.waitForTimeout(3000);
await page.locator("[data-role=table-body-row]").first().click();
await page.waitForTimeout(3000);

const form = page.getByRole("form");
await form.getByRole("combobox", { name: /^Confirmed\s*\*?$/ }).selectOption("true");
const answer = form.getByRole("textbox", { name: /^Answer\s*\*?$/ });
console.log("answer editor count:", await answer.count());
await answer.click();
await answer.pressSequentially("Yes, book it.", { delay: 15 });

const at = form.getByRole("textbox", { name: /^Answered at\s*\*?$/ });
console.log("answered-at count:", await at.count());
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "");
await at.fill(stamp);
await at.press("Tab");
await page.waitForTimeout(500);
console.log("answered-at value:", await at.inputValue(), "wanted", stamp);

const save = form.getByRole("button", { name: "Save" });
console.log("save count:", await save.count(), "disabled:", await save.first().isDisabled());
await save.first().click();
await page.waitForTimeout(6000);
console.log(
    "notifications:",
    await page.evaluate(() => [...document.querySelectorAll("[data-role=notification-item-title], [data-role=message]")].map((e) => e.textContent))
);
await page.screenshot({ path: "/Users/tgartner/git/assistents/tmp/answer-after-save.png", fullPage: true });
await browser.close();

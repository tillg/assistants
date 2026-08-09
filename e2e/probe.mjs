import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://localhost:8081/");
await page.fill("#username", "admin");
await page.fill("#password", "A12PT-admintest");
await page.press("#password", "Enter");
await page.waitForTimeout(6000);

// Parties
await page.locator('[data-role=menu-item]').filter({ hasText: "Parties" }).click();
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Add" }).click();
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("form input, form textarea, form select, form [contenteditable]").forEach((el) => {
        out.push({
            tag: el.tagName,
            type: el.getAttribute("type"),
            role: el.getAttribute("role"),
            id: el.id,
            name: el.getAttribute("name"),
            aria: el.getAttribute("aria-label"),
            labelledby: el.getAttribute("aria-labelledby"),
            labelText: (() => {
                const lb = el.getAttribute("aria-labelledby");
                if (lb) {
                    return lb
                        .split(" ")
                        .map((i) => document.getElementById(i)?.textContent)
                        .join("|");
                }
                const l = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
                return l?.textContent ?? null;
            })()
        });
    });
    return out;
});
console.log("FORM FIELDS:", JSON.stringify(info, null, 1));

const buttons = await page.evaluate(() =>
    [...document.querySelectorAll("form button")].map((b) => b.textContent?.trim()).filter(Boolean)
);
console.log("FORM BUTTONS:", JSON.stringify(buttons));
await page.screenshot({ path: "/Users/tgartner/git/assistents/tmp/party-add.png", fullPage: true });
await browser.close();

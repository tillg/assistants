import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => {
    if (m.type() === "error") console.log("PAGE ERROR:", m.text().slice(0, 200));
});
await page.goto("http://localhost:8081/");
await page.fill("#username", "admin");
await page.fill("#password", "A12PT-admintest");
await page.press("#password", "Enter");
await page.waitForTimeout(6000);

// ---------- assistant instance form ----------
await page.locator("[data-role=menu-item]").filter({ hasText: "Assistants" }).click();
await page.waitForTimeout(2500);
await page.locator("[data-role=table-body-row]").filter({ hasText: "receptionist" }).first().click();
await page.waitForTimeout(2500);
console.log(
    "instance form buttons:",
    await page.evaluate(() => [...document.querySelectorAll('[role="form"] button')].map((b) => b.textContent?.trim()))
);
await page.getByRole("form").getByRole("button", { name: "Edit" }).click();
await page.waitForTimeout(2000);
console.log(
    "edit mode buttons:",
    await page.evaluate(() => [...document.querySelectorAll('[role="form"] button')].map((b) => b.textContent?.trim()))
);
const editor = page.getByRole("form").getByRole("textbox", { name: /^System prompt\s*\*?$/ });
console.log("systemPrompt editor count:", await editor.count());
console.log("  contenteditable:", await editor.first().getAttribute("contenteditable"));
console.log("  data-lexical-editor:", await editor.first().getAttribute("data-lexical-editor"));
console.log("  toolbar count:", await page.locator('[data-role="rich-text-editor-toolbar"]').count());

await editor.first().click();
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await editor.first().pressSequentially("## Probe heading\nSome **bold** text.", { delay: 15 });
await page.waitForTimeout(500);
console.log("h2 in editor:", await editor.first().locator("h2").count(), "strong:", await editor.first().locator("strong").count());

await page.getByRole("form").getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(4000);
console.log(
    "after save buttons:",
    await page.evaluate(() => [...document.querySelectorAll('[role="form"] button')].map((b) => b.textContent?.trim()))
);
console.log("form count after save:", await page.getByRole("form").count());
await page.screenshot({ path: "/Users/tgartner/git/assistents/tmp/assistant-after-save.png", fullPage: true });
await browser.close();

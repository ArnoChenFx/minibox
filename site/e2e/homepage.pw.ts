import { expect, test } from "@playwright/test";

test("loads from the Pages subpath without broken assets or runtime errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto("./");
  await expect(page).toHaveTitle("MiniBox — Your agents. Your machine. Your rules.");
  await expect(page.locator("h1")).toHaveText("Your agents.Your machine.Your rules.");
  await page.locator("#product").scrollIntoViewIfNeeded();
  await expect(page.locator("#product-screenshot")).toHaveJSProperty("naturalWidth", 2880);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const brokenAnchors = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute("href") ?? "")
        .filter((href) => href !== "#" && !document.getElementById(href.slice(1))),
    );
  expect(brokenAnchors).toEqual([]);
  expect(errors).toEqual([]);
});

test("switches languages, persists the choice, and accepts shareable language URLs", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "切换为中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("h1")).toContainText("你说了算。");
  await expect(page).toHaveURL(/\?lang=zh/);
  await expect(page.locator("#install-command")).toContainText("ghcr.io/arnochenfx/minibox:latest");
  await page.reload();
  await expect(page.locator("h1")).toContainText("你的机器。");
  await page.goto("./?lang=en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("h1")).toContainText("Your machine.");
  await expect(page.locator("#start-title")).toContainText("A small setup.");
});

test("changes real screenshots with pointer and keyboard and opens a dismissible preview", async ({ page }) => {
  await page.goto("./");
  const boxes = page.getByRole("tab", { name: "Boxes", exact: true });
  await boxes.click();
  await expect(boxes).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#product-screenshot")).toHaveAttribute("src", /boxes-light/);
  await boxes.press("ArrowRight");
  const terminal = page.getByRole("tab", { name: "Terminal", exact: true });
  await expect(terminal).toBeFocused();
  await expect(terminal).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#product-screenshot")).toHaveAttribute("src", /terminal-light/);
  await page.getByRole("button", { name: "Enlarge screenshot" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#dialog-screenshot")).toHaveAttribute("src", /terminal-light/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Enlarge screenshot" })).toBeFocused();
});

test("copies the complete install commands and reports denied clipboard access", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("./");
  await page.locator("[data-copy]").click();
  await expect(page.getByRole("status")).toContainText("Installation commands copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await page.locator("#install-command").textContent(),
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("denied")) });
  });
  await page.locator("[data-copy]").click();
  await expect(page.getByRole("status")).toContainText("Select and copy the commands manually.");
});

test("keeps content and navigation usable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/minibox/");
  await expect(page.locator("h1")).toContainText("Your agents.");
  await page.locator(".mobile-menu summary").click();
  await page.locator('.mobile-menu a[href="#how-it-works"]').click();
  await expect(page).toHaveURL(/#how-it-works$/);
  const question = page.getByText("Can I run untrusted code in a box?", { exact: true });
  await question.click();
  await expect(page.getByText("Boxes use Docker container isolation", { exact: false })).toBeVisible();
  await expect(page.locator("#install-command")).toContainText("docker exec minibox cat /data/access_key");
  await context.close();
});

test("has no horizontal overflow at narrow and tablet widths in either language", async ({ page }) => {
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ["en", "zh"]) {
      await page.goto(`./?lang=${language}`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${width}px ${language}`,
      ).toBe(true);
      await expect(page.locator("[data-language]")).toBeVisible();
      await expect(page.locator("h1")).toBeVisible();
    }
  }
});

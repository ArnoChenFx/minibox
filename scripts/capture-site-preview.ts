/** Capture review images outside the source tree. CI uploads dist/site-preview as a downloadable artifact. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const root = join(import.meta.dir, "..");
const output = join(root, "dist", "site-preview");
const port = 4185;
const base = `http://127.0.0.1:${port}/minibox/`;

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const server = Bun.spawn([process.execPath, "scripts/serve-site.ts"], {
  cwd: root,
  env: { ...process.env, SITE_PORT: String(port) },
  stdout: "ignore",
  stderr: "inherit",
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The local preview server is still starting.
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Homepage preview server did not start");
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox"],
  });
  try {
    for (const language of ["zh", "en"]) {
      for (const device of ["desktop", "mobile"]) {
        const page = await browser.newPage({
          viewport: device === "desktop" ? { width: 1440, height: 1050 } : { width: 390, height: 844 },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => {
          if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
        });
        await page.goto(`${base}?lang=${language}`, { waitUntil: "networkidle" });
        // This script uses the server's TypeScript configuration, which does not include DOM globals.
        await page.evaluate("document.fonts.ready");
        await page.evaluate(
          "Promise.all([...document.images].map(image => { image.loading = 'eager'; return image.decode(); }))",
        );
        if (errors.length) throw new Error(errors.join("\n"));
        await page.screenshot({ path: join(output, `${device}-${language}-full.png`), fullPage: true });
        await page.screenshot({ path: join(output, `${device}-${language}-hero.png`) });
        if (device === "desktop") {
          await page.locator("#capabilities").screenshot({ path: join(output, `${device}-${language}-features.png`) });
        }
        await page.close();
      }
    }
    writeFileSync(
      join(output, "README.txt"),
      "MiniBox homepage preview / 产品主页预览\n\n" +
        "desktop-zh-full.png: 中文桌面完整页面\n" +
        "desktop-en-full.png: 英文桌面完整页面\n" +
        "mobile-zh-full.png: 中文移动端完整页面\n" +
        "mobile-en-full.png: 英文移动端完整页面\n" +
        "*-hero.png: 首屏；*-features.png: 功能区\n\n" +
        "Images are CI artifacts, not committed repository files.\n",
    );
    console.log(`Homepage previews saved to ${output}`);
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  await server.exited;
}

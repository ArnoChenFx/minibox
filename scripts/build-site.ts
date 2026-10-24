/** Assemble the standalone project homepage, reusing the project's own brand and screenshots. */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const output = join(root, "dist", "site");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "assets", "screenshots"), { recursive: true });
for (const file of ["index.html", "styles.css", "main.js"]) {
  const content = readFileSync(join(root, "site", file), "utf8").replaceAll("__MINIBOX_VERSION__", version);
  writeFileSync(join(output, file), content);
}
for (const file of ["LICENSE", "NOTICE"]) {
  cpSync(join(root, file), join(output, file));
}
for (const file of ["logo-mark.svg", "favicon.svg"]) {
  cpSync(join(root, "web", "assets", file), join(output, "assets", file));
}
cpSync(join(root, "site", "assets", "agents"), join(output, "assets", "agents"), { recursive: true });
for (const language of ["en", "zh-CN"]) {
  mkdirSync(join(output, "assets", "screenshots", language), { recursive: true });
  for (const file of ["overview-light.png", "boxes-light.png", "box-terminal-light.png"]) {
    cpSync(join(root, "docs", "screenshots", language, file), join(output, "assets", "screenshots", language, file));
  }
}
writeFileSync(join(output, ".nojekyll"), "");
writeFileSync(
  join(output, "robots.txt"),
  "User-agent: *\nAllow: /\nSitemap: https://arnochenfx.github.io/minibox/sitemap.xml\n",
);
writeFileSync(
  join(output, "sitemap.xml"),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://arnochenfx.github.io/minibox/</loc></url></urlset>\n',
);
console.log(`Homepage built: ${output}`);

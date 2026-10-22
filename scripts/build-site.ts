/** Assemble the standalone project homepage, reusing the project's own brand and screenshots. */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const output = join(root, "dist", "site");

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "assets", "screenshots"), { recursive: true });
for (const file of ["index.html", "styles.css", "main.js"]) {
  cpSync(join(root, "site", file), join(output, file));
}
for (const file of ["logo-mark.svg", "favicon.svg"]) {
  cpSync(join(root, "web", "assets", file), join(output, "assets", file));
}
cpSync(join(root, "site", "assets", "agents"), join(output, "assets", "agents"), { recursive: true });
for (const file of ["overview-light.png", "boxes-light.png", "terminal-light.png"]) {
  cpSync(join(root, "docs", "screenshots", file), join(output, "assets", "screenshots", file));
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

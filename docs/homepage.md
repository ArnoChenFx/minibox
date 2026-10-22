# Project homepage

The public MiniBox website is a standalone static site in `site/`, separate from the authenticated console in `web/`. Its intended address is **https://arnochenfx.github.io/minibox/**. Serving the project website does not expose a MiniBox server or Docker socket.

## Design and content

The visual direction uses MiniBox's existing purple cube mark, a warm light background, large editorial type, and a workspace/terminal illustration. The illustration is labeled as an example; the product gallery uses real console screenshots from `docs/screenshots/`.

The page introduces the product, shows the console, explains the main capabilities, walks through connecting an agent, and provides the source installation commands. English is the default. The language button switches to Chinese, remembers the choice when storage is available, and updates the URL to `?lang=zh` for sharing. An explicit `?lang=en` overrides a remembered preference.

The agent strip uses the Claude Code, Codex and OpenCode brand icons vendored under `site/assets/agents/`, with pinned upstream provenance and the MIT license included there. It has no external icon requests. The homepage does not include a roadmap section or navigation entry.

Content is based on the README, `docs/design.md`, `docs/agents.md`, and the repository's issues. The design document and tracking checklists can lag implementation, so the page distinguishes implemented capabilities from unfinished work:

| Area | Homepage treatment | Reference |
| --- | --- | --- |
| Box lifecycle, exec, file access, MCP and CLI | Available | #9, #12, #22, #23 |
| Volumes, storage pools and NAS/NFS | Available | #24, #30 |
| Sessions and takeover | Available | #14 |
| Scoped tokens and quotas | Available | #13 |
| Agent tool installation | Available | #8 |
| Checkpoints | Take, fork, rollback and retention available; scheduling, import/export and MCP tools still planned | #11, README “Checkpoints” |

The page describes Docker container isolation accurately and does not present it as a security boundary for untrusted third-party code. “No platform subscription” refers to MiniBox, not hardware or paid AI services.

## Build, preview, and test

```bash
bun install --frozen-lockfile
bun run build:site
bun run preview:site
```

The preview serves `dist/site/` at `http://127.0.0.1:4173/minibox/`, including the same path prefix used by GitHub Pages. `SITE_PORT` changes the preview port. The build copies the three website source files, the existing logo/favicon and three existing console screenshots; it also creates `.nojekyll`, `robots.txt` and a sitemap. No public CDN, hosted font, external JavaScript, application API or runtime package is required by the resulting website.

Run browser checks with:

```bash
bunx playwright install chromium
bun run test:site
```

When using a system Chromium instead of Playwright's bundled browser:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium bun run test:site
```

Playwright starts and stops its own preview server. The checks cover real asset loading at `/minibox/`, English/Chinese switching and persistence, screenshot tabs and keyboard navigation, the image dialog, clipboard success and refusal, no-JavaScript content/navigation, and layouts from 320px to desktop widths. Test files use `.pw.ts` so the normal `bun test` application suite does not load the Playwright runner. Browser traces on failure go to the ignored `dist/site-test-results/` directory.

Use `bun run check` for the repository's existing checks as well. In environments that default to `umask 077`, run checks with `umask 022` so the existing file-mode assertions use the repository's expected creation mask.

## GitHub Pages deployment

The `Project homepage` workflow tests homepage changes on pull requests and relevant pushes. A push to `main` or the dedicated `website` publication branch allows a successful test job to build and publish **only `dist/site/`** using the official `configure-pages`, `upload-pages-artifact`, and `deploy-pages` actions. The `website` branch supports publishing a reviewed feature commit without merging its PR. The deploy action waits for GitHub's deployment result. Pull request events never publish. Deployment uses the repository's `GITHUB_TOKEN` with Pages and OIDC permissions; it does not require a personal access token or contents write permission. Actions are pinned to commit SHAs, following the repository's existing policy.

The repository is configured under **Settings → Pages → Build and deployment** with **Source: GitHub Actions**. Keep this setting and any existing custom domain. The `github-pages` environment permits `main` and `website`. To publish before merging, push the intended tested commit to `website` without force; after merge, homepage changes on `main` publish automatically. If deployment protection rules change, the selected branch must satisfy those rules.

To verify a release, check GitHub's Pages deployment/build status, request the public URL, and confirm that the logo, stylesheet, JavaScript and all three gallery images load under `/minibox/`. A successful local build or branch push alone does not establish a successful public deployment.

Generated homepage review screenshots stay outside the checkout, under the workspace artifacts directory. Do not commit them or link to repository-hosted review screenshots in the PR. The build uses only the three pre-existing console screenshots explicitly listed in `scripts/build-site.ts`.

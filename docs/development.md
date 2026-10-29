# Development

This page is for people who change MiniBox. To run MiniBox, read [Install](admin/install.md).

## Requirements

- [Bun](https://bun.sh) 1.4.4 or later. `package.json` sets this as the minimum version.
- Docker Engine, for the template check and the real-engine tests. The unit tests do not need Docker.
- Chromium, for the browser tests in `tests/` and `bun run screenshots`. See [Tests](#tests).

## Set up

```bash
bun install --frozen-lockfile
bun run dev
```

`bun run dev` starts the server and restarts it when a file changes. `bun start` runs it without watching. Both read `.env` in the repository root. Without a `DATA_DIR` setting, the data goes to `data/` in the repository root. Open <http://127.0.0.1:3920> to see the console.

## Checks

Run the same checks as CI before you open a pull request:

```bash
bun run check
```

`bun run check` runs these four scripts in order:

| Script | What it does |
|---|---|
| `bun run fmt:check` | Checks formatting with oxfmt. `bun run fmt` rewrites the files. |
| `bun run lint` | Lints with oxlint. Any warning fails the run. |
| `bun run typecheck` | Type-checks the code with `bun check --no-script` in strict mode. |
| `bun test` | Runs the unit and API tests. These use fake runtimes and need no Docker. |

`bun test` also runs `tests/docs-links.test.ts`, which checks the relative links and anchors in every Markdown file.

For a quicker local run, `bun run check:quick` runs the same three static checks, and `bun test` only for the test files that changed since `origin/main`. It stops at the first failure.

## Tests

| Command | Needs | What it covers |
|---|---|---|
| `bun test` | Nothing, except Chromium for the browser tests | Unit and API tests. Part of `bun run check`. The browser tests run whenever Chromium can be found (see [Tests](#tests)), so layout regressions show up locally. |
| `bun run test:docker` | Docker | Real-engine tests in `tests/docker-*.test.ts`. Not part of `bun run check`. |
| `bun run build:template` and `bun run check:template` | Docker | The base template: its user, tools, mount points and each security profile. |
| `bun run test:site` | Chromium | Browser tests for the homepage. |
| `bun run screenshots` | Docker and Chromium | Captures the console screenshots for the README and the homepage. Not part of CI. See [Screenshots](#screenshots). |

`bun test` also runs the browser tests in `tests/`: `preview-browser.test.ts` and the `web-*-browser.test.ts` files. They drive a real Chromium against a MiniBox server on a fake runtime, so they need no Docker, only a browser. (`files-browser.test.ts` has "browser" in its name but tests the file API, not a page.) `tests/support/chromium.ts` finds it, in this order:

1. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, when it points to a file that exists.
2. The Chromium Playwright itself installed (`bunx playwright install chromium`), when it exists.
3. The newest usable build in a Playwright browser cache: `~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS, or `PLAYWRIGHT_BROWSERS_PATH` when that is set. `chromium-<version>/chrome-linux*/chrome` and `chromium-<version>/chrome-mac*/…` are recognised, so an older cached build such as `chromium-1187` still runs the tests even when the installed Playwright wants a newer one.
4. `chromium`, `chromium-browser`, `google-chrome` or `google-chrome-stable` on `PATH`, or the installed Chrome bundle on macOS.

A machine with any of those runs the browser tests by default; nothing has to be set. When none is found, the browser suites are skipped locally, and in CI the run fails with an error that names the test file and says how to install a browser. So a layout regression the browser tests cover shows up in `bun test` before it reaches CI.

`bun run test:docker` runs the real-engine test files listed in `scripts/docker-integration.ts`, one process each. Every run uses its own label prefix, which starts with `mbit`, and removes the containers, images, volumes and networks it created, even when a test fails. `DOCKER_SOCKET` selects another Docker socket. `MINIBOX_TEST_IMAGE` replaces the default test image, `alpine:3.20`.

To run one real-engine test file by itself, set `MINIBOX_TEST_DOCKER=1` and a `MINIBOX_TEST_PREFIX` that matches `mbit` followed by 3 to 40 lowercase letters, digits or hyphens:

```bash
MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbitlocal1 bun test tests/docker-runtime.test.ts
```

`check:template` runs `scripts/check-box-image.sh` against a built image. To check the arm64 image, pass its tag and set `PLATFORM=linux/arm64`.

The same script runs on each official template in CI, for `linux/amd64` and, under QEMU emulation, for `linux/arm64`. `PLATFORM=linux/arm64` also makes it check that the image really is arm64, and it skips the `ping` probe, because file capabilities are not applied to binaries run under emulation.

## Build

```bash
bun run build:cli        # writes dist/minibox, a standalone CLI
bun run build:template   # builds the base template, minibox-template:base
docker build -t minibox . # builds the release image
```

The template description appears in `templates/base/Dockerfile`, in `BASE_DESCRIPTION` in `src/services/base-template.ts`, and in the `build:template` script. `tests/template.test.ts` checks that they match.

Several files name the Node.js major version: the base template Dockerfile, `src/services/base-template.ts`, both READMEs, the web console strings and `package.json`. `tests/template.test.ts` checks that each one matches the `FROM node:` line in the Dockerfile. Change them together.

## OpenAPI document

`docs/openapi.json` is generated from the operation registry in `src/operations/registry.ts`. After you add or change an operation, regenerate the document:

```bash
bun run openapi
```

`tests/openapi.test.ts` fails when the committed file does not match the registry.

## Continuous integration

| Workflow | When it runs | What it does |
|---|---|---|
| CI (`ci.yml`) | Pushes to `main`, pull requests, and calls from the release workflow | The `check` job installs Chromium with Playwright, then runs `fmt:check`, `lint`, `typecheck` and `bun test`. The `docker` job builds the release image, starts it and probes `/login`. It also builds the base template for `linux/amd64` and `linux/arm64` and runs `scripts/check-box-image.sh` on each. The `official-templates` job builds each official template for `linux/amd64` and `linux/arm64`, the second one under QEMU emulation, and runs the same script on both images, with `REQUIRED_TOOLS` set for the minimal template. A first step builds both platforms into the GitHub Actions cache only, so the two loaded builds reuse those layers instead of building the template twice. |
| Integration (`integration.yml`) | Pushes to `main`, pull requests, and manual runs | Runs `bun run test:docker` on the runner's Docker engine. |
| Project homepage (`pages.yml`) | Changes to the homepage files, on pushes to `main`, pull requests, and manual runs | Runs the browser tests. On `main` only, deploys `dist/site` to GitHub Pages. |
| Release (`release.yml`) | Tags that match `v*.*.*` | Runs the CI checks, checks that the tag matches `package.json`, pushes the multi-architecture image to `ghcr.io/arnochenfx/minibox`, and creates a GitHub release from the matching CHANGELOG section. |

## Screenshots

`bun run screenshots` captures the console for the README, the homepage and the docs. Run it by hand before a release. CI does not run it.

The script starts its own MiniBox server, with a temporary data directory, a free port, the label prefix `minibox-demo` and its own Docker network. It seeds fixed demo content and captures 15 screens in light and dark, in English and Simplified Chinese, into `dist/screenshots/`. It publishes the overview, the box list and the box terminal to `docs/screenshots/en/` and `docs/screenshots/zh-CN/`. When `pngquant` is installed, it compresses the published images. The host name in the captures is `workstation`, and the version comes from `package.json`.

The run removes the containers, images, volumes and networks it created, and its data directory, even when a capture fails. The first run builds the base template, which takes a few minutes.

It needs a Docker engine at `DOCKER_SOCKET` (`/var/run/docker.sock` by default) and Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chrome, or run `bunx playwright install chromium` once.

Do not edit the images in `docs/screenshots/` by hand. Run the script again after a change to the console, and commit the new files with that change.

## Project homepage

The public homepage is a standalone static site in `site/`. It is separate from the console in `web/`, and it does not connect to a MiniBox server.

```bash
bun run build:site      # writes dist/site
bun run preview:site    # builds the site, then serves it at http://127.0.0.1:4173/minibox/
```

`SITE_PORT` changes the preview port. The build copies the three site source files, `LICENSE` and `NOTICE` from the repository root, the logo and favicon from `web/assets/`, the agent logos from `site/assets/agents/`, and the three light console screenshots for each language from `docs/screenshots/en/` and `docs/screenshots/zh-CN/`. It also writes `.nojekyll`, `robots.txt` and `sitemap.xml`.

To run the browser tests, install Chromium once, then run them:

```bash
bunx playwright install chromium
bun run test:site
```

To use an installed Chromium instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, for example `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium bun run test:site`. Playwright starts and stops its own preview server.

The console browser tests in `tests/` find Chromium the same way; see [Tests](#tests).

### Deployment

The homepage is published at <https://arnochenfx.github.io/minibox/>. The `Project homepage` workflow deploys only from `main`. Deploys share one queue, and a deploy in progress is never cancelled. Pull requests run the tests but never deploy.

To publish a change, merge it to `main`. To publish again without a change, run the workflow on `main` from the Actions tab.

The repository's **Settings → Pages → Build and deployment** must use **Source: GitHub Actions**. The deploy job runs in the `github-pages` environment. After a deploy, open the public URL and check that the logo, stylesheet, script and screenshots load under `/minibox/`. A successful build alone does not show that the public site was updated.

## Repository layout

```text
minibox/
├── src/                 Server, written in TypeScript for Bun
│   ├── server.ts        Entry point: HTTP routes, WebSockets and the SSH gateway
│   ├── app.ts           The shared application state: stores, one runtime per host, the executor, the jobs
│   ├── config.ts        Configuration from the environment, .env and DATA_DIR
│   ├── auth.ts          Who the caller is: the access key, an agent token, or a browser session
│   ├── guard.ts         Cross-site and cross-origin checks, before every request
│   ├── static.ts        The console's files, from web/
│   ├── operations/      Operation registry, executor, and the REST, MCP and OpenAPI views
│   ├── routes/          REST routes for each group of operations
│   ├── mcp/             The MCP endpoint
│   ├── services/        Boxes, templates, checkpoints, volumes, terminals and more
│   ├── runtime/         The runtime interface that services call
│   ├── docker/          The Docker Engine implementation of the runtime
│   ├── host/            Host registry, and endpoints for unix, tcp and ssh
│   ├── agent/           The host agent on a remote engine's side, and its executor
│   ├── preview/         Port previews: the proxy, the relay and what it remembers per container
│   ├── egress/          The outbound network policy a box gets
│   ├── backup/          Online backups, and their retention
│   ├── targets/         Off-site targets for backups
│   ├── notify/          Notification channels and rules
│   ├── questions/       Questions a run asks its operator
│   ├── checkpoints/     restic checkpoints and their schedules
│   ├── volumes/         Volume roles, storage pools and limits
│   ├── specs/           The stored box spec, its history, drift and claims
│   ├── startup/         A box's startup command
│   ├── logs/            The log stream of one box, over the shared SSE body
│   ├── tmux/            Pure helpers for driving tmux (names, targets, formats)
│   ├── secrets/         Secret values, kept as files in DATA_DIR
│   ├── tools/           The tool catalog: built-in entries and custom ones
│   ├── tokens/          Access keys, agent tokens, and what each one may do
│   ├── cli/             The `minibox` CLI, a REST client
│   ├── cli-dist/        Building and serving the CLI binaries under /cli/
│   ├── ssh/             The SSH gateway
│   ├── ws/              The terminal, SSH and agent WebSockets
│   ├── events/          The audit log and activity log (SQLite), the shared SSE body, and saved command output
│   ├── tasks/           Background tasks (SQLite) and their progress stream
│   └── lib/             Shared helpers
├── web/                 The console: HTML, CSS, ES modules and vendored xterm.js
├── site/                The standalone project homepage
├── templates/base/      The Dockerfile of the base template
├── templates/official/  The Dockerfiles of the official templates: node, python, go and minimal
├── catalog/             The built-in tool catalog, one JSON file per tool
├── scripts/             Build, check and test scripts
├── tests/               Unit and real-engine tests, with fixtures and test support code
├── docs/                The documentation
├── .github/workflows/   CI, integration, homepage and release workflows
├── Dockerfile           The release image
├── LICENSE              The Apache License 2.0
├── NOTICE               Copyright and licenses of the vendored third-party components
├── .env.example         An example configuration, with the defaults in comments
└── CHANGELOG.md         Release notes
```

## Adding an engine backend

Business code reaches an engine only through the `Runtime` interface in `src/runtime/index.ts`. To add a backend:

1. Put the adapter in its own directory, `src/<backend>/`, and import its SDK only there. Convert SDK errors to `RuntimeError` inside the adapter. `src/docker/errors.ts` shows the mapping.
2. Map connection failures to the `unavailable` kind, so that clients get `503` rather than `502`.
3. Create the host's `HostCtx` in the composition root, `src/app.ts`, and add it with `hosts.add()`. Remote Docker hosts are added at run time by `HostManager` in `src/host/manager.ts`, not in `src/app.ts`. A new connection type also extends `parseEndpoint()` in `src/host/endpoint.ts` and `openLink()` in `src/host/link.ts`.
4. Update the import rules in `tests/architecture.test.ts`. They currently allow only `src/docker/` to import `dockerode`.
5. Add real-engine tests in the style of `tests/docker-runtime.test.ts`, and list the new file in `scripts/docker-integration.ts`.

## Contributing

Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) style, such as `fix(hosts): keep SSH tunnel connections half open`.

Add user-visible changes to the `[Unreleased]` section of `CHANGELOG.md`. The file follows [Keep a Changelog](https://keepachangelog.com/).

When you change an English page in `docs/`, update the matching page in `docs/zh-CN/` too. Use the same terms in both languages. In Chinese, use 工具 for tools, 检查点 for checkpoints, 模板 for templates, 密钥 for secrets and 宿主机 for hosts, as the console does.

## Releases

Only maintainers publish releases. A normal change does not include these steps.

1. Set `version` in `package.json`. Add a `## [x.y.z]` section to `CHANGELOG.md` with the release notes.
2. Merge the change to `main`.
3. Create and push the tag:

   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

The release workflow fails when the tag and `package.json` disagree. A tag with a suffix, such as `v1.0.0-rc.1`, is published as a prerelease and does not move the `latest` image tag.

The running version comes from `MINIBOX_VERSION`, which the release image sets from its tag. A source checkout uses `git describe --tags`, and otherwise `package.json`.

The SSH/credential integration fixtures require `openssl` in addition to Docker.

Run `bun run check:unused` to check unused files, exports and types. `knip.json` lists the server, CLI, agent, backup worker, subprocess fixtures, scripts, HTML and site test entry points. Paired browser `.d.ts` files are checked by the typechecker instead of treated as runtime entry points. Exports used inside their own module are allowed: browser rendering tests also call some of these helpers from subprocesses, which a static import graph cannot see.

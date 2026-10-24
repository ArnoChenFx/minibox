# Templates

A template is the starting point for a new box. It holds the box's environment: the operating system, the installed programs and the settings in `/etc`. Each new box starts from a template.

A template does not include your files. The `/workspace` folder and the home folder are volumes, and a template leaves them out. Checkpoints handle data, and templates handle environment. Keep your code in git, or take a checkpoint of the box.

## The base template

MiniBox ships a bundled base template that you build on the **Templates** tab of **Library**.

The base template contains:

- Debian 12 and Node.js 26.
- Python 3, `git`, `curl`, `build-essential`, `tmux`, `jq`, `ripgrep`, `bubblewrap`, `openssh-client`, `sudo` and other common tools.
- The user `dev`, user ID 1000, with passwordless `sudo`.

The MiniBox image does not include the base template. MiniBox builds it the first time a host needs it, for a box or for the helpers that install tools and prepare volumes. To build it ahead, use the console:

1. Click **Library** in the sidebar. Its **Templates** tab opens.
2. Click **Build base template**.
3. Wait for the build to finish.

To follow the build, click **Tasks** in the top bar. Build the base template again whenever you want to update it.

## Official templates

MiniBox ships four official templates. Each comes from a Dockerfile in the MiniBox source, and each has the common tools of the base template:

| Template | Base image | Adds |
|---|---|---|
| `node` | `node:26-bookworm-slim` | Node.js 26, pnpm and yarn, with `build-essential` |
| `python` | `python:3.14-slim-bookworm` | Python 3.14 and uv, with `build-essential` |
| `go` | `golang:1.26-bookworm` | Go 1.26 and gopls, with `build-essential` |
| `minimal` | `debian:bookworm-slim` | No language toolchain |

The common tools are `git`, `curl`, `tmux`, `jq`, `ripgrep`, `bubblewrap`, `openssh-client`, `sudo` and `vim`. Each template has the user `dev`, user ID 1000.

`bubblewrap` (the `bwrap` command) is there because the OpenAI Codex CLI needs it for its Linux sandbox. Boxes made before it was added do not have it: rebuild the template and create the box again, or run `sudo apt-get install -y bubblewrap` in the box. Inside a Docker container, `bwrap` may also need looser user-namespace or seccomp settings before it can run. This is not verified.

Official templates are not built when MiniBox starts. A template is built on a host the first time a box needs it there:

- **Creating a box.** If no host holds the template, MiniBox builds it on the host the box goes to, and the create waits for the build. The build log opens in the **Tasks** panel. With automatic placement, the box goes to the roomiest online host that can build the template, when no host that already holds it has room. A failed build leaves no template and no box.
- **Building ahead of time.** On the **Templates** tab of **Library**, click **Build** on the card of a template that is not built yet, or **Build here** next to a host when the console has several hosts. On the command line, run `minibox template build-official go`, with `--host` to choose a host.

In the **Create box** dialog, the official templates that are not built yet come after the built ones, marked **Builds on first use**.

A box rebuild does not build a missing official template, so build it first. Rebuilding a built official template runs its Dockerfile again on the base image that the host already holds. To take a newer patch release of that base image, pull it first with **Pull image**, for example `node:26-bookworm-slim`, and then rebuild the template. A MiniBox update can change an official Dockerfile, and the change reaches a host when that template is rebuilt.

Only the owner can build an official template or list the catalog. A token can create a box from an official template after the owner has built it on that host.

## Save a box as a template

Save a box as a template when you have installed software into the box, and you want new boxes to start with it.

1. Open the box.
2. Click **Save as template**.
3. Enter a **Name**, such as `python-ml`. Add a **Description** if you like.
4. Click **Save template**.

MiniBox saves the container's system layer: files changed outside the volumes, such as software installed as root and settings under `/etc`. It does not include `/workspace`, the home folder, or tools installed only into home.

Saving can take a while. Follow the progress in the **Tasks** panel.

A box whose environment references a host secret cannot be saved as a template, and the same rule applies to a snapshot or checkpoint that includes a system image. Remove that environment variable first. See [Environment variables and secrets](environment-and-secrets.md).

## Build a template from a source

You can also build a template from a Dockerfile, a Git repository, a build context archive or a repository's `devcontainer.json`. A template built this way can be rebuilt from the same source.

1. Click **Library** in the sidebar, then click **New template**.
2. In **Template name**, type a name, such as `node-tools`. It follows the same rules as a box name: letters, digits, dots, underscores and hyphens, starting with a letter or digit, and at most 63 characters. Add a **Description** if you like.
3. In **Source**, choose where the files come from, and fill in its fields:

   | Source | Fields |
   |---|---|
   | **Dockerfile** | The Dockerfile, pasted in. It needs a `FROM` instruction. |
   | **Git repository** | **Repository URL**, then optional **Branch**, **Subdirectory**, **Dockerfile path** and **Secret for a private repository**. |
   | **Build context URL** | An `http://` or `https://` link to a `.tar` or `.tar.gz` archive, and an optional **Dockerfile path**. |
   | **devcontainer.json** | **Repository URL**, then optional **Branch**, **devcontainer.json path** and **Secret for a private repository**. See [devcontainer.json](#devcontainerjson). |

4. Click **Build template**.

The build runs in the background. Follow its log in the **Tasks** panel, where the task is listed as **Build template**. When the build succeeds, the template appears in the list. A build that fails leaves no template, and the task shows why. The name stays free, so you can try again.

These details apply to each source:

- **Branch** can name a branch or a tag. Leave it empty for the repository's default branch. The clone is shallow, so the build sees only the latest commit.
- **Subdirectory** is the build context inside the repository. Leave it empty for the repository root. **Dockerfile path** is relative to the build context, and defaults to `Dockerfile`.
- A build context archive is unpacked at its top level. If the archive puts everything in one folder, such as `repo-main/`, enter that folder in the Dockerfile path, as in `repo-main/Dockerfile`.
- To build on the base template, start the Dockerfile with `FROM minibox-template:base`. The name follows `LABEL_PREFIX` and `BASE_TEMPLATE` if you change them. An image in `FROM` that the engine does not have is pulled during the build.
- A repository's `.git` folder is never part of the image.

On the command line, the same builds are:

```bash
minibox template create node-tools --repo https://github.com/example/app.git --branch main --subdir services/api --secret DEPLOY_TOKEN
minibox template create node-tools --dockerfile ./Dockerfile
```

## Rebuild a template

A template built from a source has a **Rebuild** button on its card in the **Templates** list. A rebuild runs the build again from the same source, so a branch gives its newest commit, and an archive URL is downloaded again. The template keeps its name.

The new image replaces the old one only when the build succeeds. If the rebuild fails, the template keeps the image it had.

A box keeps the image it runs until you rebuild the box. See [Rebuild a box](boxes.md#rebuild-a-box).

## Pull an image

Pulling downloads an image to the host ahead of time, so that templates and boxes start without waiting.

1. Click **Pull image** on the **Templates** tab.
2. In **Image**, type a name, with an optional tag, such as `node:24-bookworm-slim`.
3. Click **Pull image**.

The pull runs as a task, and its log shows each layer. An image that the host already has is left as it is.

A box or a rebuild that starts from a registry image the host does not have pulls it during its request, so the request waits for the download. Pull the image first to avoid the wait. On the command line, `minibox box create my-box --template node:24-bookworm-slim` pulls the image if it is missing, and then creates the box. A token can start a box only from a MiniBox template, so only the owner can use a registry image this way.

MiniBox never pulls its own template, snapshot and checkpoint images. They exist only on the host that made them, so a missing one is an error.

## Create a box from a template

1. Click **Boxes**, then **Create box**.
2. In **Template**, choose the template.
3. Finish the form, and click **Create and start**.

You can also click **Create from this** on a template's card in the **Templates** list. To clone a repository into the box at the same time, see [Clone a repository](boxes.md#clone-a-repository). A template built from a `devcontainer.json` that sets `postCreateCommand` or `forwardPorts` sets up each box created from it. See [The setup of a box](#the-setup-of-a-box).

## Copy a template to another host

A box on another host needs the template's image on that host. MiniBox copies the image when you create the box there, so you rarely need to copy a template by hand. To copy one ahead of time, click **Copy here** next to a host that lacks it, on the template's card. The copy runs as a **Sync template** task. Each card lists every host, and whether it has the template. A copy also carries the recipe of a template built from a source. The copy keeps that template's setup, and it can be rebuilt on that host from the same source.

Deleting a template in the console removes its copy on every host. A rebuild changes the copy on the first host that holds the template. The other copies keep their old image until you delete them and copy the template again. A copy needs a target engine that keeps image IDs. See [Limits](hosts.md#limits).

## Built-in and custom templates

The **Templates** tab shows these labels:

- **Built-in** marks the bundled base template.
- **Official** marks one of the four official templates. An official template that no host has built yet shows **Not built on any host yet** and a **Build** button.
- **Custom** templates are the ones that you saved from a box.
- **Built from** names the source of a template that you built from a Dockerfile, a repository, a build context or a `devcontainer.json`.

Deleting a template does not affect the boxes that you created from it. A template that you built in the console can be built again on the same tab.

## Who can build, and what a build can reach

Building a template, rebuilding one and pulling an image are for the owner only. No token can do them, even a token with every scope.

- **Secrets.** A private repository's token or deploy key is used only for its clone. MiniBox removes its value from the clone output before the task log shows it. The value is never written into the image, and the recipe keeps only the secret's name. Do not paste a secret into a Dockerfile, `containerEnv`, `remoteEnv` or `build.args`: those values go into the image or the build log.
- **Recipes.** The pasted Dockerfile and the source fields are kept on each host that holds the template, in `DATA_DIR/template-recipes/`, so that a rebuild can run them again. A copy to another host carries them too.
- **Build contexts.** MiniBox refuses an archive entry or repository file whose path leaves the build context, is absolute, or is a hard link, a device or another special file. It also refuses a symbolic link that points outside the context, or a write that would pass through one.
- **URLs come from the server.** MiniBox downloads a build context URL itself, and clones a repository from a helper container on the Docker network. Both follow redirects to any address. MiniBox does not block private or loopback addresses, or cloud metadata addresses, so a build can reach any service that the host can reach. Give owner access only to people who should have that reach.
- **SSH host keys.** An SSH clone accepts the server's host key the first time it connects, because each clone starts with an empty known-hosts file. An attacker on the network could answer that first connection. HTTPS with a token checks the server's certificate instead.
- **Clone helper.** A clone runs in a helper container with all Linux capabilities dropped and a read-only root file system. It has 512 MB of memory, and it stops after five minutes.
- **Other hosts.** The console builds templates and pulls images on the local host. To build or pull on another host, use `--host` on the command line, or `?host=` in the API. An agent host does not support templates yet.

## devcontainer.json

Build a template from a repository's `devcontainer.json` when the repository already describes its environment in that file. MiniBox looks for `.devcontainer/devcontainer.json`, then `.devcontainer.json`, unless you give a path. If the repository has both, `.devcontainer/devcontainer.json` is used. To build from `.devcontainer.json` instead, give its path.

MiniBox reads these settings:

| Setting | How MiniBox uses it |
|---|---|
| `image` | The base image. MiniBox writes `FROM <image>` into a Dockerfile of its own. |
| `build.dockerfile` | The Dockerfile, relative to `devcontainer.json`. It must sit inside the build context. |
| `build.context` | The build context, relative to `devcontainer.json`. Defaults to its folder. It must stay inside the repository. |
| `build.args` | Build arguments. |
| `build.target` | The stage of the Dockerfile to build. |
| `containerEnv` | One `ENV` instruction per entry, written into the image. |
| `remoteEnv` | `ENV` instructions too, written into the image, so every process in the box sees them. An entry with the same name as one in `containerEnv` replaces it. |
| `postCreateCommand` | Runs once in the box, when a box is created from the template. See [The setup of a box](#the-setup-of-a-box). |
| `forwardPorts` | TCP ports that become manual preview ports of the box, when a box is created from the template. |
| `remoteUser` | Accepted when it is `dev` or `1000`, the user every box runs as. |
| `$schema`, `name` | Metadata only. They change nothing. |

The file sets either `image` or `build`, never both, and a `build` needs `build.dockerfile`. When `build.target` is set and there are `ENV` lines to add, MiniBox builds the target stage and adds a last stage on top of it that holds the `ENV` lines. Without `ENV` lines, the target stage is the image. A target that the Dockerfile does not declare is refused. The `devcontainer.json` file is limited to 256 KB. When there are `ENV` lines to add, MiniBox copies the Dockerfile to add them, and that copy is limited to 256 KB too. The repository's own file is not changed.

### The setup of a box

`postCreateCommand` and `forwardPorts` are not part of the image. The template keeps them on every host that holds a copy of it, and a box created from the template runs them in its setup task, in this order:

1. The repository is cloned, when you gave one.
2. Each port in `forwardPorts` becomes a manual preview port of the box.
3. `postCreateCommand` runs.

- A string runs as `/bin/sh -c "<command>"`, so shell syntax such as `npm ci && npm run build` works. A list runs as written, without a shell, and `$HOME` stays literal in it.
- The command runs as `dev`, in `/workspace` when the box mounts it, and in `/` otherwise. Its output is in the task log, under **Set up box** in the **Tasks** panel.
- A command that exits with a non-zero code fails the setup task, and the task names the code. The box is kept, so you can open it and fix the problem.
- A command still running after 30 minutes is stopped, and the task fails. Cancelling the task also stops it. In both cases the box is kept.
- The setup runs once, when the box is created. Starting, stopping, restarting and rebuilding the box do not run it again. A box saved from the template does not inherit it.
- A token needs the `exec` scope to create a box from a template whose `postCreateCommand` is set, and the `port:expose` scope for `forwardPorts`. A token without the scope is refused before the box is made.

### Settings MiniBox does not apply

A setting that MiniBox does not apply does not stop the build. The build log shows a `Warning:` line that names it, and the build goes on without it. This covers every top-level setting that the table does not list, such as `features`, `mounts`, `runArgs` and `customizations`. It also covers the lifecycle commands `initializeCommand`, `onCreateCommand`, `updateContentCommand`, `postStartCommand` and `postAttachCommand`, which MiniBox never runs.

These settings are also listed as warnings:

- A `remoteUser` other than `dev` or `1000`, because every box runs commands as `dev`.
- A `remoteEnv` entry set to `null`, which would unset a variable. MiniBox cannot unset a variable.
- A `build` setting other than `dockerfile`, `context`, `args` and `target`, such as `cacheFrom`.
- A `postCreateCommand` in object form, which runs several commands in parallel. MiniBox does not run it.
- A `forwardPorts` entry that is not a TCP port in the box, such as `db:5432`.
- A `containerEnv`, `remoteEnv` or `build.args` value that names a devcontainer variable, such as `${containerEnv:PATH}`, and a `postCreateCommand` that names one, such as `${localEnv:HOME}` or `${containerWorkspaceFolder}`. MiniBox does not expand variables, so the entry is left out, or the command is not run, and the build goes on.

A setting that MiniBox applies but cannot apply as written is refused, and the build does not start:

- A name that is not a valid variable name, or a value with a control character in it, such as a line break or a tab.
- A `containerEnv`, `remoteEnv` or `build.args` value with any other `${…}` reference in it, such as `${dockerfile:VARIABLE}`. MiniBox does not expand variables, so the value would differ from the file.
- A `postCreateCommand` that is longer than 64 KB, or a `forwardPorts` that is not a list.
- A `build.target` that the Dockerfile does not declare with `FROM … AS <name>`.

MiniBox runs one command from the repository, `postCreateCommand`, and only when it creates a box. The other lifecycle commands belong to stages of a dev container's life that MiniBox does not have. Put install steps in the Dockerfile as `RUN` instructions instead: the build runs them once, and every box made from the template has the result.

`containerEnv` and `remoteEnv` are not places for secrets, because their values are written into the image and shown in the build log. To give a box a secret, use an environment variable with a secret reference. See [Environment variables and secrets](environment-and-secrets.md).

## Limits

| What | Limit |
|---|---|
| Template name | 63 characters |
| Description | 200 characters, on one line |
| Pasted Dockerfile | 64 KB |
| `devcontainer.json`, or a Dockerfile that MiniBox copies to add `ENV` lines | 256 KB each |
| `postCreateCommand` | 64 KB, and 30 minutes to run |
| Build context archive | 256 MB downloaded and 256 MB unpacked, and 20,000 entries |
| Download of a build context | 2 minutes |
| Clone | 5 minutes, and 512 MB of memory for the helper |
| URL | 2,048 characters |
| Branch | 200 characters |
| Path in a repository or archive | 512 characters |
| Image name | 255 characters |

## Reference

The [API reference](../reference/api.md), the [MCP tools reference](../reference/mcp.md) and the [CLI reference](../reference/cli.md) describe the same operations.

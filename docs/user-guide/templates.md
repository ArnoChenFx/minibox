# Templates

A template is the starting point for a new box. It holds the box's environment: the operating system, the installed programs and the settings in `/etc`. Each new box starts from a template.

A template does not include your files. The `/workspace` folder and the home folder are volumes, and a template leaves them out. Checkpoints handle data, and templates handle environment. Keep your code in git, or take a checkpoint of the box.

## The base template

MiniBox ships a bundled base template that you build on the **Templates** page.

The base template contains:

- Debian 12 and Node.js 26.
- Python 3, `git`, `curl`, `build-essential`, `tmux`, `jq`, `ripgrep`, `openssh-client`, `sudo` and other common tools.
- The user `dev`, user ID 1000, with passwordless `sudo`.

The MiniBox image does not include the base template. Build it once from the console:

1. Click **Templates** in the sidebar.
2. Click **Build base template**.
3. Wait for the build to finish.

To follow the build, click **Tasks** in the top bar. Build the base template again whenever you want to update it.

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

1. Click **Templates** in the sidebar, then click **New template**.
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

1. Click **Pull image** on the **Templates** page.
2. In **Image**, type a name, with an optional tag, such as `node:24-bookworm-slim`.
3. Click **Pull image**.

The pull runs as a task, and its log shows each layer. An image that the host already has is left as it is.

A box or a rebuild that starts from a registry image the host does not have pulls it during its request, so the request waits for the download. Pull the image first to avoid the wait. On the command line, `minibox box create my-box --template node:24-bookworm-slim` pulls the image if it is missing, and then creates the box. A token can start a box only from a MiniBox template, so only the owner can use a registry image this way.

MiniBox never pulls its own template, snapshot and checkpoint images. They exist only on the host that made them, so a missing one is an error.

## Create a box from a template

1. Click **Boxes**, then **Create box**.
2. In **Template**, choose the template.
3. Finish the form, and click **Create and start**.

You can also click **Create from this** on a template's card in the **Templates** list. To clone a repository into the box at the same time, see [Clone a repository](boxes.md#clone-a-repository).

## Copy a template to another host

A box on another host needs the template's image on that host. MiniBox copies the image when you create the box there, so you rarely need to copy a template by hand. To copy one ahead of time, click **Copy here** next to a host that lacks it, on the template's card. The copy runs as a **Sync template** task. Each card lists every host, and whether it has the template.

Deleting a template in the console removes its copy on every host. A rebuild changes the copy on the first host that holds the template. The other copies keep their old image until you delete them and copy the template again. A copy needs a target engine that keeps image IDs. See [Limits](hosts.md#limits).

## Built-in and custom templates

The **Templates** page shows these labels:

- **Built-in** marks the bundled base template.
- **Custom** templates are the ones that you saved from a box.
- **Built from** names the source of a template that you built from a Dockerfile, a repository, a build context or a `devcontainer.json`.

Deleting a template does not affect the boxes that you created from it. A template that you built in the console can be built again on the same page.

## Who can build, and what a build can reach

Building a template, rebuilding one and pulling an image are for the owner only. No token can do them, even a token with every scope.

- **Secrets.** A private repository's token or deploy key is used only for its clone. MiniBox removes its value from the clone output before the task log shows it. The value is never written into the image, and the recipe keeps only the secret's name. Do not paste a secret into a Dockerfile, `containerEnv` or `build.args`: those values go into the image or the build log.
- **Recipes.** The pasted Dockerfile and the source fields are kept on the host in `DATA_DIR/template-recipes/`, so that a rebuild can run them again.
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
| `containerEnv` | One `ENV` instruction per entry, written into the image. |
| `$schema`, `name` | Metadata only. They change nothing. |

The file sets either `image` or `build`, never both, and a `build` needs `build.dockerfile`. A value cannot use a `${…}` reference, because MiniBox does not expand variables. The `devcontainer.json` file is limited to 256 KB. When `containerEnv` is set, MiniBox copies the Dockerfile to add the `ENV` lines, and that copy is limited to 256 KB too. The repository's own file is not changed.

Not supported:

- Any other top-level setting, such as `features`, `forwardPorts`, `mounts`, `remoteUser` or `customizations`. The build is refused, and the error names each setting.
- Lifecycle commands: `initializeCommand`, `onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand` and `postAttachCommand`. MiniBox never runs them, and the build is refused when the file sets one.
- Build settings other than `dockerfile`, `context` and `args`, such as `target` and `cacheFrom`.

The reason for these limits: MiniBox builds an image and runs nothing from the repository. A lifecycle command runs inside a box after it starts, and a template does not start a box. Put install steps in the Dockerfile as `RUN` instructions instead. MiniBox refuses an unsupported setting rather than skipping it, so a template is never built without something the file asked for.

`containerEnv` is not a place for secrets, because its values are written into the image and shown in the build log. To give a box a secret, use an environment variable with a secret reference. See [Environment variables and secrets](environment-and-secrets.md).

## Limits

| What | Limit |
|---|---|
| Template name | 63 characters |
| Description | 200 characters, on one line |
| Pasted Dockerfile | 64 KB |
| `devcontainer.json`, or a Dockerfile that MiniBox copies for `containerEnv` | 256 KB each |
| Build context archive | 256 MB downloaded and 256 MB unpacked, and 20,000 entries |
| Download of a build context | 2 minutes |
| Clone | 5 minutes, and 512 MB of memory for the helper |
| URL | 2,048 characters |
| Branch | 200 characters |
| Path in a repository or archive | 512 characters |
| Image name | 255 characters |

## Reference

The [API reference](../reference/api.md), the [MCP tools reference](../reference/mcp.md) and the [CLI reference](../reference/cli.md) describe the same operations.

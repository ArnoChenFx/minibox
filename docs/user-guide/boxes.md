# Boxes

A box is an isolated Docker container with its own files and processes. Your work lives in its `/workspace` folder, which is kept in a volume. The box keeps that folder when you stop, restart or rebuild it.

Every box runs as the user `dev`, user ID 1000. Inside a box, `sudo` works without a password. Root in a box can change anything in that box. For a stricter box, choose the `strict` security profile when you create it. See [Security](../admin/security.md).

## Create a box

1. Click **Boxes** in the sidebar, then click **Create box**.
2. In **Name**, type a name. It must start with a letter or digit, use only letters, digits, dots, underscores and hyphens, and be at most 63 characters. In the console, you cannot change the name after the box is created.
3. In **Template**, choose the template to start from. The default is **base**. See [Templates](templates.md).
4. In **Size**, choose a preset:

   | Preset | CPU | Memory |
   |---|---|---|
   | **Small** | 2 cores | 4 GB |
   | **Medium** | 4 cores | 8 GB |
   | **Large** | 8 cores | 16 GB |
   | **Custom** | Set your own | Set your own |

   Use **Memory** to set an exact amount, in MB, between 128 and the limit shown.

5. To give the box's agent a token for this box alone, tick **Give the box's agent a self token**. It is off by default, and a box made from a snapshot does not offer it. See [A box's own agent](agents.md#a-boxs-own-agent).
6. If MiniBox has more than one host, choose the **Host** where the box runs. **Auto** picks the online host with the most room, and with `hostLabels` (the API and the CLI) it picks only among the hosts that carry them. See [Hosts](hosts.md) and [Choose a host by labels](hosts.md#choose-a-host-by-labels).
7. To change the security profile, open **Advanced** and choose a profile. The default is `standard`. The same section takes an optional **Network egress**, which limits what the box can reach outside the host, and an optional **Startup command**. See [Network egress](../admin/network-egress.md) and [Startup command](#startup-command).
8. To clone a Git repository into `/workspace`, open **Clone a repository into /workspace**. See [Clone a repository](#clone-a-repository).
9. To install agent CLIs or other tools with the box, tick them under **Tools**. See [Tools](tools.md).
10. Open **Volumes: defaults**, then choose **Defaults** to mount the workspace, home, cache and tools volumes, or **Customize** to pick the volumes yourself. In **Customize**, each row mounts a volume that already exists, or has MiniBox create one of the box's role volumes (workspace, home, tools or cache) for it, and a role you remove is not created. See [Volumes and storage](volumes-and-storage.md#volume-roles).
11. To set environment variables, open **Environment variables**. See [Environment variables and secrets](environment-and-secrets.md).
12. Click **Create and start**.

The box is listed with its status. Open it to see its details. A box made from a template built from a `devcontainer.json` also runs that template's setup. See [devcontainer.json](templates.md#devcontainerjson).

## Clone a repository

A new box can start with a copy of a Git repository in `/workspace`. In the create dialog, open **Clone a repository into /workspace** and fill in its fields:

- **Repository URL** is an HTTPS or SSH address, such as `https://github.com/org/app.git` or `git@github.com:org/app.git`. Do not put a token or password in an HTTPS address.
- **Branch** names a branch or a tag. Leave it empty for the repository's default branch.
- **Secret for a private repository** names a secret that holds a token for HTTPS, or a base64 deploy key for SSH. Set the secret first. See [Environment variables and secrets](environment-and-secrets.md).

The same fields are the `repo` object in the API, the `--repo`, `--branch` and `--secret` options of `minibox box create`, and the `repo` argument of the `create_box` MCP tool. See the [API](../reference/api.md), [CLI](../reference/cli.md) and [MCP](../reference/mcp.md) references.

The clone runs once, when the box is created:

- It is shallow. The workspace gets the latest commit of the branch, without the history.
- The box is created first, then its setup runs as its own task, **Set up box**. The setup clones the repository, then forwards the ports and runs the `postCreateCommand` that the template sets, if it sets them. Follow it in the **Tasks** panel. If the clone fails, the box stays, and the task shows why.
- Starting, stopping, restarting and rebuilding a box never clone again, and never run the setup again. See [The setup of a box](templates.md#the-setup-of-a-box).
- `/workspace` must be writable. The default volumes give a new box an empty workspace, and so does the workspace row of **Customize**. If you mount a volume that already has files at `/workspace`, the clone fails.

The secret's value is read for the clone only. It is never written into the box or its image, and the task log shows the clone output with the value replaced. A secret that is not set stops the create before anything is created. For what a clone can reach and how SSH host keys are checked, see [Security](../admin/security.md#template-builds-and-repository-clones).

## Open a box

Click a box in the list to open it. The box page has these tabs:

| Tab | What it shows |
|---|---|
| **Overview** | The CPU, memory and uptime of the box, its details, and the **Agent** card when an agent is waiting for an answer |
| **Terminal** | Every tmux session in the box, each marked **Created by you** or **Created by agent**. See [Terminals and sessions](terminal-and-sessions.md). |
| **Files** | Browse, upload and download the files in the box's volumes, even while the box is stopped. See [Files](files.md). |
| **Ports** | Listening ports, and ports you add for preview. See [Port preview](port-preview.md). |
| **Activity** | Recent commands, container events and terminal sessions. Below them, **Container output (docker logs)** shows the box's log, with **Auto-refresh**. |
| **Settings** | The box's settings, in seven sections: **Resources**, **Storage and mounts**, **Tools**, **Environment variables**, **Lifecycle**, **Security** and **Checkpoints** |

The **Resources** section shows the CPU and memory limits, the current use, and the **Adjust quota** button. The **Lifecycle** section holds the startup command, and the idle timeout and the TTL, which **Edit** changes in place. The **Security** section holds the template, the network egress and the security profile. The **Checkpoints** section lists the box's copies of its data. See [Checkpoints](checkpoints.md).

Changes that only a rebuild can apply are **staged**: the card keeps them, marks them **Pending**, and a banner above the section counts them. Nothing on the box changes until you click **Apply and rebuild** in that banner, and the banner offers **View diff** and **Discard** too. A staged change survives a MiniBox restart, and one box has one set of staged changes. These settings are staged: the template, the network egress, the security profile, the environment variables and the mounts. See [Stage a change and rebuild](boxes.md#stage-a-change-and-rebuild).

The **Create checkpoint** button in the title bar takes a checkpoint from any tab, and the title bar also has the **Rebuild** button.

## Overview and the box list

The **Overview** page is the first screen. It has two lists:

- **In progress** shows the boxes an agent is working on. See [Watch an agent on the overview](terminal-and-sessions.md#watch-an-agent-on-the-overview).
- **Needs attention** shows the problems MiniBox has recorded: a box that ran out of memory, a failed checkpoint, a box whose live settings differ from its spec, a rollback waiting for you to confirm or undo it, a volume over its hard limit, a storage pool that did not answer, an offline host, a host whose disk is below its free-space minimum, and a host whose boxes reserve more CPU or memory than its capacity times `HOST_OVERCOMMIT` allows. Out-of-memory kills and failed checkpoints stay listed for a day. The other items stay listed while their condition lasts. **View** opens the box tab, the volumes or the host settings where the problem shows.

**Recent activity** at the foot of the overview shows the last six operations MiniBox recorded, without routine reads and without the start of an operation that has its own finish. **View all** opens the **Activity** page.

## The Activity page

The **Activity** page in the sidebar is the full log of every recorded operation, newest first, 25 to a page. Each row shows when it happened, the operation, its target, who acted and through what (the owner, an access token or a box agent; REST, CLI or MCP), and the result. Click an operation to see the fields MiniBox recorded for it. **Previous** and **Next** move through older pages. The first page follows new operations as they happen.

Filters above the log narrow it to one box, one kind of operation (boxes, commands, checkpoints, sessions, egress and so on), one result (done, failed, denied, started) or one actor. Successful reads, such as listing boxes, are left out unless you tick **Include successful reads**. A failed or denied read is always listed. The same filters are on `GET /api/events` as `box`, `op` (for example `op=exec.*`), `status`, `principal` and `reads=failed`. See the [API reference](../reference/api.md).

The **Boxes** list shows **Agent active · 12 seconds ago** beside a box while an agent is working in it. An agent is working in a box when it acted there in the last 10 minutes, or a command it started still runs. The time is when the agent last acted there.

## Start, stop and restart

Use the **Start**, **Stop** and **Restart** buttons. You find them in the box list and at the top of the box page.

- **Stop** keeps the box's files and volumes. Its processes end.
- **Start** runs the box again with the same files.
- **Restart** stops and starts the box.

A box can also stop by itself. A box that is idle can sleep, and a box can have a TTL that stops it when it expires. See [Idle sleep and TTL](idle-sleep.md).

## Startup command

A startup command is a shell command that runs each time the box's container starts. Use it for something that should come back with the box, such as a dev server.

The command runs when the box is created, started or woken from sleep, restarted, rebuilt, or restored from a checkpoint. It also runs when Docker starts the box's container without MiniBox, such as with `docker start` on the host, or through a restart policy set on the container. Each start of the container runs it once, and restarting MiniBox does not run a command that is already running. MiniBox resets the restart policy to `no` when it reconciles the box. A box created from a template, a snapshot or a checkpoint does not get the source box's command. Set one on the new box if you want it. A template does not carry a startup command.

To set the command, open the **Startup command** card in the **Settings** tab, under **Lifecycle**, click **Set command** or **Edit**, and then **Save**. You can also enter it in the create dialog, under **Advanced**. You can change or remove it at any time, including while the box is stopped or asleep, and no rebuild is needed. A change takes effect at the next start. On a running box, tick **Run it now as well** before you save to run the new command at once. **Run again** runs the saved command without changing it.

The command runs:

- As the user `dev`, in `/workspace`, with `bash -lc` and the box's environment variables. It is stored exactly as you typed it.
- In a tmux session named `minibox-init`. To watch it, open the box's terminal, or connect over SSH, and run `tmux attach -t minibox-init`. Detach with `Ctrl+B`, then `D`.
- Without holding up creation or starts. Creating a box returns at once. A start or restart waits at most five seconds for the command to launch, and a launch that takes longer finishes in the background. A command that fails does not stop the box from starting.

A box created with a repository or a template setup runs the command only after its setup has finished: the repository cloned, the ports forwarded and the template's `postCreateCommand` run. Until then the card reads **Waiting for the box setup**. If the clone or the `postCreateCommand` fails, or a server restart cuts the setup short, the card says why. The command then starts at the box's next start, or when you choose **Run again** on a running box.

The card shows the command's status:

| Status | Meaning |
|---|---|
| **Not set** | The box has no startup command. |
| **Waiting for the box setup** | The box was created with a repository or a template setup, and the command starts when that setup ends. |
| **Waiting for the next start** | A command is set, and it has not run since the box last started. |
| **Running** | The command is running now. |
| **Exited with code N** | The last run ended with exit code N. The card also shows when it ended, and the end of its output. |
| **Could not start** | MiniBox could not start the command, or the box's setup failed. The card shows why, and the reason still shows after a MiniBox restart, until the command starts. |

If the card says that the latest run used an earlier version of the command, run it again to use the current one.

**The command is not secret.** While it runs, its text is visible in `ps` to anyone who can run commands in the box. It is also stored as typed, so anyone with the `secret:use` scope can read it. Do not put a password or a token in it. Give the box a [variable or secret](environment-and-secrets.md) instead, and let the program read it from its environment.

A command can be up to 4096 bytes long. It may span several lines and contain tabs, but no other control characters.

Running the command again, with **Run again** or **Run it now as well**, first ends the earlier run, including the processes it started and those that `sudo` started for it. A process that `sudo` started and then detached, for example with `setsid`, can keep running, because `sudo` clears the variable that marks the run's processes. Restarting or stopping the box ends every process in it.

A startup command does not keep the box awake. Its `minibox-init` session counts as use only while someone is attached to it. Running the command again, with **Run again** or **Run it now as well**, restarts the idle timer, as an `exec` does. See [Idle sleep and TTL](idle-sleep.md).

Reading a startup command needs the `secret:use` scope on the access token. Setting, removing or running one also needs `exec`. The command and its output can hold secrets, so the activity log and the events record only that the command changed, never its text. See [Access and tokens](access-and-tokens.md).

From the command line:

```bash
minibox box create my-box --startup-command "python3 -m http.server 8000"
minibox box startup-command get my-box
minibox box startup-command set my-box --command "python3 -m http.server 9000" --apply
minibox box startup-command run my-box
minibox box startup-command rm my-box
```

The [REST API](../reference/api.md) and the MCP tools `get_startup_command`, `set_startup_command`, `delete_startup_command` and `run_startup_command` do the same.

## Change CPU and memory

1. Open the box, click **Settings**, and then **Resources**.
2. Click **Adjust quota**.
3. Set the CPU and memory limits, and click **Save**.

Lowering the memory below the current use can fail, or stop the box with the out-of-memory killer.

## Stage a change and rebuild

Rebuilding replaces the box's container with a new one. Six settings only take effect through a rebuild: the template, the mounts, the environment variables, the network, the network egress and the security profile. The box's **Settings** tab stages a change of any of them instead of rebuilding at once.

1. Open the box, click **Settings**, and open the section that holds the setting: **Storage and mounts**, **Environment variables** or **Security**.
2. Change the setting and click **Save**. The card marks the value **Pending**, and a banner above the section counts the staged changes and lists them by name.
3. Click **View diff** to read every change before you commit to it, or **Discard** to drop them all.
4. Click **Apply and rebuild**, then confirm. The box is rebuilt once, with every staged field together.

Nothing on the box changes until you apply: a staged change leaves the running container, its processes and its writable layer alone. A staged change is kept in the data directory, so it survives a MiniBox restart, and a box has one staged record. A field you stage back to the value the box already has drops out of that record, and the banner stops counting it. Applying refuses a box that changed since the preview, and the record is cleared only once the rebuild has succeeded.

The **Rebuild** button in the title bar is the direct route: it previews and rebuilds a box in one dialog, with no staging.

## Rebuild a box

Rebuilding replaces the box's container with a new one. Use it when you change the template, the environment variables, the mounts, the network, the network egress or the security profile.

1. Open the box, and click **Rebuild** in the title bar.
2. Read the preview. It lists what changes.
3. Click **Apply rebuild**.

A rebuild keeps:

- The mounted volumes, and their files.
- The box's name and its stable ID.
- The box's revision history.

A rebuild loses:

- The writable layer, which holds files you installed outside a volume, such as with `apt install`.
- Running processes, including `tmux` sessions.
- The container's IP address.

Before the rebuild changes anything, MiniBox takes a [safety checkpoint](checkpoints.md#safety-checkpoints) of the box's data. The preview's **Take a safety checkpoint first** option is ticked by default. If the rebuild fails, MiniBox puts the box back and discards the checkpoint, or keeps it when the box cannot be put back exactly.

If you want to keep software that you installed by hand, save the box as a template before you rebuild. See [Templates](templates.md).

## Delete a box

1. Open the box, and click **Delete box**.
2. To remove the volumes that only this box uses, tick **Also delete the volumes this box owns**.
3. Click **Delete box**.

Deleting a box keeps a copy of its workspace and home data in the [recycle bin](checkpoints.md#recycle-bin), whether or not you tick the volumes option. The copy is kept for `TRASH_RETENTION_DAYS` days, 7 by default. To bring the box back, restore the entry from the **Recycle bin** page, which creates a new box. To delete without keeping a copy, tick **Delete without keeping a copy**. Only the owner, or a token with the `trash:skip` scope, can do that.

Volumes that other boxes use, and volumes that you created on the **Volumes** tab of **Storage**, stay. Deleting a box never deletes a volume that another box still mounts.

## Use boxes from the command line

To list your boxes, run:

```bash
minibox box ls
```

To run a command in a box, use `minibox exec`:

```bash
minibox exec my-box -- npm test
```

Run `minibox exec --help` to see all options. See the [CLI reference](../reference/cli.md).

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
6. If MiniBox has more than one host, choose the **Host** where the box runs. See [Hosts](hosts.md).
7. To change the security profile, open **Advanced** and choose a profile. The default is `standard`. The same section takes an optional **Network egress**, which limits what the box can reach outside the host, and an optional **Startup command**. See [Network egress](../admin/network-egress.md) and [Startup command](#startup-command).
8. To clone a Git repository into `/workspace`, open **Clone a repository into /workspace**. See [Clone a repository](#clone-a-repository).
9. To install agent CLIs or other tools with the box, tick them under **Tools**. See [Tools](tools.md).
10. Open **Volumes: defaults**, then choose **Defaults** to mount the workspace, home, cache and tools volumes, or **Customize** to pick the volumes yourself. See [Volumes and storage](volumes-and-storage.md).
11. To set environment variables, open **Environment variables**. See [Environment variables and secrets](environment-and-secrets.md).
12. Click **Create and start**.

The box is listed with its status. Open it to see its details.

## Clone a repository

A new box can start with a copy of a Git repository in `/workspace`. In the create dialog, open **Clone a repository into /workspace** and fill in its fields:

- **Repository URL** is an HTTPS or SSH address, such as `https://github.com/org/app.git` or `git@github.com:org/app.git`. Do not put a token or password in an HTTPS address.
- **Branch** names a branch or a tag. Leave it empty for the repository's default branch.
- **Secret for a private repository** names a secret that holds a token for HTTPS, or a base64 deploy key for SSH. Set the secret first. See [Environment variables and secrets](environment-and-secrets.md).

The same fields are the `repo` object in the API, the `--repo`, `--branch` and `--secret` options of `minibox box create`, and the `repo` argument of the `create_box` MCP tool. See the [API](../reference/api.md), [CLI](../reference/cli.md) and [MCP](../reference/mcp.md) references.

The clone runs once, when the box is created:

- It is shallow. The workspace gets the latest commit of the branch, without the history.
- The box is created first, then the clone runs as its own task, **Clone repository**. Follow it in the **Tasks** panel. If the clone fails, the box stays, and the task shows why.
- Starting, stopping, restarting and rebuilding a box never clone again.
- `/workspace` must be writable. The default volumes give a new box an empty workspace. If you choose **Customize** and mount a volume that already has files at `/workspace`, the clone fails.

The secret's value is read for the clone only. It is never written into the box or its image, and the task log shows the clone output with the value replaced. A secret that is not set stops the create before anything is created. For what a clone can reach and how SSH host keys are checked, see [Security](../admin/security.md#template-builds-and-repository-clones).

## Open a box

Click a box in the list to open it. The box page has these tabs:

| Tab | What it shows |
|---|---|
| **Overview** | Details, environment variables, the startup command, mounts, the idle timeout and TTL, and the **Rebuild** button |
| **Terminal** | A shell in the box. See [Terminals and sessions](terminal-and-sessions.md). |
| **Activity** | Recent commands, container events and terminal sessions. Below them, **Container output (docker logs)** shows the box's log, with **Auto-refresh**. |
| **Resources** | The CPU and memory limits, the current use, and the **Adjust quota** button |
| **Checkpoints** | Copies of the box's data. See [Checkpoints](checkpoints.md). |
| **Ports** | Listening ports, and ports you add for preview. See [Port preview](port-preview.md). |
| **Tools** | Tools that you can install, upgrade or remove. See [Tools](tools.md). |
| **Files** | Browse, upload and download the files in the box's volumes, even while the box is stopped. See [Files](files.md). |

## Start, stop and restart

Use the **Start**, **Stop** and **Restart** buttons. You find them in the box list and at the top of the box page.

- **Stop** keeps the box's files and volumes. Its processes end.
- **Start** runs the box again with the same files.
- **Restart** stops and starts the box.

A box can also stop by itself. A box that is idle can sleep, and a box can have a TTL that stops it when it expires. See [Idle sleep and TTL](idle-sleep.md).

## Startup command

A startup command is a shell command that runs each time the box's container starts. Use it for something that should come back with the box, such as a dev server.

The command runs when the box is created, started or woken from sleep, restarted, rebuilt, or restored from a checkpoint. A box created from a template, a snapshot or a checkpoint does not get the source box's command. Set one on the new box if you want it. A template does not carry a startup command.

To set the command, open the **Startup command** card on the **Overview** tab, click **Set command** or **Edit**, and then **Save**. You can also enter it in the create dialog, under **Advanced**. You can change or remove it at any time, including while the box is stopped or asleep, and no rebuild is needed. A change takes effect at the next start. On a running box, tick **Run it now as well** before you save to run the new command at once. **Run again** runs the saved command without changing it.

The command runs:

- As the user `dev`, in `/workspace`, with `bash -lc` and the box's environment variables. It is stored exactly as you typed it.
- In a tmux session named `minibox-init`. To watch it, open the box's terminal, or connect over SSH, and run `tmux attach -t minibox-init`. Detach with `Ctrl+B`, then `D`.
- Without holding up the start. MiniBox waits at most five seconds for the command to launch, and a command that fails does not stop the box from starting.

The card shows the command's status:

| Status | Meaning |
|---|---|
| **Not set** | The box has no startup command. |
| **Waiting for the next start** | A command is set, and it has not run since the box last started. |
| **Running** | The command is running now. |
| **Exited with code N** | The last run ended with exit code N. The card also shows when it ended, and the end of its output. |
| **Could not start** | MiniBox could not start the command. The card shows why. |

If the card says that the latest run used an earlier version of the command, run it again to use the current one.

A command can be up to 4096 bytes long. It may span several lines and contain tabs, but no other control characters.

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

1. Open the box, and click the **Resources** tab.
2. Click **Adjust quota**.
3. Set the CPU and memory limits, and click **Save**.

Lowering the memory below the current use can fail, or stop the box with the out-of-memory killer.

## Rebuild a box

Rebuilding replaces the box's container with a new one. Use it when you change the template, the environment variables, the mounts or the security profile.

1. Open the box, and click **Rebuild** on the **Overview** tab.
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

Volumes that other boxes use, and volumes that you created on the **Volumes** page, stay. Deleting a box never deletes a volume that another box still mounts.

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

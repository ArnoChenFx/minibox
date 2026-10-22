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

5. If MiniBox has more than one host, choose the **Host** where the box runs. See [Hosts](hosts.md).
6. To change the security profile, open **Advanced** and choose a profile. The default is `standard`. The same section takes an optional **Startup command**. See [Startup command](#startup-command).
7. To install agent CLIs or other tools with the box, tick them under **Tools**. See [Tools](tools.md).
8. Open **Volumes: defaults**, then choose **Defaults** to mount the workspace, home, cache and tools volumes, or **Customize** to pick the volumes yourself. See [Volumes and storage](volumes-and-storage.md).
9. To set environment variables, open **Environment variables**. See [Environment variables and secrets](environment-and-secrets.md).
10. Click **Create and start**.

The box is listed with its status. Open it to see its details.

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

If you want to keep software that you installed by hand, save the box as a template before you rebuild. See [Templates](templates.md).

## Delete a box

1. Open the box, and click **Delete box**.
2. To remove the volumes that only this box uses, tick **Also delete the volumes this box owns**.
3. Click **Delete box**.

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

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
6. To change the security profile, open **Advanced** and choose a profile. The default is `standard`.
7. To install agent CLIs or other tools with the box, tick them under **Tools**. See [Tools](tools.md).
8. Open **Volumes: defaults**, then choose **Defaults** to mount the workspace, home, cache and tools volumes, or **Customize** to pick the volumes yourself. See [Volumes and storage](volumes-and-storage.md).
9. To set environment variables, open **Environment variables**. See [Environment variables and secrets](environment-and-secrets.md).
10. Click **Create and start**.

The box is listed with its status. Open it to see its details.

## Open a box

Click a box in the list to open it. The box page has these tabs:

| Tab | What it shows |
|---|---|
| **Overview** | Details, environment variables, mounts, the idle timeout and TTL, and the **Rebuild** button |
| **Terminal** | A shell in the box. See [Terminals and sessions](terminal-and-sessions.md). |
| **Activity** | Recent commands, container events and terminal sessions. Below them, **Container output (docker logs)** shows the box's log, with **Auto-refresh**. |
| **Resources** | The CPU and memory limits, the current use, and the **Adjust quota** button |
| **Checkpoints** | Copies of the box's data. See [Checkpoints](checkpoints.md). |
| **Ports** | Listening ports, and ports you add for preview. See [Port preview](port-preview.md). |
| **Tools** | Tools that you can install, upgrade or remove. See [Tools](tools.md). |

## Start, stop and restart

Use the **Start**, **Stop** and **Restart** buttons. You find them in the box list and at the top of the box page.

- **Stop** keeps the box's files and volumes. Its processes end.
- **Start** runs the box again with the same files.
- **Restart** stops and starts the box.

A box can also stop by itself. A box that is idle can sleep, and a box can have a TTL that stops it when it expires. See [Idle sleep and TTL](idle-sleep.md).

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

# Quick start

This guide starts MiniBox on a Linux machine, creates your first box and runs a command in it.

You need:

- A Linux machine with Docker Engine running.
- A web browser.

## 1. Start MiniBox

Run this command:

```bash
docker run -d --name minibox --restart unless-stopped \
  -p 127.0.0.1:3920:3920 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v minibox-data:/data \
  ghcr.io/arnochenfx/minibox:latest
```

The `-p 127.0.0.1:3920:3920` option makes MiniBox reachable only from this machine.

## 2. Get the access key

MiniBox creates an access key the first time it starts. Print it:

```bash
docker exec minibox cat /data/access_key
```

Copy the 64-character key. Keep it private. Anyone with the key controls MiniBox.

## 3. Sign in

1. Open <http://127.0.0.1:3920> in your browser.
2. In **Access key**, paste the key.
3. Click **Sign in**.

On a phone the console shows a bar at the bottom of the window: **Overview**, **Boxes**, **Activity** and **More**. The first three open their page, and **More** opens the sidebar, which lists every page. The rest of this guide works the same way from either.

## 4. Build the base template

A box starts from a template. The MiniBox image does not include the base template. MiniBox builds it the first time a box or a helper needs it, but that first build takes a few minutes, so you can build it now instead.

1. Click **Library** in the sidebar. Its **Templates** tab opens.
2. Click **Build base template**.
3. Wait for the build to finish. The first build can take a few minutes, because it downloads images.
4. To follow the progress, click **Tasks** in the top bar.

When the build finishes, the template **base** appears in the list.

## 5. Create a box

1. Click **Boxes** in the sidebar.
2. Click **Create box**.
3. In **Name**, type `my-box`.
4. Leave **Template** set to **base**.
5. Under **Size**, click **Small**.
6. Click **Create and start**.

## 6. Run a command in the box

1. Click `my-box` in the list of boxes.
2. Click the **Terminal** tab.
3. Type the following commands, pressing Enter after each one:

   ```bash
   whoami
   pwd
   ```

The first command prints `dev`, the user that runs inside every box. The second prints `/workspace`, the folder that keeps your files.

## 7. Install the command-line tool (optional)

The `minibox` command runs boxes and their commands from your own terminal.

1. Install it from the server:

   ```bash
   curl -fsSL http://127.0.0.1:3920/cli/install.sh | sh
   ```

2. If the installer prints a line about `PATH`, add that line to your shell profile. Then open a new terminal.
3. Set the access key for this terminal session:

   ```bash
   export MINIBOX_ACCESS_KEY="$(docker exec minibox cat /data/access_key)"
   ```

4. List your boxes, and run a command in `my-box`:

   ```bash
   minibox box ls
   minibox exec my-box -- uname -a
   ```

## Next steps

- [Boxes](user-guide/boxes.md): resize, stop, rebuild and delete boxes.
- [Terminals and sessions](user-guide/terminal-and-sessions.md): work in a box from the browser or let an agent use it.
- [Tools](user-guide/tools.md): install Claude Code, Codex and other tools into a box.
- [Remote access and TLS](admin/remote-access.md): open MiniBox from another computer.
- [SSH access](user-guide/ssh-and-cli.md): connect with `ssh`, VS Code Remote-SSH, or an SSH app such as Termius. For an SSH app, start MiniBox with `-p 2222:2222 -e SSH_PORT=2222`, see [Direct SSH](admin/install.md#direct-ssh).

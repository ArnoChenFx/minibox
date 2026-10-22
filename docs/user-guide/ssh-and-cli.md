# SSH access and the command-line tool

You can connect to a box with `ssh`, `scp`, `sftp` and `ssh -L`. The connection goes through MiniBox, so no host port is published. The machine that runs `ssh` does not need a copy of MiniBox. It needs only the `minibox` command-line tool, which the server gives you.

Replace `minibox.example.com` in the examples with the address of your MiniBox server. For a local server, use `127.0.0.1:3920`.

## Install the command-line tool

On macOS or Linux, run:

```bash
curl -fsSL https://minibox.example.com/cli/install.sh | sh
```

The installer puts `minibox` in `~/.local/bin`. It needs no `sudo`. If that folder is not on your `PATH`, the installer prints the line to add to your shell profile. Open a new terminal after you add it.

On Windows, open a normal PowerShell window, not an administrator one, and run:

```powershell
irm https://minibox.example.com/cli/install.ps1 | iex
```

The installer puts `minibox.exe` in `%USERPROFILE%\.local\bin`, and adds that folder to your user `PATH`. Open a new terminal afterwards.

To check the install, run `minibox --version`.

## Set up SSH once

Set the server address and the access key, then run `minibox ssh-config --append`:

```bash
export MINIBOX_URL=https://minibox.example.com
export MINIBOX_ACCESS_KEY=...
minibox ssh-config --append
```

The command:

- Adds a `Host *.minibox` block to `~/.ssh/config`.
- Saves the server's host key in `~/.ssh/minibox_known_hosts`, so ssh trusts only that key.
- Saves the server address and key to `~/.config/minibox/ssh-credentials.json`. On macOS and Linux, the file has mode 600.

After that, any shell, and any IDE that uses Remote-SSH, can connect without the key in its environment.

Use the access key, or an agent token with the `box:ssh` scope. Port forwarding with `-L` also needs the `port:expose` scope on the token. Do not pass the key with `--token` on the command line, because it stays in your shell history. Set `MINIBOX_ACCESS_KEY` instead.

On Windows, run the same commands in PowerShell, with `$env:MINIBOX_URL="https://minibox.example.com"` and `$env:MINIBOX_ACCESS_KEY="..."`.

## Connect to a box

Use the box's name with `.minibox` added:

```bash
ssh my-box.minibox
scp ./build.tar.gz my-box.minibox:/workspace/
sftp my-box.minibox
ssh -N -L 8080:127.0.0.1:8080 my-box.minibox
```

- The login user is always `dev`. You can also use the box's ID as the user name.
- A stopped or sleeping box starts when you connect.
- An open connection keeps the box awake.
- Stopping, deleting or rebuilding the box ends its SSH connections.
- `-L` forwards a port from the box to your machine. Forwards reach only `localhost` and `127.0.0.1` inside the box.
- `-R`, Unix socket forwards, X11 forwarding and agent forwarding are refused.

Each box accepts up to 8 SSH connections at the same time. The server accepts up to 64 in total. Each connection can open up to 16 channels.

`sftp` and `-L` need the `openssh-sftp-server` and `socat` packages. The base template includes them. For an older box, run `sudo apt-get install -y openssh-sftp-server socat` inside the box.

## Windows notes

- The OpenSSH Client must be installed. Turn on **OpenSSH Client** under **Settings**, **System**, **Optional features**.
- The files in `%USERPROFILE%\.ssh` must belong to your account. If ssh reports bad permissions, check the file with `icacls "%USERPROFILE%\.ssh\config"`. The owner should be you.
- If you move `minibox.exe`, run `minibox ssh-config --append` again, so the `ProxyCommand` points to the new path.

## Command-line tool reference

The `minibox` command runs boxes, sessions and file operations. Here are the most common commands:

```bash
minibox box ls
minibox exec my-box -- npm test
minibox exec my-box --background --timeout 600 -- npm test
minibox files ls my-volume --path /
minibox mcp
```

Every command has a `--help` option. The [CLI reference](../reference/cli.md) lists every command and option.

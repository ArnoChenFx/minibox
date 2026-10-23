# SSH access and the command-line tool

You can connect to a box with `ssh`, `scp`, `sftp` and `ssh -L`. There are two ways in:

- **Through the command-line tool.** The connection travels over the server's HTTPS address, so no extra port is opened. The machine that runs `ssh` needs the `minibox` command-line tool, which the server gives you. Sections [Install the command-line tool](#install-the-command-line-tool) to [Connect to a box](#connect-to-a-box) cover it.
- **Directly, with any SSH client.** Apps such as Termius, or plain `ssh`, connect to an SSH port that the server opens when `SSH_PORT` is set. They need only a host, a port, a user name, and a password or a private key. See [Connect directly with any SSH client](#connect-directly-with-any-ssh-client).

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

## Connect directly with any SSH client

The server administrator must first set `SSH_PORT`, and make that port reachable. See [Direct SSH](../admin/install.md#direct-ssh). When it is on, the **SSH** dialog of a box shows the details on its **SSH client** tab, each with a copy button.

Fill in the SSH app like this:

| Field | Value |
|---|---|
| Host | The server's address, as the dialog shows it |
| Port | The direct SSH port, as the dialog shows it, for example `2222` |
| Username | The box's name, or its ID |
| Password | An agent token with the `box:ssh` scope, or the access key |
| Private key | Instead of a password: a private key whose public key you added under **Settings**, **SSH keys** |

From a terminal, the same login is:

```bash
ssh -p 2222 my-box@minibox.example.com
```

- The user name selects the box. Inside the box, you are always the `dev` user.
- **Password.** An agent token is the safer choice: create one with the `box:ssh` scope under **Settings**, **Agent API tokens**, and limit it to the boxes it should reach. Its box limits apply. Add `port:expose` for `-L`. The access key works only when it is strong, that is, at least 20 random characters.
- **Private key.** Under **Settings**, **SSH keys**, click **Add key** and paste a public key, such as the content of `~/.ssh/id_ed25519.pub`. Ed25519, ECDSA and RSA keys are accepted. A key logs in as the owner, to any box. Never paste a private key; the console refuses one.
- **Host key.** On the first connection, the app asks you to trust the server's host key. Check that its fingerprint matches the **Host key** in the dialog. It is the same key that `minibox ssh-config` saves.
- A stopped or sleeping box starts when you connect. `scp`, `sftp` and `-L` work as above, and the same refusals apply.
- An unknown box and a wrong password get the same `Permission denied`.
- After 5 failed logins in 15 minutes, an address must wait 30 seconds before it may try again. Each further failure doubles the wait, up to an hour. Every login, refused or not, is recorded in the activity log with the client's address and the method. Passwords are never recorded.

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

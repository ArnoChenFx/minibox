# Tools

Tools are programs that you install into a box, such as AI coding agents, language runtimes and command-line utilities. MiniBox has a catalog of tools. You can also add your own.

## Choose tools when you create a box

In the create dialog, the **Tools** section lists the tools in the catalog. Tick the tools you want. Use **Search tools** to filter the list by name, description or category.

The tools are grouped into:

- **AI coding agents**
- **Languages & runtimes**
- **Terminal & dev utilities**
- **Networking**

The catalog includes Claude Code, OpenAI Codex CLI, OpenCode, Pi coding agent, fx agent, Antigravity CLI, Grok Build CLI, Qoder CLI, oh-my-pi, herdr, luvus, Bun, uv, Rust toolchain, Zig and Tailscale.

If you tick tools, MiniBox installs them after the box starts. Follow the progress in the **Tasks** panel.

## Manage tools in a box

Open the box, and click the **Tools** tab. The table shows each tool's **Desired** state and its **Installed** state.

- **Install** adds a catalog tool to the shared tools volume and to the box's tool list.
- **Upgrade** refreshes an installed tool to the current catalog version on that volume.
- **Uninstall** removes a tool from the shared tools volume and from the box's tool list.
- **Install missing** installs every tool in the box's list that still shows as not installed.

A tool that is already in the box's image or home folder shows as installed, with its version. MiniBox leaves it alone. Upgrade and uninstall apply only to tools that MiniBox installed.

Some tools need root, and a system service. MiniBox never runs those. The catalog marks them **Needs root**. Install them on the host yourself.

Tools go to the shared tools volume, which is mounted read-only in each box. Each tool's program files are shared by every box on that host that uses the same pool's tools volume. A tool that you install into one box is available to the other boxes that share that volume.

If the engine loses the shared tools volume, MiniBox recreates it empty. The tools that were on it show as not installed. Click **Install missing** to install them again. See [Volumes and storage](volumes-and-storage.md#when-the-engine-loses-a-volume).

## Tailscale

Tailscale connects a box to your tailnet. Install it from the catalog, and then:

1. In the box's **Terminal** tab, run `minibox-tailscale up`. It prints a login URL.
2. Open the URL, and sign in to your tailnet.

Keep these points in mind:

- The box does not get a network interface on the tailnet. Programs that listen on `localhost` or `0.0.0.0` can be reached from the tailnet, subject to your tailnet access rules.
- To reach tailnet hosts from the box, use the SOCKS5 and HTTP proxy at `localhost:1055`. Set `ALL_PROXY=socks5h://localhost:1055`. For HTTP clients, set `HTTP_PROXY` and `HTTPS_PROXY` to `http://localhost:1055`.
- `ping` does not work for tailnet hosts. Use `minibox-tailscale ping` instead.
- After a box restarts or wakes from sleep, run `minibox-tailscale up` again. Your saved login is reused.
- Tailnet traffic does not wake a sleeping box.
- Uninstalling Tailscale stops its daemon in that box only. Its login stays on the home volume.

## Custom tools

Only the owner of the MiniBox installation can add or change custom tools. Custom tools are not available to agent tokens.

1. Open a box, click the **Tools** tab, and click **Custom tool**.
2. Fill in the form:
   - **Id**: lowercase letters, digits and hyphens, starting with a letter.
   - **Name**, **Description** and **Category**.
   - **Source**, **Package** and **Binary name**.
   - **Commands**: **Install**, **Upgrade**, **Uninstall** and **Detect**. **Stop (optional)** stops the tool's running program before an uninstall.
3. Click **Save**.

Each command can be up to 16,000 characters. **Detect** must exit with code 0 when the tool is present.

If the id matches a built-in tool, tick **Replace the built-in entry**. Deleting that custom entry brings the built-in tool back.

**Delete** removes only the custom entry. A tool that is already installed on the shared tools volume stays installed.

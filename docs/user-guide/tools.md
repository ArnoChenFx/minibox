# Tools

Tools are programs that you install into a box, such as AI coding agents, language runtimes and command-line utilities. MiniBox has a catalog of tools. You can also add your own.

## Choose tools when you create a box

In the create dialog, the **Tools** section lists the tools in the catalog. Tick the tools you want. Use **Search tools** to filter the list by name, description or category.

The tools are grouped into:

- **AI coding agents**
- **Languages & runtimes**
- **Terminal & dev utilities**
- **Networking**

The catalog includes Claude Code, OpenAI Codex CLI, OpenCode, Pi coding agent, fx agent, Antigravity CLI, Grok Build CLI, Qoder CLI, oh-my-pi, herdr, luvus, Bun, uv, Rust toolchain, Zig, GitHub CLI and Tailscale.

If you tick tools, MiniBox installs them after the box starts. Follow the progress in the **Tasks** panel.

## Manage tools in a box

Open the box, click **Settings**, and then **Tools**. The table shows each tool's **Desired** state and its **Installed** state. The groups start open: fold a group from its header, or search for a tool to see its matches in every group.

- **Install** adds a catalog tool to the shared tools volume and to the box's tool list.
- **Upgrade** refreshes an installed tool to the current catalog version on that volume.
- **Uninstall** removes a tool from the shared tools volume and from the box's tool list.
- **Install missing** installs every tool in the box's list that still shows as not installed.

Tool changes on one host run one at a time, because they write to the same shared tools volume. If you start one while another runs, it waits in a queue: the tool shows **Queued**, and so does its task in the **Tasks** panel. It starts when the changes ahead of it finish, in the order you started them. Clicking the same action again while it waits does not add a second task. To drop a queued change, cancel its task.

A tool that is already in the box's image or home folder shows as installed, with its version. MiniBox leaves it alone. Upgrade and uninstall apply only to tools that MiniBox installed.

Some tools need root, and a system service. MiniBox never runs those. The catalog marks them **Needs root**. Install them on the host yourself.

Tools go to the shared tools volume, which is mounted read-only in each box. Each tool's program files are shared by every box on that host that uses the same pool's tools volume. A tool that you install into one box is available to the other boxes that share that volume.

If the engine loses the shared tools volume, MiniBox recreates it. On a local pool the volume comes back empty, so the tools that were on it show as not installed. Click **Install missing** to install them again. See [Volumes and storage](volumes-and-storage.md#when-the-engine-loses-a-volume).

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

1. Open a box, click **Settings**, then **Tools**, and click **Custom tool**.
2. Fill in the form:
   - **Id**: lowercase letters, digits and hyphens, starting with a letter.
   - **Name**, **Description** and **Category**.
   - **Source**, **Package** and **Binary name**.
   - **Commands**: **Install**, **Upgrade**, **Uninstall** and **Detect**. **Stop (optional)** stops the tool's running program before an uninstall.
3. Click **Save**.

Each command can be up to 16,000 characters. **Detect** must exit with code 0 when the tool is present.

If the id matches a built-in tool, tick **Replace the built-in entry**. Deleting that custom entry brings the built-in tool back.

**Delete** removes only the custom entry. A tool that is already installed on the shared tools volume stays installed.

## Copy and paste a tool's JSON

Every tool in the table has a **Copy JSON** button, next to its install, upgrade or uninstall buttons. It is the icon alone, and its tooltip says what it does: the words would take the room the actions beside it need on a narrow window. It copies that tool's catalog entry as JSON, in the same shape as the files in `catalog/` on the server: `id`, `name`, `description`, `category`, `source`, `package`, `bin`, `needsRoot`, `estimatedMb`, `requires`, `install`, `upgrade`, `uninstall`, `stop` and `detect`. `requires` and `stop` appear only when the tool sets them. Install state is not part of it, so a copy describes the tool rather than the box.

Built-in tools have no edit or delete button, and that stays true: their JSON is copied read-only, to start a fork of your own. A custom tool's row has the copy button beside **Edit** and **Delete**.

To fork a tool:

1. Click the copy button on the tool's row (its tooltip reads **Copy JSON**). A toast confirms that it is on the clipboard. If the browser refuses, MiniBox still copies through the older clipboard path, and says so if that fails too.
2. Click **Custom tool**, then open **Paste JSON** in the dialog and paste the text there.
3. Click **Fill the form**. The form fills from the description, and the **Id** becomes `<id>-copy`, because the catalog already has the tool: a paste adds a tool rather than replacing a built-in one. If `<id>-copy` is taken too, the id becomes `-copy-2`, `-copy-3` and so on, always within the 63 characters an id allows.
4. Change what you need, then click **Save**.

The form is still what is saved, so every value a paste fills can be edited first. When you paste into an entry you are **editing**, the **Id** and **Replace the built-in entry** stay as they are, since the id names the file being edited and cannot be renamed. A description that does not parse, or that carries a field the form does not know, is refused inside the **Paste JSON** box with a message naming the problem, and nothing already typed in the form is cleared. A description with no `category`, `source`, `needsRoot`, `estimatedMb`, `requires` or `stop` takes the same defaults as a new entry: `agents`, `npm`, no root, 50 MB, and neither optional field.

The copied JSON can also be saved as a file in `DATA_DIR/tools.d/<id>.json` on the server, or sent to `PUT /api/tools/custom/<id>` as it is. A description whose id is a built-in one needs `overrideBuiltin: true` on that route, since it replaces the built-in entry rather than adding a tool.

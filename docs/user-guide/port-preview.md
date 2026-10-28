# Port preview

Port preview lets you open a web app that runs in a box. The app appears through MiniBox, so you do not publish a port on the host.

You must be signed in to MiniBox to open a preview.

**An agent host does not support port preview yet.** A preview relays the port through MiniBox, and an agent host opens no address MiniBox can relay to, so the preview is refused even when the port is listed. The **Ports** tab says so instead of offering **Open**. Reach the service on the machine itself, or use the [terminal](terminal-and-sessions.md) or [SSH](ssh-and-cli.md), until the box moves to a host MiniBox reaches directly.

## Open a preview

1. Start a web server in the box. For example, run this in the **Terminal** tab:

   ```bash
   python3 -m http.server 8000
   ```

2. Open the box, and click the **Ports** tab.
3. Click **Refresh** if the port is not listed. MiniBox scans the box for listening ports.
4. Click **Open** next to the port.

The address depends on how your administrator set up MiniBox.

- **Path mode** is the default. The preview is on the MiniBox address:

  ```
  http://127.0.0.1:3920/box/<name>/<port>/
  ```

  Replace `<name>` with the box's name, or its ID. For example, `http://127.0.0.1:3920/box/my-box/8000/`.

- **Subdomain mode** gives each preview an address of its own:

  ```
  https://<port>-<box>.<domain>/
  ```

  For example, `https://8000-my-box.minibox-preview.net/`. The app runs at `/`. The `<box>` part is the box's name when the name is lowercase letters, digits and hyphens. Otherwise it is the box's ID.

Open the preview in a new tab. Previews run in a sandbox, so they cannot read your MiniBox sign-in cookie. In subdomain mode, a preview also runs on its own address, so it cannot call the MiniBox API.

## Path mode and browser isolation

In path mode, the preview shares MiniBox's address. Its isolation relies on browser behaviour: the preview runs in a sandbox, and the sign-in cookie is `HttpOnly` and `SameSite=Strict`. That is enough for one trusted user. If other people can reach MiniBox, or a box runs code you do not fully trust, ask your administrator to turn on subdomain mode. See [Subdomain previews](../admin/preview-subdomains.md).

## Add a port by hand

Use this when a port is not listed, or when the app starts after you open the tab.

1. On the **Ports** tab, click **Add port**.
2. Enter the port number, and click **Add port** in the dialog.

Adding a port only saves it for preview. It does not publish a port on the host.

## Frameworks

In path mode, many web frameworks expect the app to live at `/`. Set the app's base path to `/box/<name>/<port>/`. For example, set `base` in Vite, or `assetPrefix` in Next.js.

Without this setting, pages load their scripts and styles from the wrong address. In subdomain mode the app lives at `/`, so it needs no base path.

WebSocket connections work through the preview. Hot module reload in Vite uses a WebSocket, so it works too.

## How a preview reaches the box

Every preview goes through a small relay that MiniBox starts in the box with `python3`. The relay connects to the port on the box's loopback address, so an app that listens on `127.0.0.1` is enough; no port is published on any host.

The box needs `python3` on its path. The base template includes it. Without it, the preview fails with a `502` error that names the cause. HTTP and WebSocket work the same way. A request to a sleeping box wakes it, and the box stays awake while a response or a WebSocket is open.

## Boxes on another host

A box on another host, reached through SSH, mutual TLS or a Unix socket, is previewed through that host's engine. The addresses are the same as for a local box, and the relay works the same way. The remote host opens no port.

## Limits

- A box on an agent host has no port preview yet.
- Share links are not available. Open a preview from the **Ports** tab while you are signed in. In subdomain mode, the preview's address does not open on its own. Opening it from the **Ports** tab lets that browser use the preview for up to 8 hours, or until you sign out.
- Renaming a box can change its subdomain address. After a rename, the preview stops loading, so open it again from the **Ports** tab.
- In subdomain mode, a page in one preview cannot change another port's preview, and cannot open a WebSocket to it. Its own page works as usual.
- A preview keeps its box awake while a response is loading, and while a WebSocket is open. See [Idle sleep and TTL](idle-sleep.md).

# Port preview

Port preview lets you open a web app that runs in a box. The app appears through MiniBox, so you do not publish a port on the host.

You must be signed in to MiniBox to open a preview.

## Open a preview

1. Start a web server in the box. For example, run this in the **Terminal** tab:

   ```bash
   python3 -m http.server 8000
   ```

2. Open the box, and click the **Ports** tab.
3. Click **Refresh** if the port is not listed. MiniBox scans the box for listening ports.
4. Click **Open** next to the port.

The address has this form:

```
http://127.0.0.1:3920/box/<name>/<port>/
```

Replace `<name>` with the box's name, or its ID. For example, `http://127.0.0.1:3920/box/my-box/8000/`.

Open the preview in a new tab. Previews run in a sandbox, so they cannot read your MiniBox sign-in cookie.

## Add a port by hand

Use this when a port is not listed, or when the app starts after you open the tab.

1. On the **Ports** tab, click **Add port**.
2. Enter the port number, and click **Add port** in the dialog.

Adding a port only saves it for preview. It does not publish a port on the host.

## Frameworks

Many web frameworks expect the app to live at `/`. Set the app's base path to `/box/<name>/<port>/`. For example, set `base` in Vite, or `assetPrefix` in Next.js.

Without this setting, pages load their scripts and styles from the wrong address.

WebSocket connections work through the preview. Hot module reload in Vite uses a WebSocket, so it works too.

## Limits

- Previews work only for boxes on the local host. A box on a remote host shows an error.
- Previews use only the path address shown above. Subdomain addresses are not available.
- A preview keeps its box awake while a response is loading, and while a WebSocket is open. See [Idle sleep and TTL](idle-sleep.md).

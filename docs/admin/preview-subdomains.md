# Subdomain previews

By default a port preview opens at `/box/<name>/<port>/` on the console's own address. The preview then shares the console's origin, so its isolation relies on browser behaviour: the preview runs in a sandbox, and the console's sign-in cookie is `HttpOnly` and `SameSite=Strict`. That is enough for one trusted user, and it needs no DNS or certificates.

Set `PREVIEW_BASE_DOMAIN` to give each preview an origin of its own:

```
https://<port>-<box>.<PREVIEW_BASE_DOMAIN>/
```

For example, port 3000 of a box named `web`, with `PREVIEW_BASE_DOMAIN=minibox-preview.net`, opens at `https://3000-web.minibox-preview.net/`. A preview on its own origin cannot read the console's cookies or storage, and its scripts cannot call the console API. The preview can still use its own storage and cookies, which many apps need.

The `<box>` part is the box's name when the name is at most 57 lowercase letters, digits and hyphens that start and end with a letter or digit, such as `web` or `my-box`. Any other name is replaced by the box's ID, with the underscore turned into a hyphen, such as `bx-3f9c…`. Use **Open** in the box's **Ports** tab to reach a preview, so you do not need to build the address yourself.

## What you need

- **A domain for previews.** It must be neither the console's domain nor under it. For example, the console at `minibox.example.com` and the previews at `*.minibox-preview.net`. Names that end in the same two labels, such as `minibox.example.com` and `preview.example.com`, can count as one site to browsers, and the self-check warns about that.
- **A wildcard DNS record**, `*.minibox-preview.net`, that reaches MiniBox, directly or through a tunnel.
- **A wildcard certificate** that covers `*.minibox-preview.net`. A wildcard matches one label, so `3000-web.minibox-preview.net` is covered. MiniBox only creates names of that depth.
- **HTTPS for the console and for the previews.** The preview's grant cookie is `Secure`, and browsers do not store it over plain HTTP.
- **The `Host` header kept.** The proxy must pass the public `Host` through unchanged. MiniBox reads the port and the box from it.

## Turn it on

1. Set `PREVIEW_BASE_DOMAIN` in `.env`, for example `PREVIEW_BASE_DOMAIN=minibox-preview.net`. Write a bare domain, without `https://`, a port or a path. An invalid value stops startup, and the message says what to fix.
2. Restart MiniBox.
3. Open **Settings**. The **Port previews** card runs four checks from the MiniBox host, and each one explains itself when it fails:
   - The console's address is outside the preview domain.
   - The console and the preview domain are different sites. A warning means both names end in the same two labels, such as `example.com`.
   - A random name under the preview domain resolves.
   - That name answers over HTTPS from MiniBox. MiniBox recognises its own answer, so a wildcard that reaches another server fails this check.

The checks run on the MiniBox host, so they show what MiniBox can resolve and reach. A browser on another network can still fail for reasons the checks do not see, such as its own DNS.

While `PREVIEW_BASE_DOMAIN` is set, `/box/` addresses return `404`. The shared-origin preview is not offered beside the isolated one.

To turn subdomain previews off, remove `PREVIEW_BASE_DOMAIN` and restart MiniBox. Previews go back to `/box/<name>/<port>/`.

## Cloudflare Tunnel

Put both the console's zone and the `minibox-preview.net` zone on Cloudflare, in one account, so a single tunnel can route both hostnames. Universal SSL then issues the certificate for `*.minibox-preview.net`.

Give the tunnel both hostnames in its ingress rules. This `config.yml` sends them to MiniBox on the same machine:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: minibox.example.com
    service: http://127.0.0.1:3920
  - hostname: "*.minibox-preview.net"
    service: http://127.0.0.1:3920
  - service: http_status:404
```

Create the DNS records for the tunnel:

```bash
cloudflared tunnel route dns <tunnel-name> minibox.example.com
cloudflared tunnel route dns <tunnel-name> "*.minibox-preview.net"
```

`cloudflared` forwards the `Host` header it receives, so no `httpHostHeader` setting is needed. Keep `HOST=127.0.0.1` and `PORT=3920` in `.env`, as in the examples.

## Caddy

Caddy issues a wildcard certificate only through the DNS challenge. Build Caddy with the DNS module for your provider, for example `caddy-dns/cloudflare`:

```bash
xcaddy build --with github.com/caddy-dns/cloudflare
```

Then use these site blocks in the Caddyfile. Set `CLOUDFLARE_API_TOKEN` in Caddy's environment, to a Cloudflare API token that can edit DNS records for the zone:

```caddyfile
minibox.example.com {
	reverse_proxy 127.0.0.1:3920
}

*.minibox-preview.net {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:3920
}
```

`reverse_proxy` keeps the request's `Host` header unless you set `header_up Host`, so leave that out.

## Checks

- **Settings**, then **Port previews**: the card shows no error, and each check reads as passed.
- Open a port from a box's **Ports** tab. The browser goes to `https://<port>-<box>.<domain>/`, and the app loads there.
- Paste that address into a browser that is not signed in to the console. It does not open, because a preview needs the grant that the console issues.

## Lifetime

- A preview opens with a one-time link that is valid for 60 seconds. The preview host spends it and sets a grant cookie.
- The grant lasts up to 8 hours. It ends sooner when its sign-in ends, such as when you sign out, or when its box is renamed or deleted.
- Grants are kept in memory, so restarting MiniBox ends them. Open the preview again from the console.
- A stopped box refuses a preview. A sleeping box wakes up when you open one.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| `401`, "Open this preview from the MiniBox console" | The link was used or has expired, the sign-in that opened it has ended, or the box was renamed or removed. Open the port again from the **Ports** tab. |
| `404`, "No box port is served at this address" | The host name is not `<port>-<box>.<domain>`, or the proxy changed the `Host` header. |
| Port previews card: "Nothing resolves ..." | The wildcard DNS record is missing, or it does not resolve from the MiniBox host. |
| Port previews card: "Could not reach ... over HTTPS" | The wildcard does not reach MiniBox, or its certificate does not cover `*.minibox-preview.net`. |
| Port previews card: "answers, but not from MiniBox" | Another server answers under the domain. Route the wildcard to MiniBox. |
| The preview loads, but the app's requests fail | The app builds addresses under `/box/<name>/<port>/`. In subdomain mode the app lives at `/`. |

## Security notes

- The console's sign-in cookie is never sent to a preview host. A grant is not the sign-in, and it opens only the preview it was issued for.
- A ticket works once, and only for the box and port it was issued for.
- A write or a WebSocket from a preview is refused unless its `Origin` is that preview's own address. This stops one preview from changing a sibling. A `GET` from a sibling is not blocked, so apps must not change state on `GET`.
- Cookies a box sets in its responses stay on its own preview host, because MiniBox drops their `Domain` attribute. A script on the page can still set a cookie for the whole preview domain, so do not trust cookies across previews.
- A name under the base domain that is not a preview, including the domain itself, gets a `404`.
- A subdomain preview may use its own storage and cookies. Run only apps you trust in boxes, as before.

For the whole security model, see [Security](security.md#port-previews).

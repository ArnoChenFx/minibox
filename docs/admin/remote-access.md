# Remote access and TLS

MiniBox listens on `127.0.0.1` by default, so only the machine it runs on can reach it. To reach it from other machines, put it behind HTTPS. You can use one of these:

- A reverse proxy that you run, such as nginx or Caddy.
- A private network, such as Tailscale or WireGuard. This is the safest choice.
- A tunnel service, such as [OpenTunnel](https://opentunnel.xyz). Tunnels add no authentication of their own. See [Public tunnels](#public-tunnels) below.

## Which settings do you need?

The settings depend on what sits in front of MiniBox.

1. **A tunnel that keeps the `Host` and `Origin` headers, and adds no `X-Forwarded-*` headers, such as OpenTunnel.** Leave `TRUST_PROXY` off. Every request then reaches MiniBox from `127.0.0.1`, so all visitors share one sign-in rate-limit bucket. A correct key still signs in. `ALLOWED_ORIGINS` is optional here, because `Host` already matches the public address. Setting it does no harm. The session cookie gets the `Secure` flag from the browser's `https://` origin.

2. **A reverse proxy that you control.** Set `TRUST_PROXY=true`, but only if the proxy overwrites, or strips and adds back, `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` on every request. Also make sure MiniBox is reachable only through that proxy. Keep `HOST=127.0.0.1`. With `TRUST_PROXY=true`, MiniBox trusts all three headers. A client that can reach MiniBox directly, or a proxy that passes client-supplied values through, can forge them.

3. **`ALLOWED_ORIGINS=https://your-public-address`**, when the proxy rewrites `Host` to its upstream address. Without it, sign-in and terminal requests from the public address get `403`, and the login page says that the origin is not allowed. nginx rewrites `Host` unless you set `proxy_set_header Host $host;`.

4. **`COOKIE_SECURE=1`**, only when browsers reach MiniBox over HTTPS, but the requests that MiniBox sees carry no `https://` origin, for example because a proxy strips it. Browsers drop `Secure` cookies that arrive over plain HTTP. Never set it for an address that is reachable only over HTTP.

If the log shows `proxy.headers_ignored`, MiniBox received forwarded headers while `TRUST_PROXY` was off. Behind a reverse proxy that sets them, enable `TRUST_PROXY` as described above. A same-host tunnel such as OpenTunnel adds none of these headers, so any such header came from a client, and the setting stays off.

MiniBox also refuses requests from other websites. The browser's `Origin` must match the `Host` that the request arrived with, or be listed in `ALLOWED_ORIGINS`.

## nginx example

This server block passes the public `Host` through to MiniBox:

```nginx
location / {
    proxy_pass http://127.0.0.1:3920;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
```

The `Upgrade` and `Connection` headers are needed for the terminal and for live updates. Set `TRUST_PROXY=true` only if you also keep the port closed to other clients.

## OpenTunnel example

OpenTunnel can route a local port to a public `https://` address:

```bash
opentunnel route add 3920 --name minibox
opentunnel up
```

The command prints an address of the form `https://minibox.<your-id>.opentunnel.xyz`.

## Public tunnels

A public tunnel address can appear in certificate transparency logs, and it can be guessed. The tunnel itself adds no sign-in, so the access key is the only protection. Traffic also passes through the tunnel provider's relay.

- Prefer a private network, or a reverse proxy that requires its own sign-in.
- Stop the tunnel when you do not need it.
- Use a long, random access key. See [Security](security.md).

## Checks

- Open the address in a browser. The sign-in page should load over HTTPS.
- Sign in. If the page says that the origin is not in `ALLOWED_ORIGINS`, see step 3 above.
- Open a box's terminal. If it fails, check `ALLOWED_ORIGINS` and the `Upgrade` headers in the proxy.

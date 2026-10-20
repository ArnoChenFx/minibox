# Vendored front-end libraries

These files are served by MiniBox itself, so the console needs no CDN and works offline. They are copied unchanged from the npm tarballs below. `SHA256SUMS` records their hashes, and `tests/vendor.test.ts` fails if a file changes.

| Path | Package | Version | Upstream file |
|---|---|---|---|
| `xterm/xterm.js` | `@xterm/xterm` | 5.5.0 (MIT) | `lib/xterm.js` |
| `xterm/xterm.css` | `@xterm/xterm` | 5.5.0 (MIT) | `css/xterm.css` |
| `xterm-addon-fit/addon-fit.js` | `@xterm/addon-fit` | 0.10.0 (MIT) | `lib/addon-fit.js` |

Source maps are not included.

To update: `npm pack @xterm/xterm@<version> @xterm/addon-fit@<version>`, check the tarballs against `npm view <pkg>@<version> dist.integrity`, copy the files above, regenerate `SHA256SUMS` (`sha256sum`, run from this directory), and update this table.

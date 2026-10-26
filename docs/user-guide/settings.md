# Settings

Open **Settings** in the sidebar to manage the console and the server's access. The menu beside the page lists the sections, and the page shows one section at a time. Each section has its own address, such as `#/settings/hosts`, so the browser's back and forward buttons move between them. The sections are:

| Section | What you do there |
|---|---|
| **Runtime configuration** | View listen address, Docker socket, box limits and related server settings. These values are read-only here. |
| **Port previews** | When `PREVIEW_BASE_DOMAIN` is set, show the subdomain preview setup and run its checks from the MiniBox host. Path mode has nothing to check. See [Subdomain previews](../admin/preview-subdomains.md). |
| **Hosts** | Add agent hosts or Docker hosts, test Docker hosts, revoke agents and remove hosts. See [Hosts](hosts.md). |
| **Appearance** | Switch between light and dark. With no saved choice, the theme follows your system. A manual choice is remembered in that browser. |
| **Signed-in sessions** | See the browsers that are signed in, and sign them out. See [Access, sessions and tokens](access-and-tokens.md). |
| **Agent API tokens** | Create, read and revoke tokens for agents and scripts. See [Access, sessions and tokens](access-and-tokens.md#agent-api-tokens). |
| **Secrets** | Add, replace and delete host secrets. See [Environment variables and secrets](environment-and-secrets.md). |
| **SSH keys** | Add and delete the public keys that may log in over direct SSH. Each key shows its label, fingerprint, and when it was added and last used. See [SSH access](ssh-and-cli.md#connect-directly-with-any-ssh-client). |
| **Off-site targets** | Add S3-compatible or SFTP targets for checkpoint packages and backups, check them, and remove them. See [Backups](../admin/backups.md#off-site-targets). |
| **Notifications** | Add, change, pause and delete notification channels, send a test notice, and see recent deliveries. Owner only. See [Notifications](notifications.md). |

The **About** page shows the version of MiniBox that is running, and links to the documentation, the changelog and the license. Click the version at the foot of the sidebar to open it.

On a phone the sidebar is a drawer that the **More** tab of the bottom bar opens, and the bar's other three tabs open **Overview**, **Boxes** and **Activity** directly. The bar marks **More** while a page of its own is open, such as this one.

Changes that you make on the **Settings** page take effect at once. Secrets and tokens are shown only once, when you create them.

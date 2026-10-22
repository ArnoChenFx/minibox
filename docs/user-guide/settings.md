# Settings

Open **Settings** in the sidebar to manage the console and the server's access. The page has these sections:

| Section | What you do there |
|---|---|
| **Runtime configuration** | View listen address, Docker socket, box limits and related server settings. These values are read-only here. |
| **Port previews** | When `PREVIEW_BASE_DOMAIN` is set, show the subdomain preview setup and run its checks from the MiniBox host. Path mode has nothing to check. See [Subdomain previews](../admin/preview-subdomains.md). |
| **Hosts** | Add agent hosts or Docker hosts, test Docker hosts, revoke agents and remove hosts. See [Hosts](hosts.md). |
| **Appearance** | Switch between light and dark. With no saved choice, the theme follows your system. A manual choice is remembered in that browser. |
| **Signed-in sessions** | See the browsers that are signed in, and sign them out. See [Access, sessions and tokens](access-and-tokens.md). |
| **Agent API tokens** | Create, read and revoke tokens for agents and scripts. See [Access, sessions and tokens](access-and-tokens.md#agent-api-tokens). |
| **Secrets** | Add, replace and delete host secrets. See [Environment variables and secrets](environment-and-secrets.md). |

The **About** page in the sidebar shows the version of MiniBox that is running, and links to the documentation, the changelog and the license.

Changes that you make on the **Settings** page take effect at once. Secrets and tokens are shown only once, when you create them.

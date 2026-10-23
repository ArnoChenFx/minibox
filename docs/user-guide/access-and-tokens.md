# Access, sessions and tokens

MiniBox has three ways to prove who you are:

- **The access key** signs you in to the console, and it is the owner's key for the REST API, the CLI and MCP. MCP accepts it for now, see [Connecting AI agents](agents.md).
- **Browser sessions** are the sign-ins that you keep in each browser.
- **Agent tokens** are keys for agents and scripts. Each token has only the permissions you give it.

## The access key

The access key is a random string of 64 characters. MiniBox creates it the first time it starts, unless the administrator set one. To read it from a Docker install, run:

```bash
docker exec minibox cat /data/access_key
```

Treat the access key like a root password. Anyone with the key controls the whole server. Do not put it in a prompt, a log or a repository. Give agents an agent token instead.

If you suspect the key has leaked, ask the administrator to change it. Changing the key ends every browser sign-in.

Wrong keys are refused for a while after repeated failures. A correct key always works.

## Signed-in browsers

Each browser that signs in is a session. A session lasts 30 days by default, counted from sign-in. The administrator can change this.

To see the browsers that are signed in, open **Settings**. Under **Signed-in sessions**, the list shows each browser, when it signed in, and when it was last seen. **This browser** marks the one you are using.

- To sign out one browser, click **Revoke** next to it, and confirm. That browser's open terminals close.
- To sign out every other browser, click **Sign out other sessions**, and confirm.

## Agent API tokens

An agent API token is a secret that starts with `mbx_`. Use one for each agent or script. It can do only what its scopes and limits allow.

A box's own agent has a different token, the self token. The owner gives it to a box when the box is created. It reaches only that box, and it is not listed here. See [A box's own agent](agents.md#a-boxs-own-agent).

### Create a token

1. Open **Settings**, and click **New token** in **Agent API tokens**.
2. Enter a name, and choose a **Preset**. See the table below.
3. Set **Expires in (days)** if the token should expire. Leave it empty for no expiry.
4. Choose which **Boxes**, **Volumes** and **Hosts** the token may use.
5. Under **Quotas**, set limits if you want them. The limits are the number of boxes, total CPU cores, total memory in MB, the longest TTL in hours, requests per minute, and checkpoints.
6. Click **New token**. Copy the secret now. MiniBox does not show it again.

After you create the token, MiniBox shows an example for **REST** and the **MCP client config**, with the secret filled in. Copy either one.

The command line can create one too: `minibox token create <name>` prints the secret once. See the [CLI reference](../reference/cli.md#tokens).

### Presets

| Preset | What it allows |
|---|---|
| `readonly` | Read boxes and files on this host. By default it sees only the boxes it created, and it cannot create boxes. Give it specific boxes, or every box, to make it useful. |
| `operator` | Everything except secret use, on this host. Only the boxes the token created. |
| `sandboxed-agent` | Like `operator`, but without mounting existing volumes, installing tools or SSH. Quotas apply: 5 boxes, 8 CPU cores and 16 GB in total, a 4-hour TTL, 60 requests a minute, and 20 manual checkpoints. |
| `admin` | Every scope, on every box and every host. Use it only for a trusted tool. |

### Scopes

Each preset is a set of these scopes:

| Scope | What it allows |
|---|---|
| `box:read` | See boxes and their details, templates, tasks and the events of visible boxes |
| `box:write` | Create and change boxes |
| `box:delete` | Delete boxes |
| `exec` | Run commands in boxes. Commands can read and write every volume the box mounts. |
| `box:ssh` | Open SSH connections to boxes |
| `files:read`, `files:write` | Read and write files in volumes |
| `port:expose` | Preview ports, and forward ports over SSH |
| `checkpoint:create` | Take checkpoints and snapshots, and change or delete the ones the token created |
| `checkpoint:restore` | Roll a box back to a checkpoint |
| `volume:read` | See volumes |
| `volume:write` | Create volumes |
| `volume:attach` | Mount existing volumes into boxes |
| `tool:install` | Install, upgrade and remove tools. Save a box as a template, and delete templates. |
| `secret:use` | Give a box a host secret, or the secret for a repository clone |
| `trash:skip` | Delete a box or a volume without keeping a copy in the recycle bin. No preset includes it. |

Only the owner can create, change or revoke tokens. A token cannot create other tokens. Building or rebuilding a template, and pulling an image, are for the owner only. No scope allows them.

A box or volume delete keeps a copy of its data in the [recycle bin](checkpoints.md#recycle-bin) unless the request sets `skipTrash`, which needs `trash:skip`. The recycle bin itself, its list, restore and purge, is for the owner only.

### Revoke a token

Click **Revoke** on the token, and confirm. Scripts that use the token stop at once. Any open terminal or event stream that uses it closes too.

To delete the boxes that the token created at the same time, tick **Also delete boxes this token created**. Their workspace volumes are deleted as well, and their data is kept in the recycle bin for the retention period, as with any box delete.

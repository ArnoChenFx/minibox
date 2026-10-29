# Access, sessions and tokens

MiniBox has three ways to prove who you are:

- **The access key** signs you in to the console, and it is the owner's key for the REST API and the CLI. MCP refuses it by default, see [Connecting AI agents](agents.md).
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
| `operator` | Create and manage its own boxes on this host, including terminals, files, checkpoints, tools and SSH. No secret use or storage administration. |
| `sandboxed-agent` | Like `operator`, but without mounting existing volumes, installing tools, or SSH. Quotas apply: 5 boxes, 8 CPU cores and 16 GB in total, a 4-hour TTL, 60 requests a minute, and 20 manual checkpoints. |
| `admin` | Every box and host, secret use and storage administration. Deletes keep recycle-bin copies by default. Use it only for a trusted tool. |

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
| `volume:write` | Provision default Box role volumes and mount accessible volumes read-write. Explicit independent volume creation or deletion also requires storage administrator identity |
| `volume:attach` | Mount existing volumes into boxes |
| `volume:delete` | Delete several volumes at once, with storage administrator identity. The admin preset includes this scope; adding it alone does not grant administrator identity. |
| `tool:install` | Install, upgrade and remove tools. Save a box as a template, and delete templates. |
| `secret:use` | Give a box a host secret, or the secret for a repository clone |
| `trash:skip` | Delete a box or a volume without keeping a copy in the recycle bin. No preset includes it. |

Only the owner can create, change or revoke tokens. A token cannot create other tokens. Building or rebuilding a template, and pulling an image, are for the owner only. No scope allows them.

A box or volume delete keeps a copy of its data in the [recycle bin](checkpoints.md#recycle-bin) unless the request sets `skipTrash`, which needs `trash:skip`. The recycle bin itself, its list, restore and purge, is for the owner only.

### Storage administration

Only the owner and an **unmodified admin token** can select, list or configure storage pools, or explicitly create/delete volumes, including batch deletion and orphan pruning. The admin preset's scopes and box/host ranges must be unrestricted. Custom scopes, a token name or a volume scope alone do not grant administrator identity. These rules apply to every saved token.

| Caller | Storage pools and independent volumes | Box functions |
| --- | --- | --- |
| Owner | Allowed | Allowed |
| Unmodified admin | Resource grants, confirmation and audit apply | Required scopes apply |
| Operator, sandboxed-agent, custom or narrowed admin | Refused | Box/resource grants and scopes apply |
| Box self-token | Refused | Only that box's self operations |

When no pool is specified, the server provisions default role volumes for an authorized Box create. Deleting a Box together with its volumes (`deleteVolume=true`) is explicit volume deletion: a token without storage administrator identity gets `403 storage_admin_required` and the Box is not deleted either. Deleting a Box without that flag keeps its volumes. Files, terminals, ports, checkpoints and activity use their own scopes on authorized boxes; SSH requires `box:ssh`. Token management and other owner-only operations require the owner.

### Revoke a token

Click **Revoke** on the token, and confirm. Scripts that use the token stop at once. Any open terminal or event stream that uses it closes too.

To delete the boxes that the token created at the same time, tick **Also delete boxes this token created**. Their workspace volumes are deleted as well, and their data is kept in the recycle bin for the retention period, as with any box delete.

### Delete a revoked or expired token

A revoked or expired token stays in the list, with its name, until you delete it. Click **Delete** on the token, and confirm, to remove its record. To remove every revoked and expired token at once, click **Clean up ended tokens** above the list. The confirmation shows how many it will delete.

A live token cannot be deleted. Revoke it first. Deleting a record changes nothing for scripts, because the token has already stopped working. The activity log keeps the `token.delete` event with the token's name and id, and the earlier events about it keep their names. It never records the secret.

From the command line, `minibox token delete <id>` deletes one record, and `minibox token prune` deletes all of them. Over REST, they are `DELETE /api/tokens/{id}/record` and `POST /api/tokens/prune`. Only the owner can call them.

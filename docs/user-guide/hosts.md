# Hosts

A host is a Docker engine that MiniBox can run boxes on. The machine that runs MiniBox is always the host **local**. You can add other Docker engines, and choose the host when you create a box.

Each box records its host. Everything you do to a box runs on that host.

## Ways to connect to a host

| Endpoint | How MiniBox connects | What you need |
|---|---|---|
| `unix:///var/run/docker.sock` | A socket on this machine, or one mounted into the container | Nothing else |
| `tcp://host:2376` | The engine's TLS port, with mutual TLS in both directions | The CA that signed the engine's certificate, and a client certificate and key that the engine trusts. |
| `ssh://user@host` | The engine's Docker socket, forwarded over SSH. Only the SSH port must be open. | An SSH key that can log in as that user. The socket is `/var/run/docker.sock`, unless the path says otherwise. |
| None: the agent dials in | An [agent](../reference/agent.md) on the machine opens an outbound connection to MiniBox. The machine opens no port. | Docker on the machine, and the pairing command from **Add host**. Works behind NAT and firewalls. |

## Add an agent host

An agent is a small program that runs in a container on the machine and connects out to MiniBox. The machine opens no port and needs no certificate or SSH key, so an agent works behind NAT and firewalls. The machine needs Docker, and it must reach the MiniBox address that the command names.

1. Click **Settings** in the sidebar, open the **Hosts** section, and click **Add host**.
2. Choose **Agent (recommended)**, enter an **Id**, and optionally a **Name**.
3. Click **Create pairing command**. MiniBox shows a pairing code and a `docker run` command, one for bash and one for PowerShell.
4. Run the command on the machine. The agent exchanges the code for its own credentials, which it keeps in the `minibox-agent` volume, and it reconnects by itself after a restart.
5. The dialog closes when the agent connects. The host then shows as online, with the agent's version and when it was last seen.

A pairing code works once and expires after 10 minutes. MiniBox spends it as soon as it receives it, so if the agent loses the reply and cannot save its credentials, the code is no longer valid. Then remove the agent's container and create a new code. Only the first start needs the code. For the options, the data volume and the operations an agent allows, see the [agent reference](../reference/agent.md).

## Add a host with a Docker address

1. Click **Settings** in the sidebar, then open the **Hosts** section.
2. Click **Add host**, and choose **Docker address**.
3. Fill in the form:
   - **Id**: lowercase letters, digits and hyphens, starting with a letter.
   - **Name**: a name you recognise.
   - **Endpoint**: one of the forms in the table above.
   - The credential fields that the endpoint needs: **CA certificate (PEM)**, **Client certificate (PEM)** and **Client key (PEM)** for `tcp://`, or **SSH private key (OpenSSH, no passphrase)** for `ssh://`.
4. Click **Test** first. MiniBox connects to the engine, reads its version and capacity, and shows the result. Nothing is saved.
5. Click **Add host**.

For an SSH host, MiniBox shows the host's key fingerprint, which starts with `SHA256:`. Compare it with the key on the machine itself. Then click **Trust and add**. Add the host only when the fingerprints match.

Credentials are saved on the MiniBox host, and the console never shows them again.

## Create a box on another host

In the create dialog, choose the **Host**. The default is **local**. Choose **Auto** to let MiniBox pick: it uses the online host that holds the template and has the most CPU and memory left once the box is placed. An agent token picks only among the hosts it is granted.

A box on another host needs its template image on that host's Docker engine. Build or copy the template there first. Templates are not copied between hosts.

## Capacity

With more than one host, MiniBox counts the CPU and memory that running boxes reserve on each host. A new box, a resize or a move that would reserve more than the host has is refused. `HOST_OVERCOMMIT` allows more, up to 10 times the host's capacity (see [Configuration](../reference/configuration.md)). A stopped box reserves nothing.

## Move a box to another host

1. Open the box and click **Move to host**. The button appears when there is more than one host.
2. Choose the target host and click **Preview**. The preview lists each volume and what happens to it, whether the template image is sent, and whether the box starts on the target. Nothing changes yet.
3. Click **Move box**. The move runs as a task in the task panel.

What a move does:

- The template image is sent to the target when the target does not have it.
- Local volumes are copied to the target. A running box is paused while they are copied. NFS volumes are attached on the target and not copied. The tools volume is replaced by the target's shared tools volume.
- The box is created on the target and started there if it was running. The box is removed from the old host only after it runs on the target. If any step fails before that, the move is undone and the box stays where it was.
- The box keeps its id, name, volumes, environment variables and history. Its writable layer, running processes and IP address are lost, as in a rebuild.
- Checkpoints stay on the old host.

Only the owner or an admin token can move a box. Boxes with bind-mount volumes, or with volumes another box also mounts, cannot be moved.

## See your hosts

The **Settings** page lists each host with its **Status**, its **Capacity**, and the number of **Boxes** on it. With more than one host:

- Each box names its host.
- The overview page shows a card for each host, with its status, latency, containers, and the CPU and memory its boxes reserve and use.
- The top bar can filter the list by host.
- A host that is offline shows its boxes as unreachable, and the rest of the list still loads.
- An agent host shows the agent's version and when it was last seen. If the agent speaks another protocol than this MiniBox, the host shows **Agent needs an upgrade**. Pull the latest `minibox-agent` image and recreate the container with the same data volume.

## Remove a host

Click **Remove** next to the host, and confirm. A host that still has boxes, volumes or checkpoints cannot be removed. The **local** host cannot be removed.

To stop an agent at once, click **Revoke** on its host first. Revoking disconnects the agent and blocks it from reconnecting. Its boxes and volumes stay on the machine, and the host stays listed as revoked until you remove it. Removing an agent host forgets its record, but the agent's container keeps running idle on the machine. Stop and remove that container on the machine with `docker rm -f`.

## Limits

- Port preview is not supported for boxes on a remote host. See [Port preview](port-preview.md).
- Each host keeps its own checkpoints, and they are not copied between hosts. To move one, [export](checkpoints.md#export-and-import) it, then import it and choose the other host. See [Checkpoints](checkpoints.md).
- A box cannot move to or from an agent host yet, because an agent does not copy images or volumes. Create the box on the agent host instead.
- Host-level CPU and memory use is shown for the local host only. A remote host shows the cores and memory that its engine reports, and the use of its own boxes.
- The command-line tool has no host commands. Use the console, or the [REST API](../reference/api.md).
- An [agent token](access-and-tokens.md) can be limited to specific hosts.

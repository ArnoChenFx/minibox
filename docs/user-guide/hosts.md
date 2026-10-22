# Hosts

A host is a Docker engine that MiniBox can run boxes on. The machine that runs MiniBox is always the host **local**. You can add other Docker engines, and choose the host when you create a box.

Each box records its host. Everything you do to a box runs on that host.

## Ways to connect to a host

| Endpoint | How MiniBox connects | What you need |
|---|---|---|
| `unix:///var/run/docker.sock` | A socket on this machine, or one mounted into the container | Nothing else |
| `tcp://host:2376` | The engine's TLS port, with mutual TLS in both directions | The CA that signed the engine's certificate, and a client certificate and key that the engine trusts. |
| `ssh://user@host` | The engine's Docker socket, forwarded over SSH. Only the SSH port must be open. | An SSH key that can log in as that user. The socket is `/var/run/docker.sock`, unless the path says otherwise. |

## Add a host

1. Click **Settings** in the sidebar, then open the **Hosts** section.
2. Click **Add host**.
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

In the create dialog, choose the **Host**. The default is **local**.

A box on another host needs its template image on that host's Docker engine. Build or copy the template there first. Templates are not copied between hosts.

## See your hosts

The **Settings** page lists each host with its **Status**, its **Capacity**, and the number of **Boxes** on it. With more than one host:

- Each box names its host.
- The overview page shows a card for each host.
- The top bar can filter the list by host.
- A host that is offline shows its boxes as unreachable, and the rest of the list still loads.

## Remove a host

Click **Remove** next to the host, and confirm. A host that still has boxes, volumes or checkpoints cannot be removed. The **local** host cannot be removed.

## Limits

- Port preview is not supported for boxes on a remote host. See [Port preview](port-preview.md).
- Each host keeps its own checkpoints, and they are not copied between hosts. To move one, [export](checkpoints.md#export-and-import) it, then import it and choose the other host. See [Checkpoints](checkpoints.md).
- Host-level CPU and memory use is shown for the local host only. A remote host shows the cores and memory that its engine reports.
- The command-line tool has no host commands. Use the console, or the [REST API](../reference/api.md).
- An [agent token](access-and-tokens.md) can be limited to specific hosts.

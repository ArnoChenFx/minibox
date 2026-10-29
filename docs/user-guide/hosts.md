# Hosts

A host is a Docker engine that MiniBox can run boxes on. The machine that runs MiniBox is always the host **local**. You can add other Docker engines, and choose the host when you create a box.

Each box records its host. Everything you do to a box runs on that host.

## Ids and names

A host has an **id** and a **name**. The id is the host's key: every API call, task, event, audit entry and command-line argument addresses a host by it, and nothing looks a host up by name. The name is only a label for people, the one the console shows and the one MiniBox writes into messages and logs.

No two hosts may hold the same name. MiniBox refuses a name another host already has when a host is added, when a pairing code is created, and when an agent pairs with it, with `409` and the key `host_name_taken`, which names the host that already uses it. A name is compared without its case, with spaces trimmed and in Unicode NFC, so `Lab` and ` lab ` count as the same name. A host added without a name takes its id as its name, and that fallback is checked the same way: while another host is called `lab`, a host with id `lab` and no name is refused with `host_name_taken_by_id`, which asks you to give it a name. A pairing code that has not been used yet holds its name too, so another host asking for it is refused with `host_name_pending`, which names the host the code is for. The rule exists so that the console and the logs never leave you guessing which machine an entry is about; it is not part of the data model, since ids are what identify a host.

MiniBox does not rename a host today, so the only way to free a name is to remove the host that holds it.

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
2. Choose **Agent (recommended)**, enter an **Id**, and optionally a **Name**. The name is only a label and no other host may hold it; omitted, the id is used.
3. Click **Create pairing command**. MiniBox shows a pairing code and a `docker run` command, one for bash and one for PowerShell.
4. Run the command on the machine. The agent exchanges the code for its own credentials, which it keeps in the `minibox-agent` volume, and it reconnects by itself after a restart.
5. The dialog closes when the agent connects. The host then shows as online, with the agent's version and when it was last seen.

The command runs the agent image at the tag of this MiniBox's own version, so the agent always speaks the protocol the console expects; a development build, which has no image tag of its own, uses `latest` and says so above the commands. Pair over https: over plain http only the agent's first handshake is signed, so anyone on the network path can read the code and inject commands afterwards. The dialog warns when the console is not on https.

A pairing code works once and expires after 10 minutes. MiniBox spends it as soon as it receives it, so if the agent loses the reply and cannot save its credentials, the code is no longer valid. Then remove the agent's container and create a new code. You can also ask for a new code before the old one expires, for example after closing the dialog: create it again with the same id. The new code replaces the old one, which then no longer pairs. Only the first start needs the code. For the options, the data volume and the operations an agent allows, see the [agent reference](../reference/agent.md).

## Add a host with a Docker address

1. Click **Settings** in the sidebar, then open the **Hosts** section.
2. Click **Add host**, and choose **Docker address**.
3. Fill in the form:
   - **Id**: lowercase letters, digits and hyphens, starting with a letter.
   - **Name**: a name you recognise, which no other host may hold. Omitted, the id is used.
   - **Endpoint**: one of the forms in the table above.
   - The credential fields that the endpoint needs: **CA certificate (PEM)**, **Client certificate (PEM)** and **Client key (PEM)** for `tcp://`, or **SSH private key (OpenSSH, no passphrase)** for `ssh://`.
4. Click **Test** first. MiniBox connects to the engine, reads its version and capacity, and shows the result. Nothing is saved.
5. Click **Add host**.

For an SSH host, MiniBox shows the host's key fingerprint, which starts with `SHA256:`. Compare it with the key on the machine itself. Then click **Trust and add**. Add the host only when the fingerprints match.

Credentials are saved on the MiniBox host, and the console never shows them again.

## Access to every host

With more than one host, this console is the entry to all of them. A Docker engine has the power of root on its machine, so anyone who signs in to this console can act on every host. Keep the owner key private, and give each [agent token](access-and-tokens.md) only the hosts it needs. The **Settings** page shows this warning while a host other than this machine is held.

## Create a box on another host

In the create dialog, choose the **Host**. The default is **local**. Choose **Auto** to let MiniBox pick: it uses the online host that holds the template and has the most CPU and memory left once the box is placed. When no host that holds an official template has room, the template is built on the online host with the most CPU and memory left that does not hold it yet. An agent token picks only among the hosts it is granted.

A box on another host needs its template image on that host's Docker engine. If the host does not have the template, MiniBox copies it there first. The create dialog says how large the copy is, the copy runs as a **Sync template** task, and the create waits for it to finish. To copy a template without creating a box, click **Copy here** on the template's card in the **Templates** tab of **Library**, or run `minibox template sync <ref> --host <id>`.

A copy sends the image the same way a move does, so the target engine must keep image IDs. See [Limits](#limits).

## Choose a host by labels

A host can carry labels, and a create can ask `auto` to place the box only on hosts that carry them. That is how a control plane with machines of different kinds says where a box belongs: one host has a GPU, another has more disk, a third runs on another architecture.

Give a host its labels in **Settings**, under **Hosts**, or through the API or the command-line tool:

```bash
minibox host labels set lab --label gpu=true --label org/arch=amd64
minibox host labels get lab
```

`PATCH /api/hosts/{id}` with `{ "labels": { "gpu": "true" } }` does the same, and an empty object clears the labels. `POST /api/hosts` takes `labels` when a host is added. A key is lowercase, and may name a namespace with one slash, as in `org/arch`; a value is a single line of at most 256 characters and may be empty. A host carries at most 32 labels.

The local host takes labels too, from two places:

- `HOST_LABELS` in `.env`, such as `HOST_LABELS=gpu,arch=amd64`, sets them at startup. MiniBox writes them into `hosts.json` under the id `local`, so the file is where they live.
- `PATCH /api/hosts/local`, or `minibox host labels set local`, changes them at any time. A local host that already carries labels keeps them at the next start, so an old `.env` never undoes a change you made in the console.

To place a box by labels, choose **Auto** as the host and name the labels. Through the API that is `hostLabels`, and on the command line it is one `--host-label` per entry:

```bash
minibox box create trainer --host auto --host-label gpu=true --host-label org/arch=amd64
```

```json
{ "name": "trainer", "cpus": 4, "memoryMb": 8192, "host": "auto", "hostLabels": { "gpu": "true" } }
```

The rules:

- Only the online hosts that carry **every** label are considered, and each value has to match exactly. `--host-label gpu` asks for a label named `gpu` whose value is empty.
- Everything else about **Auto** stays the same. Among the hosts that carry the labels, one that holds the template comes before one that does not, the roomiest of them wins, and only an owner's official template may be built on a host that lacks it.
- A host without the labels is never a candidate, however much room it has. A create that would otherwise have gone to it is refused instead.
- A create whose labels no online host carries is refused with `422` and the key `host_auto_no_label_match`, which names the labels. Nothing is created.
- Labels go with **Auto** only. A create that names a host and also sends labels is refused with `host_labels_need_auto`, since a named host is not filtered.
- Without `hostLabels` the placement is exactly what it was before labels existed.

## Capacity

With more than one host, MiniBox counts the CPU and memory that running boxes reserve on each host. A new box, a resize or a move that would reserve more than the host has is refused. `HOST_OVERCOMMIT` allows more, up to 10 times the host's capacity (see [Configuration](../reference/configuration.md)). A stopped box reserves nothing.

A host whose running boxes reserve more CPU or memory than its capacity times `HOST_OVERCOMMIT` is listed under **Needs attention** on the overview, with the booked total and the limit. Lowering `HOST_OVERCOMMIT`, or a host that reports a smaller engine after a restart, can put it there; the items clear once the reservations fit again. A figure the host does not report is not checked.

## Move a box to another host

1. Open the box and click **Move to host**. The button appears when there is more than one host.
2. Choose the target host, choose how the box travels, and click **Preview**. The preview lists the path, each volume and what happens to it, whether the template image is sent, and whether the box starts on the target. Nothing changes yet.
3. Click **Move box**. The move runs as a task in the task panel.

There are two paths, and the choice is the `via` field of `POST /api/boxes/:id/move`:

- **direct** (the default, and what MiniBox did before this path existed): the template image is sent to the target when the target does not have it, and the volumes are copied as archives.
- **checkpoint**: MiniBox checkpoints the box, copies the checkpoint to the target, restores the volumes, and removes the source box. The target still needs the template image; the checkpoint copy sends it when missing. Both hosts must support image transfer and checkpoint helpers.

Either way:

- The box is created on the target and started there if it was running. The box is removed from the old host only after it runs on the target. If any step fails before that, the move is undone and the box stays where it was, still running and still holding its volumes.
- The box keeps its id, name, volumes, environment variables and history. Its writable layer, running processes and IP address are lost, as in a rebuild.
- NFS and other shared-storage volumes are attached on the target and not copied. Their storage stays where it is, and the move does not remove the volume on the old host. The tools volume is replaced by the target's shared tools volume.

What differs between the two paths:

- A direct move leaves the box's checkpoints on the old host. The preview counts them. A checkpoint holds volume data, and copying every checkpoint would make a move slow. To keep one with the box, [copy it](checkpoints.md#copy-to-another-host) to the new host, or [export](checkpoints.md#export-and-import) it and import it there.
- A checkpoint move takes its own checkpoint for the transfer and removes it afterwards, on both hosts, so a move leaves no extra checkpoint behind. It carries only what a checkpoint holds: the workspace, the home, and any recorded volume the box mounts. A cache volume is made again empty on the target.
- Both paths keep a running source box paused until the move commits and its source container is removed. A failed move resumes the source. A stopped box stays stopped.

Refusals name why, in the message:

- A volume a checkpoint cannot read, such as a bind-mount volume, refuses a checkpoint move. Use **direct** for that box, which copies the volume as it is.
- A volume another box also mounts, and a volume the box mounts twice, refuse a checkpoint move: a copy carries one snapshot per volume, so it cannot carry another box's data or the same volume twice.
- An agent host on either side refuses both paths. An agent does not copy images, volumes or archives, and the helpers both paths run are refused there, so a move to or from one would fail half way. Create the box on the agent host instead.

Only the owner or an admin token can move a box.

### What to watch the first time

The CI suite moves boxes between two hosts with a fake engine and a fake snapshot engine: the previews, the refusals, the restored data, and every failure path are covered there. It does not run restic, a real engine, or two real machines. The first time you use the checkpoint path on real hardware, watch these in the task log:

- `Taking a checkpoint of …` then `Copying the checkpoint to …` — the pack and unpack run restic in a helper container on each host, so both hosts need the restic image pulled, which takes a few minutes the first time.
- `Restoring /workspace on …` and the volumes listed under it — the sizes restic reads are in the log, and the target needs that much free space.
- `Creating the box on …` — the target must hold the template. If no host can send it, the move is refused before any checkpoint is taken, so a refusal here means the copy landed without it.
- The finished task's `leftovers` — empty is the expected answer. A leftover volume or checkpoint could not be removed and is kept so you can remove it by hand.

## See your hosts

The **Settings** page lists each host with its **Status**, its **Capacity**, and the number of **Boxes** on it. With more than one host:

- Each box names its host.
- The overview page shows a card for each host, with its status, latency, containers, and the CPU and memory its boxes reserve and use.
- The top bar can filter the list by host.
- A host that is offline shows its boxes as unreachable, and the rest of the list still loads. MiniBox checks an offline host again in the background. Each failed check waits longer than the one before, up to about five minutes.
- An agent host shows the agent's version and when it was last seen. If the agent speaks another protocol than this MiniBox, the host shows **Agent needs an upgrade**. Pull the latest `minibox-agent` image and recreate the container with the same data volume.

## Engine storage

Each host's row on the **Settings → Hosts** page also says what its engine holds, as `docker system df` counts it: the bytes taken by images, containers, volumes and build cache, how many of each the engine has and how many are in use, and how much of each a removal would free. The reading is taken when the page opens, one request per host, and it never holds up the table: the rows draw first and the storage line fills in.

This is the engine's own accounting, not the host filesystem's. The free-space floor that MiniBox enforces on volumes and checkpoints is the filesystem figure, and the two can disagree: a host can have plenty of free space while Docker's own objects take most of the disk.

A class, or a figure, that the engine does not report is shown as unknown rather than as zero. Engines of different versions report different fields, and an engine that never measured a volume's size reports no size for it.

An **agent host has no such reading.** The agent carries the operations a box needs, and reading the engine's own storage is not one of them, so its row says so. A host that is offline, whose engine does not answer within the read timeout, or whose engine refuses the read says why in its own row, and every other host still shows its figures. MiniBox never prunes images, containers or build cache itself: the reading only tells you what is there.

## Remove a host

Click **Remove** next to the host, and confirm. A host that still has boxes, volumes or checkpoints cannot be removed. The **local** host cannot be removed.

An agent host has only **Remove**. Removing it revokes its agent first: the agent is disconnected at once and cannot reconnect, and MiniBox forgets its record. To use the machine again, pair it with a new code and a new data volume, as the [agent reference](../reference/agent.md#remove-revoke-upgrade-and-re-pair) describes. Removing deletes no container or volume on the machine, and the agent's container keeps running idle there. Stop and remove that container on the machine with `docker rm -f`.

To cut off an agent at once while its host still holds boxes, volumes or checkpoints, call `POST /api/hosts/{id}/revoke`. The endpoint is kept for this and for existing scripts. A revoked host stays listed, marked **Revoked**, until you remove it.

## Limits

- A copy or a move needs the target engine to keep image IDs. Docker's classic image store does. The containerd image store changes an image's ID when the image loads, so MiniBox refuses the copy with a `docker_error` that names both IDs. An engine on the containerd image store shows `driver-type io.containerd.snapshotter.v1` in `docker info`.
- Each host keeps its own checkpoints. To make one available on another host, [copy it](checkpoints.md#copy-to-another-host). The copy is a new checkpoint, and the original stays where it is. A checkpoint with a system layer cannot be copied yet.
- **Auto** only considers hosts that already hold the template, unless an owner's official template may be built on one. To say which hosts it may use, give them labels and pass `hostLabels`; without them it considers every online host.
- A box cannot move to or from an agent host yet, because an agent copies neither images nor volumes. With more than one host, the **Move to host** button of a box on an agent host is off, with the reason as its tooltip, and the API answers `501 move_agent_unsupported`. Create the box on the host you want it on. An agent host does not support templates, snapshots or port preview yet, so **Save as template** is off there too, and a box with a self token cannot be created on one, because an agent cannot write the token file.
- Host-level CPU and memory use is shown for the local host only. A remote host shows the cores and memory that its engine reports, and the use of its own boxes.
- The command-line tool's host commands read and set labels only: `minibox host labels get` and `minibox host labels set`. Adding and removing a host is done in the console or through the [REST API](../reference/api.md), and revoking one through the REST API.
- An [agent token](access-and-tokens.md) can be limited to specific hosts.

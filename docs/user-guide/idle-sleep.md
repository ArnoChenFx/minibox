# Idle sleep and TTL

A box can stop itself when nothing has used it for a while. This is called sleep. A sleeping box keeps its files, and it starts again when you use it. A box can also have a TTL, which is a lifetime. When the TTL ends, MiniBox stops the box.

## Idle sleep

- The administrator sets the default idle timeout with `BOX_IDLE_TIMEOUT_SEC`. The default is `0`, which means idle sleep is off.
- Each box can use the default timeout, or its own. The box's **Overview** tab shows its **Idle timeout**: **Global default**, **Never sleep**, or the box's own number of seconds.
- A box sleeps when all of these are true:
  - Nothing is using it.
  - Nothing has used it for at least the timeout.
  - Its recent CPU use is below the threshold that the administrator sets with `BOX_IDLE_CPU_PERCENT`.

### What counts as use

These keep a box awake:

- An open browser terminal, whether you opened it or someone attached to a session from outside MiniBox.
- An open SSH connection. Typing over it counts too.
- A command that `exec` is running.
- A session that you start, read or send input to.
- A port preview that is loading, or a preview WebSocket that is open.
- A file request for a volume that the box mounts, while the request runs.
- A task that is running for the box, such as a checkpoint.

Looking at a box does not count as use. Reading its details, stats or logs does not keep it awake.

A session with no client attached does not keep its box awake. If a background job runs in a session that nobody is watching, it ends when the box sleeps. Run long jobs as a background `exec`, or keep a terminal open.

A [startup command](boxes.md#startup-command) runs in a session named `minibox-init`, and it follows the same rule. It does not keep its box awake, and it ends when the box sleeps. Running it again by hand, with **Run again**, **Run it now as well** or `minibox box startup-command run`, restarts the idle timer, as an `exec` does.

### Waking a box

- `exec` starts a stopped box.
- An SSH connection starts a stopped box.
- Starting a session starts a stopped box.
- Opening a terminal wakes a box that is asleep. A box that you stopped by hand does not wake from a terminal. The terminal says that the box is not running, and it offers to start the box.
- A port preview wakes a box that is asleep, but not one that you stopped.
- Reading, sending to, closing or listing sessions does not wake a box.
- Reading or changing files in a volume never starts a box.
- A box that wakes runs its startup command again. See [Startup command](boxes.md#startup-command).

## TTL

A TTL is a lifetime that starts when the box is created. When the TTL ends, MiniBox stops the box and does not delete it. The box's status then shows **TTL expired**.

A box whose TTL has ended does not start again. Starting, restarting, rebuilding, running commands and opening terminals or previews all fail until the TTL is cleared or set later. Clear it or set a later TTL, and then start the box.

The create dialog has no TTL field. The console shows the TTL and the idle timeout of each box, but it does not change them. Set them with the [REST API](../reference/api.md).

## Status labels

| Label | Meaning |
|---|---|
| **Sleeping** | The box stopped because it was idle. |
| **TTL expired** | The box's TTL has ended. |

The box page also shows the box's last activity time.

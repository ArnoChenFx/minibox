# Idle sleep and TTL

A box can stop itself when nothing has used it for a while. This is called sleep. A sleeping box keeps its files, and it starts again when you use it. A box can also have a TTL, which is a lifetime. When the TTL ends, MiniBox stops the box.

## Idle sleep

- The administrator sets the default idle timeout with `BOX_IDLE_TIMEOUT_SEC`. The default is `0`, which means idle sleep is off.
- Each box can use the default timeout, or its own. The box's **Settings** tab, under **Lifecycle**, shows and changes its **Idle timeout**: **Global default**, **Never sleep**, or the box's own number of seconds.
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

The create dialog has no TTL field. Change both the idle timeout and the TTL in the console: open the box, then **Settings** and **Lifecycle**, and click **Edit** on the lifecycle card. The idle timeout is **Global default**, **Never sleep** or the box's own number of seconds, and the TTL is **No TTL** or a lifetime, entered with a unit such as 30 minutes or 2 hours. **Save** applies the change at once, with no rebuild. A box that is already stopped stays stopped, and a TTL that has already ended keeps the box stopped until it is cleared or set later.

The same two fields are in `PATCH /api/boxes/{id}` (`idleTimeoutSec` and `ttlSec`) for scripts and agents. See the [REST API](../reference/api.md).

## Status labels

| Label | Meaning |
|---|---|
| **Sleeping** | The box stopped because it was idle. |
| **TTL expired** | The box's TTL has ended. |

The box page also shows the box's last activity time.

# Terminals and sessions

Each box has a terminal in your browser. The terminal runs a shell as the user `dev`, in the `/workspace` folder.

Terminal work happens in sessions. A session is a named tmux session inside the box. A session keeps running when you close the page, and it reopens where you left it when you come back. A session ends when you close it, or when the box stops.

## Open a terminal

1. Open the box, and click the **Terminal** tab.
2. If the box is stopped, click **Start box**.

If the box is asleep, the terminal wakes it. A box that you stopped by hand does not wake from a terminal. See [Idle sleep and TTL](idle-sleep.md).

## Start a new session

1. On the **Terminal** tab, click **New session**.
2. In **Session name**, type a name. Use up to 32 letters, digits, dashes and underscores.
3. Click **New session**.

The session name is how you find the session again. The **Sessions** list shows every session in the box. Each session is marked with who created it: **Created by you** for a session you started in the console, or **Created by agent** for one that an agent or another client started through the API. The session that runs the box's startup command, `minibox-init`, carries no mark, so it also shows **Created by agent**.

To end a session, click **Close session**, and confirm. Programs that run in the session stop.

A box can have up to 16 sessions. Each session can have up to 8 terminals open at the same time.

## Sessions that an agent drives

An AI agent can start its own sessions in a box. These sessions are called agent sessions.

- An agent session opens read-only in the console. The **Terminal** tab shows **Agent is driving**, with the note "Read-only while the agent drives. Take over to type."
- To type in the session, click **Take over**.
- To give the session back to the agent, click **Return to agent**.

A session that you take over returns to the agent automatically, after a period without any input from you. The administrator sets this period with `SESSION_TAKEOVER_IDLE_SEC`. The default is 300 seconds. If the period is `0`, the session stays with you until you return it.

A session that you started yourself stays with you. Return it to the agent when you want the agent to type in it.

While you hold a session, the agent can still read its screen, but the agent's input is refused until you return the session.

Restarting MiniBox returns every session to its starting control: the agent for agent sessions, and you for sessions you started.

## Use sessions from the command line

```bash
minibox session ls my-box
minibox session start my-box build
minibox session read my-box build --lines 50
minibox session send my-box build --text "npm test"
minibox session send my-box build --key Enter
minibox session close my-box build
```

See the [CLI reference](../reference/cli.md) for every option.

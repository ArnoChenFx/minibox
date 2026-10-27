# Terminals and sessions

Each box has a terminal in your browser. The terminal runs a shell as the user `dev`, in the `/workspace` folder.

Terminal work happens in sessions. A session is a named tmux session inside the box. A session keeps running when you close the page, and it reopens where you left it when you come back. A session ends when you close it, or when the box stops.

## Open a terminal

1. Open the box, and click the **Terminal** tab.
2. If the box is stopped, click **Start box**.

If the box is asleep, the terminal wakes it. A box that you stopped by hand does not wake from a terminal. See [Idle sleep and TTL](idle-sleep.md).

## Type on a phone

A phone's on-screen keyboard has no Esc, no Ctrl, no Tab and no arrow keys. On a screen 640 pixels wide or narrower, the terminal ends in a row of keys for them, so a phone can drive the same programs a desktop does.

- **Esc**, **Tab** and the four arrow keys send what the keys of the same name send on a keyboard.
- **Ctrl** is a modifier. Press it once and it stays on, drawn in the accent colour, and the next character typed goes out as its control character: **Ctrl** then `c` sends Ctrl-C, and **Ctrl** then `[` sends Esc. It turns off by itself after that character, and pressing **Ctrl** again turns it off.
- **^C** and **^D** send Ctrl-C and Ctrl-D directly, since those are the two a terminal needs most.

The keys send to the session on screen, so they work only while you can type in it: a session an agent holds shows them greyed out until you take it over. Pressing a key does not put the on-screen keyboard away, and what you type next still goes to the terminal. Above 640 pixels there is no row, because a desktop keyboard already has every key.

## Start a new session

1. On the **Terminal** tab, click **New session**.
2. **Session name** already holds a name, so you can click **New session** (or press Enter) straight away. To choose your own, type over it. A name is up to 32 letters, digits, dashes and underscores.
3. Click **New session**.

The name the dialog fills in is the next free one in a series: `console` while the box has no session of that name, then `console-2`, `console-3`, and so on. The box's own first session is `console`, so a box you have already opened a terminal in offers `console-2`. Opening the dialog twice therefore never offers the same name, and the names read as a series rather than as random text.

A name is checked inside the dialog, before anything is sent. A name that is already in the box, in any capitalisation, says so under the field as you type, and a name the server would refuse, such as one with a space in it or one longer than 32 characters, is marked the same way. Clearing the field is refused too: the dialog is where a name is chosen, so an empty name is never sent. The server checks the name again, and if it refuses it the message appears as a notification.

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

## Watch an agent on the overview

The **Overview** page lists the boxes that an agent worked on in the last 10 minutes, under **In progress**. A row shows the box, who acted (the name of the access token, or the box's own agent), and the agent's latest command. While the command still runs, the row also shows its last three lines of output. The row names the session the agent used last.

- **Observe** opens that session read-only.
- **Take over** opens the same session. The overview does not take it over. Click **Take over** on the **Terminal** tab to type.

A command that ran outside any session has only **Observe**. It opens the box's **Activity** tab, which lists the command.

Each session has its own address, and the address ends with the session's name. When you pick another session in the list, the address changes to it, so a reload or a shared link opens that session.

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

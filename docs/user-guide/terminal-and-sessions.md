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

## Change the terminal's height

In a desktop browser, on a window wider than 900 pixels, the terminal takes the room the page actually leaves instead of a fixed 460 pixels, so by default the whole screen — and the grabber under it — is inside the window, and the band of empty page that used to sit under it on a 1080p or 1440p screen is part of the terminal. The panel measures that room when the terminal opens and again whenever the window changes: the window's height, less where the screen starts and less what the page draws under it (the grabber, the help line, the page's bottom padding). The default is `clamp(460px, that room, 980px)`:

- A 1920×1080 screen leaves 663 pixels, so the terminal opens at 663 and the whole page fits the window without scrolling.
- A 1440×900 window leaves 435 pixels, so the terminal opens at the 460 pixels it always had, and the screen and the grabber both end inside the window.
- A 1280×800 window leaves 335 pixels, which is not enough even for the old 460 pixels. The terminal then opens at 460 and the page scrolls, exactly as it did before this change.

The page still scrolls up and down as it always did; it is not a fixed app layout.

The terminal frame ends in a grabber, a short bar you can drag to the height you want: drag it down to make the terminal taller, or up to make it shorter, anywhere between 240 pixels and 120 pixels past the default. A drag may take the screen past the bottom of the window, which is how you ask for more lines than fit on screen. The grabber also works from the keyboard:

- With the focus on the grabber, **↑** makes the terminal 24 pixels taller and **↓** 24 pixels shorter.
- **Home**, **End** or **Enter** restores the default height, and so does a **double click** on the grabber with the mouse.
- **Tab** reaches the grabber, which draws a visible outline while it has the focus. A drag does not take the terminal's input focus away, so you can type in the terminal again as soon as it ends.

While you drag, the terminal reworks its columns and rows to the new height (xterm's FitAddon) and sends the new size to the tmux session in the box, so the programs in it see the new window size.

A height you set is remembered in this browser on this machine (`localStorage`, key `minibox:termHeight:v1`), so a reload, another box or another session opens at it, and it is never sent to the server. A window made smaller than the height you picked clamps it to what the page leaves, and a window that grows back gives the rest of it back. A double click, or Home/End, forgets it, and the terminal follows the room the page leaves again.

A phone (640 pixels and narrower) has no grabber: its terminal keeps `min(52vh, 340px)`, and the key row, the keyboard's room and the scrolling behave exactly as before. A window between 641 and 900 pixels keeps the 460 pixels it had.

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

# Environment variables and secrets

Environment variables are settings that a box's programs read when they start, such as `NODE_ENV` or an API URL. A secret is a value that MiniBox stores on the host, and passes to a box without showing it again.

## Set variables for a box

You can set variables when you create a box, or later in the box's **Settings** tab, under **Environment variables**.

- In the create dialog, open **Environment variables**. The section is collapsed by default.
- In the box's **Settings**, the **Environment variables** section lists the box's variables. Edit them there, and click **Save**.

Each row has a name and a value. Plain values are masked in the box's details until you choose **Show value**.

Saving in **Settings** stages the environment instead of rebuilding at once. The card marks the variables **Pending**, and the banner above the settings applies them with any other staged change; the box is rebuilt then, so its writable layer and running processes are lost at that point. See [Stage a change and rebuild](boxes.md#stage-a-change-and-rebuild).

## Use a secret

Store the secret once, and then refer to it by name from any box.

1. Click **Settings** in the sidebar.
2. In the **Secrets** section, click **Add secret**.
3. In **Name**, type a name, such as `OPENAI_API_KEY`. Use letters, digits, dots, underscores and hyphens.
4. In **Value**, paste the secret. MiniBox stores it, and does not show it again.
5. Click **Save secret**.

In a box's environment list, a secret appears as the name with a lock, such as `🔒 secret: OPENAI_API_KEY`. The box gets the value when it is created or rebuilt.

To change a secret's value, click **Replace** next to it. The new value reaches a box on its next rebuild or create, not when the box starts.

To delete a secret, click **Delete**. If a box uses the secret, MiniBox lists the boxes that use it. Click **Delete anyway** to delete it anyway. Those boxes cannot be rebuilt or started until you add the secret again.

## Rules for secrets

- **A missing secret stops the box from being created, rebuilt or started.** MiniBox does not start a box with an empty value.
- **Snapshots, templates and checkpoints with system layers refuse secrets.** Saving a box that holds a secret as a template fails. Remove the secret from the box first.
- **Only the owner and tokens with the `secret:use` scope can refer to a secret.** Only the `admin` preset has that scope. A repository clone at box create refers to a secret too, when it names one.
- **Anyone who can run commands in a box can read its environment.** This includes `exec`, SSH and the terminal. Give those permissions only for boxes that should hold the secret.
- **Keep secrets out of a startup command.** The command's text is visible in `ps` while it runs. Give the box the value as a variable or a secret, and read it from the environment. See [Startup command](boxes.md#startup-command).
- **Secret values never appear in events, the audit log or the server log.** They show only the name.
- **Names that start with `target.` are reserved.** They hold the credentials of [off-site targets](../admin/backups.md#off-site-targets). They do not appear in the list of secrets, and a box cannot use them.

## Limits

- A box can have up to 64 variables.
- A variable name starts with a letter or an underscore. It continues with letters, digits or underscores, and can be up to 128 characters long.
- A plain value can be up to 8192 characters long. It cannot contain control characters.
- A secret value can be 1 to 8192 characters long. It cannot contain line breaks or other control characters.

# Templates

A template is the starting point for a new box. It holds the box's system files, such as the operating system, the installed programs and the settings in `/etc`. Each new box starts from a template.

A template does not include your files. The `/workspace` folder and the home folder are volumes, and a template leaves them out. Keep your code in git, or back up the volumes separately.

## The base template

MiniBox ships a bundled base template that you build on the **Templates** page.

The base template contains:

- Debian 12 and Node.js 26.
- Python 3, `git`, `curl`, `build-essential`, `tmux`, `jq`, `ripgrep`, `openssh-client`, `sudo` and other common tools.
- The user `dev`, user ID 1000, with passwordless `sudo`.

The MiniBox image does not include the base template. Build it once from the console:

1. Click **Templates** in the sidebar.
2. Click **Build base template**.
3. Wait for the build to finish.

To follow the build, click **Tasks** in the top bar. Build the base template again whenever you want to update it.

## Save a box as a template

Save a box as a template when you have installed software into the box, and you want new boxes to start with it.

1. Open the box.
2. Click **Save as template**.
3. Enter a **Name**, such as `python-ml`. Add a **Description** if you like.
4. Click **Save template**.

MiniBox saves the container's system layer: files changed outside the volumes, such as software installed as root and settings under `/etc`. It does not include `/workspace`, the home folder, or tools installed only into home.

Saving can take a while. Follow the progress in the **Tasks** panel.

A box whose environment references a host secret cannot be saved as a template, and the same rule applies to a snapshot or checkpoint that includes a system image. Remove that environment variable first. See [Environment variables and secrets](environment-and-secrets.md).

## Create a box from a template

1. Click **Boxes**, then **Create box**.
2. In **Template**, choose the template.
3. Finish the form, and click **Create and start**.

You can also click **Create from this** on a template's card in the **Templates** list.

## Built-in and custom templates

The **Templates** page lists two kinds of template:

- The **Built-in** label marks the bundled base template.
- **Custom** templates are the ones that you saved from a box.

Deleting a template does not affect the boxes that you created from it. A template that you built in the console can be built again on the same page.

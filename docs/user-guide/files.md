# Files

The **Files** tab on a box's page browses the files in the box's volumes: the workspace, the home folder and any other volume the box mounts. The tab works while the box is stopped, because MiniBox reads and writes the volume through a short-lived helper container. [Volumes and storage](volumes-and-storage.md) explains volumes.

**An agent host does not support this tab.** It reads and writes the volumes through a short-lived helper container, and an agent host runs boxes only, so it cannot start one. The tab stays in the strip and says so instead of offering a listing. A box cannot move off an agent host yet, so to browse files, create the box on a host MiniBox reaches directly.

The tab shows volumes only. Files that a box writes outside a volume, such as the packages it installs with `apt install`, are not listed. Use the [terminal](terminal-and-sessions.md) to work with those.

## Browse

- Open a box, and click **Files**.
- Use the **Volume** picker to choose a volume. Each choice shows its mount path and its role, and says **Read-only** when the mount is read-only. The tab opens on `/workspace` when the box has a workspace volume.
- Click a folder to open it. The breadcrumbs above the list show where you are. Click any part of the path to go back to it.
- Click a column heading to sort by **Name**, **Size** or **Modified**. Folders stay first. Click the same heading again to reverse the order.
- Type in **Filter files** to show only the names that contain the text. The filter ignores case.
- Names that start with a dot (hidden files) are shown by default. Turn off **Show hidden files** to hide them. The setting is not saved, so it is back on the next time you open the page.
- A folder lists up to 2,000 entries. When a folder has more, the list says that some entries are missing. Open a subfolder to see the rest.

## Copy a path

- Click the copy icon on a row to copy the path the box sees: the volume's mount path followed by the path inside it. A file `src/main.ts` in the workspace mounted at `/workspace` copies as `/workspace/src/main.ts`, a folder as its own path, and the volume's root as the mount path.
- The copy takes the path as it is, so it can be pasted into the box's [terminal](terminal-and-sessions.md) or into a command run over [SSH and the CLI](ssh-and-cli.md) without adding the mount path by hand.
- The icon is the button's whole label; the words are its tooltip and its accessible name. On a phone the row keeps the name readable by dropping the size column instead of the actions.

## Preview and download

- Click a file's name, or its eye icon, to preview it. A preview shows the start of a file of up to 256 KiB as text. A file that is not UTF-8 text cannot be previewed, so download it instead.
- Click the download icon on a file to download it as it is.
- Click the download icon on a folder to download it as `<name>.tar.gz`.
- A symbolic link is shown as a link. It is not followed, so you cannot open or download its target from here.

## Upload

- Drag files or folders onto the Files panel, or click **Upload files** or **Upload folder**. A folder is uploaded with everything in it.
- Files upload one at a time into the folder you are in. A progress bar shows how many files are done and how many bytes have been sent. Click **Cancel upload** to stop. Files that finished before you cancelled stay in place.
- If a name already exists in the folder, MiniBox lists those names and asks once, before it sends anything. Click **Replace** to overwrite them, **Skip them** to upload only the new files, or **Cancel** to upload nothing.
- A file larger than `FILE_UPLOAD_MAX_MB` is refused, and the message gives the limit. The default is 1024 MB. See [Configuration](../reference/configuration.md).
- Uploaded files and folders belong to the box's `dev` user, which is uid 1000.

## Create, rename and delete

- **New folder** creates a folder in the current folder.
- **Rename** changes the name of a file or folder in place. A name cannot be `.` or `..`, cannot contain `/` or a control character, and can be at most 255 bytes.
- **Delete** asks you to confirm first. The dialog says whether the item is a file or a folder. A folder is deleted with everything in it, and a delete cannot be undone. The root of a volume cannot be deleted here. To remove a whole volume, see [Delete a volume](volumes-and-storage.md#delete-a-volume).

## Paths and safety

- Paths are relative to the root of the volume. A path that climbs out of the volume with `..` is refused.
- A symbolic link that points inside its volume is followed. A symbolic link that points outside it is refused.
- Every upload is written under a temporary name first, then moved into place. An upload that fails does not leave a partial file under the final name.

## Command line and API

The same operations work from a terminal, whether the box is stopped or running:

```bash
minibox upload ./site mybox:/workspace/
minibox download mybox:/workspace/report.txt
minibox cp mybox:/workspace/report.txt ./report.txt
```

Add `--overwrite` to replace existing files. See [Copy files to and from a box](../reference/cli.md#copy-files-to-and-from-a-box) in the CLI reference, and the [files endpoints](../reference/api.md#files) in the REST API reference.

## Limits

| Limit | Value | Setting |
|---|---|---|
| Upload size | 1024 MB by default | `FILE_UPLOAD_MAX_MB` |
| Text preview | 256 KiB | Fixed |
| Entries in one folder | 2,000 | Fixed |

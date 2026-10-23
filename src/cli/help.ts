import { DEFAULT_URL } from "./shared";

export const HELP = `minibox — control a MiniBox server

Environment:
  MINIBOX_URL          Server URL (default ${DEFAULT_URL})
  MINIBOX_ACCESS_KEY   Access key. ACCESS_KEY is used when MINIBOX_ACCESS_KEY is unset.
  MINIBOX_TOOLSETS     Toolsets for \`minibox mcp\` (for example core,session)

Commands:
  minibox box ls [--json]              List boxes
  minibox box list [--json]            Same as box ls
  minibox box create <name> [--template IMAGE] [--cpus N] [--memory MB] [--profile P]
                       [--egress open|none|proxy-only [--egress-preset NAME] [--egress-domain HOST]...]
                       [--repo URL [--branch BRANCH] [--secret NAME]]
                       [--startup-command TEXT | --startup-command-stdin] [--self-token] [--no-wait] [--json]
                                       Create and start a box. --repo clones into /workspace on the first create.
                                       A devcontainer.json template runs its postCreateCommand once, after the clone.
                                       A startup command runs at every start of the box. --self-token gives the box's
                                       agent a token for this box alone, in /run/minibox/self-token.
  minibox box startup-command get <box> [--json]
                                       Print the startup command; its status and last output lines go to stderr
  minibox box startup-command set <box> (--command TEXT | --stdin) [--apply] [--json]
                                       Set the command. It runs at the next start, or now with --apply on a running box
  minibox box startup-command rm <box> [--json]
                                       Remove the command. A run already going keeps going until the box stops
  minibox box startup-command run <box> [--json]
                                       Run the command again now. The box must be running and have a command
  minibox template create <name> (--dockerfile FILE | --repo URL | --context URL | --devcontainer URL)
                       [--description TEXT] [--host ID] [source options] [--no-wait] [--json]
                                       Build a template in the background, and print its ref. --host builds it on that host
  minibox template rebuild <ref> [--host ID] [--no-wait] [--json]
                                       Rebuild a template from the source it was built from
  minibox template sync <ref> --host ID [--no-wait] [--json]
                                       Copy a template from a host that holds it to ID, so a box can start there
  minibox image pull <ref> [--host ID] [--no-wait] [--json]
                                       Pull an image from its registry, when the engine does not have it
  minibox trash ls [--json]            List the recycle bin: deleted boxes and volumes, kept until they expire
  minibox trash restore <id> [--name NAME] [--cpus N] [--memory MB] [--no-wait] [--json]
                                       Restore an entry as a new box or volume, and remove the entry
  minibox trash purge <id> [--no-wait] [--json]
                                       Remove an entry and the data it keeps, before it expires
  minibox exec <box> [options] -- <argv...>
      --cwd DIR         Working directory (default /workspace)
      --user USER       Container user (default dev; the strict profile allows only dev or 1000)
      --timeout SEC     Stop the process tree after SEC seconds (default 30; at most 55 unless --background)
      --env K=V         Environment variable (repeatable). The value is not logged.
      --stdin TEXT      Write TEXT to stdin, then close it
      --background      Return an exec id without waiting
      --wait MS         With --background, long-poll once for up to MS milliseconds
  minibox session ls <box> [--json]    List the terminal sessions of a box
  minibox session start <box> <name>   Start a session, or return the one that exists
  minibox session read <box> <name> [--lines N] [--since CURSOR] [--json]
                                       Print the screen; the cursor goes to stderr
  minibox session send <box> <name> (--text TEXT | --key KEY ...)
                                       Type text, or press tmux key names in order
  minibox session close <box> <name>   End a session
  minibox files ls <volume> [--path DIR] [--depth N] [--limit N] [--json]
  minibox files read <volume> <path> [--encoding utf-8|base64]
  minibox files write <volume> <path> (--content TEXT | --stdin) [--encoding utf-8|base64]
  minibox files cp <volume> <from> <to>
  minibox files download <volume> [path]   Print a base64 tar of the path
  minibox files upload <volume> [path]     Read a base64 tar from stdin and extract
  minibox cp <from>... <to> [--overwrite]  Copy between this machine and a box: box:/path names a path in the box
  minibox upload <local>... <box>:<path> [--overwrite]
                                       Upload files or folders into a box. Several sources, or a path ending in /, take
                                       the file names into that folder. A folder is uploaded with its tree.
  minibox download <box>:<path> [local] [--overwrite]
                                       Download a file, or a folder as <name>.tar.gz, into local (default: this folder)
  minibox tool custom list [--json]    List the custom tool entries in DATA_DIR/tools.d (owner only)
  minibox tool custom put <id> (--file FILE | --stdin) [--override-builtin] [--json]
                                       Save an entry from a JSON document (owner only)
  minibox tool custom delete <id> [--json]
                                       Remove an entry from tools.d; nothing is uninstalled
  minibox token create <name> [--preset P] [--scopes LIST] [--expires-in SEC] [--json]
                                       Print a new agent token's secret once. The preset defaults to sandboxed-agent.
  minibox mcp [--toolsets LIST]        Proxy stdio JSON-RPC to /mcp
  minibox ssh-config [--append] [--url URL] [--token KEY]
                                       Print the ~/.ssh/config block and host key pin. --append writes both and saves
                                       the server and key for ssh-proxy. --token leaves the key in shell history.
  minibox ssh-proxy <box>              Carry one SSH connection over stdio (the ProxyCommand from ssh-config)
  minibox backup [--out FILE] [--overwrite] [--passphrase-stdin] [--json]
                                       Back up DATA_DIR while MiniBox runs. Sealed with MINIBOX_BACKUP_PASSPHRASE
                                       (or --passphrase-stdin). --out saves the archive here after a size/checksum check.
  minibox backup ls [--json]           List the backups kept on the server
  minibox backup rm <id> [--json]      Delete a backup kept on the server
  minibox restore <file> --data-dir DIR [--passphrase-stdin]
                                       Restore offline into an empty DATA_DIR. The passphrase is
                                       read as for backup.
  minibox --version                    Print the MiniBox version this CLI was built from

Every command takes --help. Install this CLI from the server: curl -fsSL <MINIBOX_URL>/cli/install.sh | sh
On Windows, in PowerShell: irm <MINIBOX_URL>/cli/install.ps1 | iex
A foreground exec may use --timeout up to 55 seconds. Longer commands use --background with a larger --timeout.
The process exit code is the command's exit code, 124 when the command times out, 1 on an API error, and 2 on usage.
exec can read and write every volume mounted on the box.
File commands work on volumes (including when no box is running) via a helper container and the Docker archive API.
cp, upload and download reach a box's volumes the same way, so they work while the box is stopped. Symbolic links in an
uploaded folder are skipped, and an existing file is kept unless --overwrite is given.
files:* scopes only matter for a token that does not have exec.
A session is a tmux session in the box. A person can take it over in the console, and then session send fails with taken_over; session read still works.
Template source options: --branch and --secret with --repo or --devcontainer; --subdir and --dockerfile-path with --repo;
--dockerfile-path with --context; --devcontainer-path with --devcontainer. --dockerfile - reads the Dockerfile from stdin.
A command that starts a task waits for it and prints the task log to stderr. --no-wait prints the task id and returns at once.
`;

/** `--help` anywhere before a `--`, so `minibox exec box -- npm --help` still runs npm. */
export function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).includes("--help");
}

import agent from "./en/agent.js";
import boxDetail from "./en/box-detail.js";
import boxes from "./en/boxes.js";
import checkpoints from "./en/checkpoints.js";
// UI strings. Flat keys shared by en.js and zh-CN.js; `{name}` marks a placeholder.
import common from "./en/common.js";
import egress from "./en/egress.js";
import errors from "./en/errors.js";
import files from "./en/files.js";
import settings from "./en/settings.js";
import tasks from "./en/tasks.js";
import tools from "./en/tools.js";
import trash from "./en/trash.js";
import volumes from "./en/volumes.js";

export default {
  ...common,
  ...egress,
  ...errors,
  ...boxes,
  ...boxDetail,
  ...agent,
  ...checkpoints,
  ...volumes,
  ...files,
  ...tasks,
  ...tools,
  ...trash,
  ...settings,
  // tests/template.test.ts reads this file for the Node.js major, so the templates group stays here.
  "tp.subtitle":
    "Templates hold the environment new boxes start from. Save a box as a template, or build the bundled base template.",
  "tp.build": "Build base template",
  "tp.search": "Search templates",
  "tp.searchPlaceholder": "Name, tag, description or image ID",
  "tp.noMatch": "No matching templates",
  "tp.noMatchText": "No template matches “{q}”.",
  "tp.loadFailed": "Couldn't load templates",
  "tp.empty": "No templates yet",
  "tp.emptyText":
    "Build the bundled base template (Debian 12 · Node.js 26 · Python 3 · git · tmux · non-root dev user). The first build takes about 1–3 minutes.",
  "tp.builtin": "Built-in",
  "tp.custom": "Custom",
  "tp.noDesc": "No description",
  "tp.image": "Image",
  "tp.size": "Size",
  "tp.created": "Created",
  "tp.delete": "Delete template",
  "tp.use": "Create from this",
  "tp.fromBox": "From box {name}",
  "tp.saveAction": "Save as template",
  "tp.saveTitle": "Save as template",
  "tp.saveDesc": "Save “{name}” as a template that new boxes can start from.",
  "tp.namePlaceholder": "e.g. python-ml",
  "tp.description": "Description",
  "tp.saveScope":
    "Saves the container's system layer: files changed outside the volumes, such as software installed as root and settings under /etc. /workspace and home volumes (including tools installed into home) are not included; use a checkpoint for data.",
  "tp.saveConfirm": "Save template",
  "tp.saving": "Saving…",
  "tp.saveStarted": "Saving box as template",
  "tp.saved": "Template saved",
  "tp.openTemplate": "Open template",
  "tp.saveFailed": "Couldn't save as template",
  "tp.buildStarted": "Building base template",
  "tp.buildStartedText": "The first build downloads images and takes about 1–3 minutes.",
  "tp.buildDone": "Base template built",
  "tp.buildFailed": "Build failed",
  "tp.deleteMessage": "Delete template <code>{ref}</code>? {extra}Boxes created from it are not affected.",
  "tp.deleteBaseExtra": "You can rebuild it on this page. ",
  "tp.deleteExtra": "This can't be undone. ",
  "tp.deleted": "Template deleted",
  "tp.new": "New template",
  "tp.newTitle": "New template",
  "tp.newDesc":
    "Build a template image from a Dockerfile, a repository, a build context or a devcontainer.json. The build log opens in the Tasks panel.",
  "tp.newName": "Template name",
  "tp.newDescription": "Description",
  "tp.sourceKind": "Source",
  "tp.kindDockerfile": "Dockerfile",
  "tp.kindGit": "Git repository",
  "tp.kindContext": "Build context URL",
  "tp.kindDevcontainer": "devcontainer.json",
  "tp.kindDockerfileHint": "Paste the text",
  "tp.kindGitHint": "Clone, then build",
  "tp.kindContextHint": "Archive from a URL",
  "tp.kindDevcontainerHint": "Read the repository's config",
  "tp.kindHelpDockerfile": "Sent as typed. Use FROM to choose the base image. At most 64 KB.",
  "tp.kindHelpGit":
    "MiniBox clones the repository and builds from the subdirectory you give. A rebuild fetches the newest commit of the branch.",
  "tp.kindHelpContext":
    "MiniBox downloads a .tar or .tar.gz build context and builds from it. A rebuild downloads it again.",
  "tp.kindHelpDevcontainer":
    "MiniBox reads image, build.dockerfile, build.context, build.args and containerEnv. It refuses other settings and never runs lifecycle commands such as postCreateCommand.",
  "tp.dockerfile": "Dockerfile",
  "tp.dockerfileHelp": "Sent as typed. Use FROM to choose the base image. At most 64 KB.",
  "tp.contextUrl": "Build context URL",
  "tp.contextHelp": "An http or https link to a .tar or .tar.gz archive, at most 256 MB.",
  "tp.devcontainerPath": "devcontainer.json path",
  "tp.devcontainerPathHelp":
    "Relative to the repository. Defaults to .devcontainer/devcontainer.json, then .devcontainer.json.",
  "tp.submitBuild": "Build template",
  "tp.starting": "Starting…",
  "tp.createStarted": "Building template",
  "tp.createStartedText": "Watch the build log in the Tasks panel.",
  "tp.builtFrom": "Built from {kind}",
  "tp.errDockerfile": "Paste a Dockerfile first.",
  "tp.errKind": "Choose a source.",
  "tp.pull": "Pull image",
  "tp.pullTitle": "Pull image",
  "tp.pullDesc": "Download an image to this host so templates and boxes can use it without waiting.",
  "tp.pullLabel": "Image",
  "tp.pullHelp": "A name with an optional tag, such as node:24-bookworm-slim. The pull runs as a task.",
  "tp.errImageRef": "Enter an image name, such as node:24-bookworm-slim.",
  "tp.pullStarted": "Pulling image",
  "tp.pullFailed": "Couldn't pull image",
  "tp.rebuild": "Rebuild",
  "tp.rebuildStarted": "Rebuilding template",
  "tp.rebuildStartedText": "Watch the build log in the Tasks panel.",
  "tp.rebuildFailed": "Couldn't rebuild template",
  "tp.hosts": "Hosts",
  "tp.present": "Present",
  "tp.absent": "Missing",
  "tp.copyHere": "Copy here",
  "tp.hostOffline": "This host is not online.",
  "tp.syncStarted": "Copying template",
  "tp.syncStartedText": "Watch the copy in the Tasks panel.",
  "tp.syncFailed": "Couldn't copy template",
  "tp.deleteHostsExtra": "Removes the copy on {hosts}. ",
};

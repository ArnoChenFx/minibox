import agent from "./en/agent.js";
import boxDetail from "./en/box-detail.js";
import boxes from "./en/boxes.js";
import checkpoints from "./en/checkpoints.js";
// UI strings. Flat keys shared by en.js and zh-CN.js; `{name}` marks a placeholder.
import common from "./en/common.js";
import egress from "./en/egress.js";
import errors from "./en/errors.js";
import files from "./en/files.js";
import onboarding from "./en/onboarding.js";
import overview from "./en/overview.js";
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
  ...overview,
  ...onboarding,
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
  "tp.postCreate": "Setup command",
  "tp.ports": "Ports",
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
  "tp.deleteDraftMessage":
    "Delete the saved template <code>{ref}</code>? {extra}It was never built, so no image is removed.",
  "tp.deleteBaseExtra": "You can rebuild it on this page. ",
  "tp.deleteExtra": "This can't be undone. ",
  "tp.deleted": "Template deleted",
  "tp.new": "New template",
  "tp.newTitle": "New template",
  "tp.newDesc":
    "Build a template image from a Dockerfile, a repository, a build context or a devcontainer.json, or save the source to build later. The build log opens in the Tasks panel.",
  "tp.newName": "Template name",
  "tp.newDescription": "Description",
  "tp.sourceKind": "Source",
  "tp.kindDockerfile": "Dockerfile",
  "tp.kindGit": "Git repository",
  "tp.kindContext": "Build context URL",
  "tp.kindDevcontainer": "devcontainer.json",
  "tp.kindOfficial": "MiniBox's official Dockerfile",
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
    "MiniBox reads image, build (dockerfile, context, args, target), containerEnv, remoteEnv, postCreateCommand and forwardPorts. A box created from the template runs postCreateCommand once, as dev, in /workspace if the box mounts it. Other settings are listed as warnings in the build log and not applied.",
  "tp.dockerfile": "Dockerfile",
  "tp.dockerfileHelp": "Sent as typed. Use FROM to choose the base image. At most 64 KB.",
  "tp.contextUrl": "Build context URL",
  "tp.contextHelp": "An http or https link to a .tar or .tar.gz archive, at most 256 MB.",
  "tp.devcontainerPath": "devcontainer.json path",
  "tp.devcontainerPathHelp":
    "Relative to the repository. Defaults to .devcontainer/devcontainer.json, then .devcontainer.json.",
  "tp.submitBuild": "Build template",
  "tp.saveDraft": "Save",
  "tp.draftSaved": "Template saved, not built",
  "tp.draftSavedText": "Build it from the Templates page when you are ready.",
  "tp.draft": "Not built",
  "tp.draftHelp": "Saved but not built yet. Build it to create boxes from it.",
  "tp.buildDraft": "Build",
  "tp.draftBuildStarted": "Building template",
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
  "tp.edit": "Edit",
  "tp.editTitle": "Edit “{name}”",
  "tp.editDesc":
    "Change what <code>{ref}</code> rebuilds from. Its current image is kept, so boxes created before the next rebuild are unaffected.",
  "tp.editWhat": "Saving changes the recipe only. Click Rebuild on the card to build the new source into a new image.",
  "tp.editOfficial":
    "This template is built from MiniBox's own Dockerfile, so its source cannot be edited here. Duplicate it to get one you can change.",
  "tp.editConfirm": "Save changes",
  "tp.editing": "Saving…",
  "tp.edited": "Template updated",
  "tp.editFailed": "Couldn't edit template",
  "tp.editPorts": "Forwarded ports",
  "tp.editPortsHelp": "TCP ports a box created from the template opens, separated by commas. Empty for none.",
  "tp.editPostCreateHelp": "Runs once in each box created from the template, as /bin/sh -c. Empty for none.",
  "tp.errPort": "“{port}” is not a port between 1 and 65535.",
  "tp.fork": "Duplicate",
  "tp.forkTitle": "Duplicate “{name}”",
  "tp.forkDesc":
    "Duplicate <code>{ref}</code> from its build source into a new, independent template. Nothing is built, so the copy has no image or size until you build it; the template it comes from stays as it is.",
  "tp.forkDescImage":
    "Copy the image of <code>{ref}</code> into a new template. The template it comes from stays as it is.",
  "tp.forkWhat":
    "The copy keeps the build source, the setup command, the forwarded ports and the description, but not the image: it starts as a template that is not built, and building it creates its own image, size and creation time. You can edit or build it on its card.",
  "tp.forkWhatImage":
    "A template saved from a box has no build source to copy, so the copy is an image copy: it cannot be edited or rebuilt, exactly like the template it came from.",
  "tp.forkWhatOfficial":
    "MiniBox has not built this official template on a host yet, so the copy is a template that is not built, from a copy of the Dockerfile MiniBox ships. You can edit or build it like any other custom template.",
  "tp.forkHereLocal": "The copy is saved on this host.",
  "tp.forkConfirm": "Duplicate template",
  "tp.forking": "Duplicating…",
  "tp.forked": "Template duplicated",
  "tp.forkedDraft": "Template duplicated, not built",
  "tp.forkFailed": "Couldn't duplicate template",
  "tp.hosts": "Hosts",
  "tp.present": "Present",
  "tp.absent": "Missing",
  "tp.copyHere": "Copy here",
  "tp.hostOffline": "This host is not online.",
  "tp.syncStarted": "Copying template",
  "tp.syncStartedText": "Watch the copy in the Tasks panel.",
  "tp.syncFailed": "Couldn't copy template",
  "tp.official": "Official",
  "tp.notBuiltHelp": "Not built on any host yet. A box builds it the first time it needs it, or build it now.",
  "tp.buildOfficial": "Build",
  "tp.buildHere": "Build here",
  "tp.officialBuildStarted": "Building official template",
  "tp.buildsOnUse": "Builds on first use",
  "tp.deleteHostsExtra": "Removes the copy on {hosts}. ",
};

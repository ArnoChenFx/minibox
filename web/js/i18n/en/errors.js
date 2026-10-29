export default {
  "err.storage_admin_required":
    "Storage pool selection and volume administration require the owner or an unmodified admin token.",
  "err.invalid_json_object": "Request body must be a JSON object.",
  "err.invalid_json": "Request body is not valid JSON.",
  "err.field_required": "{label} is required.",
  "err.name_invalid":
    "{label} may only contain letters, digits, dots, underscores and hyphens, must start with a letter or digit, and be at most 63 characters.",
  "err.not_a_number": "{label} must be a number.",
  "err.cpus_range": "CPU cores must be between {min} and {max}.",
  "err.memory_range": "Memory must be an integer between {min} and {max} (MB).",
  "err.tail_range": "tail must be an integer between 1 and {max}.",
  "err.not_boolean": "{field} must be a boolean.",
  "err.template_required": "Please choose a template.",
  "err.image_ref_invalid": "Invalid image reference.",
  "err.profile_invalid": "Security profile must be one of standard, strict or relaxed.",
  "err.description_invalid":
    "Description must be a single line without control characters, such as line breaks or tabs.",
  "err.resources_required": "Provide at least one of cpus, memoryMb or pids.",
  "err.revision_required": "Send the request header If-Match with this box's current revision.",
  "err.revision_mismatch": "This box is at revision {revision}, not {expected}. Refresh it and try again.",
  "err.revision_invalid": "If-Match must be the box revision, a positive integer.",
  "err.box_update_empty":
    "Provide at least one of name, cpus, memoryMb, pids, labels, idleTimeoutSec, ttlSec, template, mounts, env, network or profile.",
  "err.mount_invalid":
    "Each mount needs a volume name, an absolute path and a mode of rw or ro. At most {max} mounts, and each path once.",
  "err.env_invalid":
    "Each environment entry needs a name and either a value or a secretRef, not both. At most {max} entries, and each name once.",
  "err.env_secret_missing": "Environment variable {env} refers to secret {name}, which is not set.",
  "err.env_secret_missing_hint": "Set the secret under Settings, Secrets, or remove the variable, then try again.",
  "err.secret_name_invalid":
    "A secret name starts with a letter or digit, holds only letters, digits, dots, underscores and hyphens, and is at most 128 characters.",
  "err.secret_value_invalid":
    "A secret value is between 1 and {max} characters and holds no control characters, such as line breaks or tabs.",
  "err.secret_not_found": "Secret {name} was not found.",
  "err.secret_in_use":
    "Secret {name} is used by {boxes}. Those boxes cannot be rebuilt or started until the secret is set again. Send force to delete it anyway.",
  "err.secret_reference_forbidden":
    "This credential may not put secrets into a box. Give it the secret:use scope, or use the admin preset.",
  "err.secret_in_image":
    "Environment variable {env} refers to secret {name}. A snapshot, a template or a checkpoint's system image keeps the box's environment, so it would store the secret's value.",
  "err.secret_in_image_hint":
    "Remove the variable, then try again. A checkpoint without a system image keeps no environment, so it can still be taken.",
  "err.network_invalid":
    "Network name must start with a letter or digit and contain only letters, digits, dots, underscores and hyphens.",
  "err.rebuild_empty":
    "Nothing in this request changes the template, mounts, environment, network or security profile.",
  "err.rebuild_confirm_required":
    "This change rebuilds the box and was not applied. Send the same request with confirm set to true to apply the preview. Volumes, the stable id and the name are kept. The writable layer, running processes and the container IP are lost.",
  "err.staged_none": "This box has no staged changes. They may have been applied or discarded already.",
  "err.staged_changed": "The staged changes were changed after you reviewed them. Review them again before applying.",
  "err.rebuild_start_failed": "The new container did not start. The previous container and spec were restored.",
  "err.rebuild_name_conflict": "Cannot rebuild while {name} is still in use. Remove that container and try again.",
  "err.rebuild_failed_safety_kept":
    "The rebuild failed, and the box could not be put back exactly as it was. Its safety checkpoint {id} is kept, so the box can be restored from it.",
  "err.pids_range": "Process limit must be an integer between {min} and {max}.",
  "err.idle_timeout_invalid":
    "Idle timeout must be a whole number of seconds from 0 to {max} (0 means never sleep), or null to inherit the global default.",
  "err.ttl_invalid": "TTL must be a positive number of seconds up to {max}, or null to clear it.",
  "err.label_invalid":
    "Labels may have at most 32 entries. Keys follow box name rules, and each value is a single line of at most 256 characters.",
  "err.box_claim_failed": "Could not claim this container as a box: {detail}.",
  "err.docker_unavailable":
    "Cannot connect to the Docker daemon. Make sure Docker is running and the current user can access it.",
  "err.docker_not_found": "Not found: {detail}",
  "err.docker_conflict": "Conflict: {detail}",
  "err.docker_error": "Docker error: {detail}",
  "err.unknown_error": "Unknown error",
  "err.api_not_found": "API endpoint not found.",
  "err.method_not_allowed": "Method not allowed.",
  "err.unsupported_media_type": "Use Content-Type: application/json (requests without a body may omit it).",
  "err.origin_forbidden":
    "Blocked: the request's Origin is not this MiniBox address and is not listed in ALLOWED_ORIGINS. If you reach MiniBox through a tunnel or reverse proxy, add its public address (for example https://minibox.example.com) to ALLOWED_ORIGINS and restart MiniBox.",
  "err.unauthorized": "Not signed in, or the access key is invalid.",
  "err.preview_path_invalid": "Preview URL must look like /box/<name-or-id>/<port>/….",
  "err.preview_box_stopped": "Start the box before opening a port preview.",
  "err.preview_upstream_failed": "Could not reach the service inside the box: {detail}",
  "err.preview_bridge_failed": "Could not open the preview through the box's engine: {detail}",
  "err.preview_bridge_hint": "Every box needs python3 to serve a preview; the base template ships it.",
  "err.preview_port_invalid": "Port must be an integer between 1 and 65535.",
  "err.preview_port_not_manual": "That port is not on the manual preview list.",
  "err.preview_unauthorized": "Sign in to open a box port preview.",
  "err.preview_grant_required":
    "Open this preview from the MiniBox console. Its link has been used, has expired, or the box was renamed or removed.",
  "err.preview_host_unknown": "No box port is served at this address.",
  "err.preview_subdomain_off":
    "Subdomain previews are off. Set PREVIEW_BASE_DOMAIN and restart MiniBox to turn them on.",
  "err.preview_check_console_in_base":
    "The console is at {host}, which is inside the preview domain {base}. Serve the console from a domain outside it.",
  "err.preview_check_console_ok": "The console is outside the preview domain.",
  "err.preview_check_same_site":
    "The console and {base} are the same site, so a box page could reach the console's site. Use a preview domain that is not under the console's domain, such as minibox-preview.net.",
  "err.preview_check_same_site_ok": "The console and the preview domain are different sites.",
  "err.preview_check_dns":
    "Nothing resolves {host}. Add a wildcard DNS record for *.{base} that points at MiniBox or at the tunnel that reaches it.",
  "err.preview_check_dns_ok": "Names under the preview domain resolve.",
  "err.preview_check_https":
    "Could not reach {host} over HTTPS: {detail}. Route *.{base} to MiniBox, with a certificate that covers it.",
  "err.preview_check_other_server":
    "{host} answers, but not from MiniBox. Route the wildcard for {base} to MiniBox, not to another server.",
  "err.preview_check_ok": "Preview names reach MiniBox over HTTPS.",
  "err.operation_forbidden": "This credential may not run {op}.",
  "err.run_invalid":
    "X-Minibox-Run must be 1 to 64 letters, digits, dots, colons, underscores or hyphens, starting with a letter or digit.",
  "err.event_filter_invalid": "{field} must be 1 to 200 characters, without control characters.",
  "err.event_status_invalid": "status must be one of started, ok, error or denied.",
  "err.event_limit_range": "limit must be an integer between 1 and {max}.",
  "err.event_cursor_invalid": "cursor must be a sequence number from an earlier page.",
  "err.event_since_invalid": "since must be an ISO 8601 date or date and time, such as 2026-10-20T00:00:00Z.",
  "err.last_event_id_invalid": "Last-Event-ID must be a sequence number from an earlier event.",
  "err.terminal_not_running": "The box is not running, so a terminal can't be opened.",
  "err.terminal_read_only": "This terminal is read-only. Take over the session in the console to type.",
  "err.ws_upgrade_failed": "WebSocket upgrade failed.",
  "err.ssh_bearer_required":
    "SSH needs an Authorization Bearer access key or agent token. A browser session cannot open an SSH connection.",
  "err.ssh_forbidden": "This credential may not open an SSH connection to a box.",
  "err.ssh_forbidden_hint":
    "Give the token the box:ssh scope, for example with the operator or admin preset. Forwarding a port also needs port:expose.",
  "err.ssh_box_limit": "This box already has {max} SSH connections open.",
  "err.ssh_total_limit": "MiniBox already has {max} SSH connections open.",
  "err.ssh_limit_hint": "Close an SSH session you no longer need, then try again.",
  "err.ssh_key_invalid": "That is not an SSH public key. Paste one line such as ssh-ed25519 AAAA... you@laptop.",
  "err.ssh_key_private":
    "That is a private key. Paste the public key, the .pub file, instead, and keep the private key secret.",
  "err.ssh_key_type": "{type} keys are not accepted. Use an ed25519, ECDSA or RSA key.",
  "err.ssh_key_taken": "This key is already added, as {label}.",
  "err.ssh_key_limit": "At most {max} SSH keys can be added. Delete one you no longer use first.",
  "err.ssh_key_not_found": "SSH key not found.",
  "err.too_many_attempts": "Too many attempts. Please try again in 5 minutes.",
  "err.stream_limit":
    "Too many live connections are open (at most {max}). Close a MiniBox tab or wait, then try again.",
  "err.wrong_key": "Incorrect access key.",
  "err.session_not_found": "Session not found.",
  "err.box_not_found": "Box not found.",
  "err.box_ttl_expired": "The box's TTL has expired, so it cannot be started.",
  "err.box_ttl_expired_hint": "Clear the TTL or set a later one, then start the box.",
  "err.snapshot_not_found": "Snapshot not found.",
  "err.template_not_found": "Template not found.",
  "err.template_name_taken": "A template named “{name}” already exists.",
  "err.template_edit_empty":
    "Nothing to change: send a source, a setup (init) or a description. A template that was not built from a declared source has no source to edit.",
  "err.template_source_builtin":
    "Template {name} is built by MiniBox itself, so its source cannot be edited. Fork it into a template of your own and edit that.",
  "err.template_busy": "Another change to the template “{name}” is still running. Try again when it ends.",
  "err.template_image_missing":
    "Template image {image} does not exist. Build it on the Templates page or choose another template.",
  "err.template_source_required":
    "Choose where the template comes from: a Dockerfile, a Git repository, a build context URL or a devcontainer.json.",
  "err.template_not_declared":
    "Template {name} was not built from a declared source, so it cannot be rebuilt. Build a template from a Dockerfile, a repository, a build context or a devcontainer.json instead.",
  "err.dockerfile_invalid":
    "The Dockerfile must be at most 64 KB, contain no NUL bytes, and include a FROM instruction.",
  "err.dockerfile_not_found": "There is no Dockerfile at {path} in the build context.",
  "err.context_url_invalid":
    "A build context URL must start with http:// or https://, contain no spaces, and carry no user name or password.",
  "err.context_fetch_failed": "Could not download the build context: {detail}",
  "err.context_invalid": "The build context cannot be used: {detail}",
  "err.image_pull_failed": "Could not pull image {image}: {detail}",
  "err.image_not_found": "Image {image} was not found in its registry. Check the name and tag, then try again.",
  "err.repo_url_invalid":
    "The repository URL must be https://host/path, ssh://host/path or user@host:path, and contain no spaces.",
  "err.repo_url_credentials":
    "The repository URL must not contain a password or token. Store the credential as a secret and send secretRef instead.",
  "err.repo_branch_invalid":
    "A branch name starts with a letter or digit, uses only letters, digits, dots, underscores, slashes and hyphens, and is at most 200 characters.",
  "err.repo_path_invalid":
    "A path inside the repository must be relative, have no .. part and no control characters, and be at most 512 characters.",
  "err.repo_secret_missing": "Secret {name} is not set. Set it under Settings, Secrets, then try again.",
  "err.repo_needs_workspace":
    "A clone needs an empty, writable /workspace in the box. Leave the default mounts in place, or mount a writable workspace volume.",
  "err.clone_failed": "Could not clone the repository: {detail}",
  "err.devcontainer_missing": "There is no devcontainer.json at {path} in the repository.",
  "err.devcontainer_invalid": "devcontainer.json is not valid: {detail}",
  "err.devcontainer_source": "devcontainer.json must set image or build.dockerfile, and not both.",
  "err.devcontainer_build_invalid":
    "build.dockerfile must be a path to the Dockerfile, and build.context a path to the build context, both relative to devcontainer.json.",
  "err.devcontainer_target_invalid":
    "build.target must be a stage name of the Dockerfile, with only letters, digits, dots, underscores and hyphens.",
  "err.devcontainer_target_missing":
    "build.target {target} is not a stage of the Dockerfile, so the template cannot be built. Name a stage the Dockerfile declares with FROM … AS {target}, or remove build.target.",
  "err.devcontainer_path_invalid":
    "build.dockerfile and build.context must stay inside the repository, and the Dockerfile must be inside the build context.",
  "err.devcontainer_value_invalid":
    "{name} is not valid. A name must be a valid variable name, and a value must have no control characters, such as a line break, and no ${…} reference, because MiniBox does not expand variables.",
  "err.post_create_failed": "postCreateCommand exited with code {code}. The box was created and is kept.",
  "err.post_create_timeout":
    "postCreateCommand did not finish within {max} minutes, so it was stopped. The box was created and is kept.",
  "err.post_create_box_stopped":
    "The box stopped before postCreateCommand could run, so the command did not run. The box is kept.",
  "err.template_command_forbidden":
    "This token may not create a box from this template, because its devcontainer.json runs postCreateCommand, which needs the exec scope.",
  "err.template_ports_forbidden":
    "This token may not create a box from this template, because its devcontainer.json forwards ports, which needs the port:expose scope.",
  "err.box_exists": "A box named “{name}” already exists.",
  "err.box_id_taken": "Box id {id} is already in use.",
  "err.checkpoint_not_found": "Checkpoint {id} was not found.",
  "err.checkpoint_volume_excluded":
    "Volume {volume} is never part of a checkpoint. Cache and tools volumes are left out of every checkpoint.",
  "err.checkpoint_volume_not_mounted": "Volume {volume} is not mounted by this box, so it cannot be included.",
  "err.volume_snapshot_host_offline":
    "Host {host} is offline, so volume {volume} cannot be snapshotted. Snapshot it once the host is back online.",
  "err.volume_busy": "Volume {volume} is being snapshotted or removed. Try again once that operation finishes.",
  "err.checkpoint_other_box":
    "Checkpoint {id} was taken from another box. Roll back a box only to its own checkpoints.",
  "err.checkpoint_no_data": "Checkpoint {id} holds no volume data, so there is nothing to roll back.",
  "err.checkpoint_legacy_read_only":
    "Snapshot {id} was made before checkpoints. It can be forked or deleted, not changed.",
  "err.checkpoint_path_taken":
    "Path {path} is already mounted by a volume the new box gets by default. Mount the copy elsewhere, or do not copy it.",
  "err.checkpoint_path_not_mounted":
    "No volume of this box is mounted at {path} now, so the checkpoint cannot be restored there.",
  "err.checkpoint_pinned": "Checkpoint {id} is pinned. Unpin it before deleting it.",
  "err.checkpoint_rollback_confirm":
    "Rolling back first takes a checkpoint of the current data, then replaces the volumes at the checkpoint's paths with copies of the checkpoint's data. The replaced volumes are kept until you confirm the rollback, which deletes them, or undo it. Send confirm: true to continue.",
  "err.checkpoint_out_of_scope": "This credential cannot use that checkpoint.",
  "err.checkpoint_capacity_exceeded":
    "The checkpoint repository holds {used} MB, at or above its limit of {limit} MB. Delete checkpoints before rolling back: a rollback takes a safety checkpoint first.",
  "err.checkpoint_held_by_rollback":
    "Checkpoint {id} is the safety point of a rollback that waits for its confirm or undo. Confirm or undo that rollback before deleting it.",
  "err.checkpoint_exporting": "Checkpoint {id} is being exported or copied. It can be deleted once that finishes.",
  "err.checkpoint_export_legacy": "Snapshot {id} was made before checkpoints. It has no data to export.",
  "err.checkpoint_export_empty": "Checkpoint {id} holds no volume data, so there is nothing to export.",
  "err.checkpoint_export_no_box": "Checkpoint {id} names no box, so a package cannot describe it.",
  "err.checkpoint_no_spec": "Checkpoint {id} records no box settings, so a box cannot be made from it.",
  "err.checkpoint_export_system":
    "Checkpoint {id} includes its system layer, which a package does not carry yet. Take a checkpoint without the system layer to export it.",
  "err.checkpoint_import_exists":
    "Checkpoint {id} already exists on this instance, so the package was not imported. Delete the existing checkpoint first, or keep this one.",
  "err.checkpoint_copy_legacy": "Snapshot {id} was made before checkpoints. It cannot be copied to another host.",
  "err.checkpoint_copy_empty": "Checkpoint {id} holds no volume data, so there is nothing to copy.",
  "err.checkpoint_copy_system":
    "Checkpoint {id} includes its system layer, which a copy does not carry yet. Take a checkpoint without the system layer to copy it.",
  "err.checkpoint_copy_no_box": "Checkpoint {id} names no box, so it cannot be copied to another host.",
  "err.checkpoint_copy_same_host": "Checkpoint {id} is already on host {host}. Copy it to another host.",
  "err.checkpoint_copy_exists":
    "Checkpoint {id} already has a copy on host {host}, so it was not copied again. Delete that copy first to copy it again.",
  "err.trash_busy":
    "Recycle bin entry {name} is being restored or purged. Empty the recycle bin again when that has finished.",
  "err.trash_host_offline": "Host {host} is offline, so its recycle bin entries were not purged.",
  "err.trash_not_found": "Recycle bin entry {id} was not found.",
  "err.trash_capacity_exceeded":
    "Keeping this data in the recycle bin needs {need} MB, but the checkpoint repository holds {used} MB of its {limit} MB limit, and purging the recycle bin did not free enough. Delete checkpoints, or delete without keeping a copy.",
  "err.trash_skip_forbidden":
    "This credential may not delete without keeping a copy in the recycle bin. Ask the owner for the trash:skip scope, or delete without skipTrash.",
  "err.package_invalid": "The package is not a valid MiniBox checkpoint package: {reason}",
  "err.package_passphrase_wrong": "The passphrase does not open this package.",
  "err.package_passphrase_invalid":
    "The passphrase must be 12 to 1024 characters, with no leading or trailing spaces and no line breaks.",
  "err.package_too_large":
    "The checkpoint package is larger than the limit of {limit} MB. Raise CHECKPOINT_PACKAGE_MAX_MB to allow it.",
  "err.package_not_found": "Package {id} was not found. Packages are kept for a day, so it may have expired.",
  "err.package_upload_type": "A package is uploaded as application/octet-stream.",
  "err.payload_too_large": "The request body is larger than the limit of {limit} MB.",
  "err.schedule_timezone_invalid": "The time zone must be an IANA name such as Asia/Shanghai or UTC.",
  "err.schedule_rule_invalid":
    "A schedule runs every 1 to 720 hours, or once a day at a time such as 02:30. Send either everyHours or at, not both.",
  "err.rollback_pending":
    "Box {box} has a rollback that waits for its confirm or undo. Confirm or undo it before rolling back again.",
  "err.rollback_none": "Box {box} has no rollback that waits for its confirm or undo.",
  "err.rollback_confirm_required":
    "Confirming deletes the volumes the rollback replaced. The box cannot switch back to them, but the checkpoint taken before the rollback still holds their data. Send confirm: true to continue.",
  "err.rollback_undo_confirm":
    "Undoing mounts the replaced volumes again and deletes the volumes the rollback restored. Anything written since the rollback is lost. Send confirm: true to continue.",
  "err.rollback_undo_gone":
    "Box {box} cannot undo its rollback: volume {volume}, which the rollback replaced, no longer exists.",
  "err.rollback_undo_unmounted":
    "Box {box} cannot undo its rollback: it no longer mounts {volume}, which the rollback restored.",
  "err.rollback_out_of_scope": "This credential cannot change that box's rollback.",
  "err.box_network_conflict":
    "Network {network} already exists but is not a bridge with inter-container communication disabled. Remove it when no box uses it, then try again.",
  "err.volume_reserved": "Volume {volume} holds MiniBox's own data and cannot be mounted into a box.",
  "err.volume_unmanaged": "Volume {volume} was not created by MiniBox, so a box cannot mount it.",
  "err.volume_in_use": "Volume {volume} is already mounted by another box.",
  "err.volume_missing":
    "Volume {volume} no longer exists in the engine. MiniBox does not recreate it. Restore the engine volume, or delete the volume record if you no longer need it.",
  "err.volume_tools_recreated":
    "The engine had lost the shared tools volume {volume}. MiniBox recreated it. On a local pool it is empty, so its tools must be installed again.",
  "err.network_reserved": "Boxes cannot join network {network}. Host, none and container networks are refused.",
  "err.network_not_managed": "Boxes cannot join network {network}. Boxes join {managed}.",
  "err.egress_mode_invalid": "Egress must be open, none or proxy-only, not {mode}.",
  "err.egress_preset_invalid": "Egress preset {preset} is not one of agent-default or package-registries.",
  "err.egress_domain_invalid":
    "{domain} is not a host name. Use a name such as api.example.com, or a wildcard such as *.example.com.",
  "err.egress_options_need_proxy":
    "Presets and domains apply to proxy-only egress only. The {mode} mode takes neither.",
  "err.egress_domains_too_many": "An egress allowlist holds at most {max} hosts.",
  "err.egress_pool_full":
    "No address is left for another box's egress network. Remove a box with egress none or proxy-only, then try again.",
  "err.egress_proxy_failed": "The egress proxy for box {box} could not start: {detail}",
  "err.egress_move_refused":
    "Box {box} has egress {mode}. A box with a network egress policy cannot move to another host yet.",
  "err.egress_network_conflict":
    "The private network {network} already exists with other settings. Remove it, then try again.",
  "err.egress_host_gateway_failed": "The host firewall could not be updated: {detail}",
  "err.egress_needs_network":
    "Egress {mode} and network {network} cannot be set together. Egress sets the box network.",
  "err.cpu_over_host": "CPU cores exceed the host limit ({cores} cores).",
  "err.memory_over_host": "Memory exceeds the host limit ({gb} GB).",
  "err.cpu_booked_over_host": "Running boxes on this host would take {booked} CPUs, more than its limit of {limit}.",
  "err.memory_booked_over_host":
    "Running boxes on this host would take {booked} GB of memory, more than its limit of {limit} GB.",
  "err.token_preset_invalid": "Preset must be one of readonly, operator, sandboxed-agent or admin.",
  "err.token_scope_invalid": "Scopes must be a list of known scope names, with at most {max} entries.",
  "err.token_scope_required": "Choose a preset or at least one scope.",
  "err.token_boxes_invalid":
    "Box access must be created-by-me, * for every box, a list of ids, or a list of tags (key or key=value).",
  "err.token_volumes_invalid": "Volumes must be * or a list of volume ids.",
  "err.token_box_unresolved":
    "No box matches “{ref}”. Give a box name, a container id or a stable id (bx_…) of a box that exists.",
  "err.token_box_ambiguous": "More than one box is named “{ref}”. Use its stable id (bx_…) instead.",
  "err.token_hosts_invalid": "Hosts must be * or a list of host ids.",
  "err.token_quota_invalid": "Quotas must be positive numbers, or null for no limit. A rate window needs a rate limit.",
  "err.token_expiry_invalid": "Expiry must be a positive number of seconds up to {max}, or null for no expiry.",
  "err.token_not_found": "Token not found.",
  "err.token_name_taken": "A token named “{name}” already exists.",
  "err.token_delete_live": "Token “{name}” is still live. Revoke it first, then delete it.",
  "err.token_limit": "At most {max} live tokens can exist. Revoke one, then create another.",
  "err.token_rate_limited": "This token has used its rate limit. Try again in a moment.",
  "err.box_out_of_scope": "This credential cannot use that box.",
  "err.box_taken_over": "A person has taken over box {name}, so the agent may not take a checkpoint of it now.",
  "err.box_taken_over_hint": "A person is working in this box. Try again once they have finished.",
  "err.self_token_host_unsupported":
    "A self token cannot be given to a box on this host, because a paired host agent cannot write a file into a box.",
  "err.question_not_found": "Question {id} does not exist.",
  "err.question_answered": "Question {id} has already been answered.",
  "err.question_option_invalid": "The answer must be one of the options the question offered.",
  "err.question_answer_long": "The answer is too long.",
  "err.question_limit": "This box already has {max} unanswered questions. Wait for a person to answer one.",
  "err.question_limit_total": "The question log holds {max} unanswered questions. Answer one before asking another.",
  "err.question_message_invalid": "A question needs a message of 1 to {max} characters.",
  "err.question_options_invalid":
    "Options must be up to {max} different choices, each one line of 1 to {length} characters, or none for a free-text answer.",
  "err.question_answer_invalid": "An answer needs 1 to {max} characters.",
  "err.self_state_invalid": "The state must be one of {states}.",
  "err.self_note_invalid": "A note needs 1 to {max} characters on one line.",
  "err.volume_not_granted":
    "This credential cannot mount the volume “{volume}”. It needs volume:attach on that volume.",
  "err.host_not_granted": "This credential cannot use host “{host}”.",
  "err.host_id_invalid": "A host id is 1 to 32 lowercase letters, digits or hyphens, starting with a letter.",
  "err.host_id_reserved": "“{host}” is reserved and cannot be a host id.",
  "err.host_auto_offline": "No host is online to place the box on.",
  "err.host_auto_no_room":
    "No online host that holds the template, or can build it, has room for a box of {cpus} CPUs and {memoryMb} MB.",
  "err.host_auto_no_label_match":
    "No online host carries every label this create asks for ({labels}). Nothing was placed.",
  "err.host_labels_invalid": "The host labels are not valid: {reason}",
  "err.host_labels_need_auto":
    "hostLabels selects a host for host: auto. Either set host to auto and let the labels choose, or name one host and leave hostLabels out.",
  "err.host_exists": "A host with the id “{host}” already exists.",
  "err.host_name_taken": "The name “{name}” is already used by host “{host}”. Give this host another name.",
  "err.host_name_taken_by_id":
    "This host has no name, so it would be named after its id “{name}”, but host “{host}” already uses that name. Give this host a name.",
  "err.host_name_pending":
    "The name “{name}” is held by a pairing code for host “{host}” that has not been used yet. Use that code, or wait for it to expire.",
  "err.host_not_found": "Host “{host}” was not found.",
  "err.host_is_local": "The local host cannot be removed.",
  "err.host_in_use": "Host “{host}” still holds {count} boxes, volumes or checkpoints. Remove them first.",
  "err.host_endpoint_invalid": "The endpoint is not valid: {reason}",
  "err.host_credentials_missing": "The {field} is required for this host.",
  "err.host_credentials_invalid": "The {field} is not a PEM block of the kind this host needs.",
  "err.host_key_encrypted": "The {field} is encrypted. Use a key without a passphrase.",
  "err.host_key_invalid": "The SSH key cannot be used: {reason}",
  "err.host_key_unconfirmed":
    "The SSH host key {fingerprint} has not been confirmed. Check it against the host, then add the host with that fingerprint.",
  "err.host_key_mismatch":
    "The SSH host key {presented} is not the key you confirmed ({expected}). No credentials were sent to the host.",
  "err.host_unreachable": "The host could not be reached: {detail}",
  "err.agent_host_unsupported": "{feature} is not supported on agent hosts yet.",
  "err.host_endpoint_agent":
    "Agent hosts are paired with a code, not added by endpoint. Create a pairing code, then run the agent on the host.",
  "err.host_not_agent": "Host “{host}” is not an agent host.",
  "err.agent_pairing_unknown": "The pairing code is not valid. Create a new one under Settings, Hosts.",
  "err.agent_pairing_used": "This pairing code has already been used. Create a new one under Settings, Hosts.",
  "err.agent_pairing_expired": "This pairing code has expired. Create a new one under Settings, Hosts.",
  "err.agent_pairing_replaced":
    "A newer pairing code was created for this host and replaced this one. Use the newest code.",
  "err.agent_pairing_limit":
    "At most {max} pairing codes can wait at once. Pair an agent or let a code expire, then try again.",
  "err.agent_pairing_request_invalid":
    "The pairing request is not valid. Run the agent image again with the current MiniBox version.",
  "err.agent_key_invalid": "The agent's public key must be an Ed25519 key in PEM form.",
  "err.agent_protocol_mismatch":
    "This agent speaks protocol {agent}, and this MiniBox speaks protocol {server}. Update the agent image, then pair again.",
  "err.agent_refused_auth": "The agent could not prove its identity. Pair it again under Settings, Hosts.",
  "err.agent_refused_revoked": "This agent was revoked. Remove its host, then pair the agent again.",
  "err.agent_refused_protocol": "This MiniBox speaks agent protocol {protocol}. Update the agent image.",
  "err.agent_pending_limit":
    "Too many agent sockets are waiting to authenticate (at most {max} from one address). A real agent retries on its own; anything else should stop.",
  "err.agent_pending_total_limit":
    "Too many agent sockets are waiting to authenticate across all addresses (at most {max} in total). A real agent retries on its own; anything else should stop.",
  "err.agent_pending_limit_hint":
    "A socket that never sends a hello holds a place until it times out. If a real agent is refused, check for a proxy or tunnel in front of MiniBox: with TRUST_PROXY off, every client shares one address and one limit.",
  "err.runtime_unsupported": "This host cannot run that operation: {detail}",
  "err.move_agent_unsupported":
    "A box cannot move to or from an agent host yet, because an agent copies neither images nor volumes. Create the box on the host you want it on instead.",
  "err.preview_agent_unsupported": "Port preview is not supported on agent hosts yet.",
  "err.box_moving": "This box is moving to another host. Try again when the move finishes.",
  "err.box_changing": "This box is being rebuilt or updated. Try the move again when that finishes.",
  "err.move_confirm":
    "Moving copies the box's volumes to {to}, starts it there if it runs now, and removes it from {from} once it runs there. Send confirm: true to continue.",
  "err.move_same_host": "The box already runs on host {host}, so it cannot move there.",
  "err.move_owner_only": "Only the owner or an admin credential may move a box.",
  "err.move_changed": "The box changed while it was moving, so the move was undone. Refresh the box and try again.",
  "err.move_template_moved":
    "Template {tag} now names a newer image than this box runs. Rebuild the box onto it, then move the box.",
  "err.move_template_differs":
    "Host {host} already has a different image under {tag}, so the template cannot be sent there. Remove or retag that image, then try again.",
  "err.move_start_failed": "The box did not start on host {host}, so the move was undone.",
  "err.move_bind_volume": "Volume {volume} is a bind mount, which a move cannot carry to another host.",
  "err.move_shared_volume":
    "Volume {volume} is also mounted by another box on this host, so a move cannot copy it for this box alone.",
  "err.profile_not_allowed": "This credential may not use the {profile} security profile.",
  "err.quota_boxes": "This token may have at most {max} boxes.",
  "err.quota_cpus": "This token's boxes would use {used} CPU cores, above its limit of {max}.",
  "err.quota_memory": "This token's boxes would use {used} MB of memory, above its limit of {max}.",
  "err.quota_ttl": "TTL must be a positive number of seconds no greater than this token's limit of {max}.",
  "err.quota_checkpoints": "This token may have at most {max} checkpoints.",
  "err.snapshot_out_of_scope": "This credential cannot use that snapshot.",
  "err.template_out_of_scope": "This credential cannot use that template.",
  "err.task_not_found": "Task not found.",
  "err.task_busy": "This operation is already running.",
  "err.task_not_running": "This task is not running.",
  "err.task_cancelled": "The task was cancelled.",
  "err.task_interrupted": "The task was interrupted because MiniBox stopped.",
  "err.task_id_invalid": "Task id must be a 26-character ULID.",
  "err.task_status_invalid": "status must be one of running, succeeded, failed, cancelled or interrupted.",
  "err.task_limit_range": "limit must be an integer between 1 and {max}.",
  "err.storage_unreachable": "Storage pool {pool} is unreachable: {detail}",
  "err.volume_not_found": "Volume {volume} was not found.",
  "err.volume_exists": "A volume named “{name}” already exists.",
  "err.volume_engine_exists":
    "The engine already has a volume named {volume} that MiniBox did not create, so MiniBox will not use it. Remove that volume and try again.",
  "err.volume_mounted": "Volume {name} is mounted by {box}.",
  "err.volume_delete_failed": "Volume {name} could not be deleted: {detail}",
  "err.volume_in_use_by_box": "Volume {volume} is in use by a box or a container.",
  "err.volume_prune_busy":
    "A box is being moved, restored or rolled back, and its volumes may still be filling. Prune again when it has finished.",
  "err.volume_prune_changed": "Volume {volume} changed while it was being pruned, so it was kept.",
  "err.volume_host_offline": "Host {host} is offline, so its volumes were not checked.",
  "err.volume_host_failed": "Host {host} could not list its containers, so its volumes were not checked: {detail}",
  "err.volume_older_than_invalid": "olderThan must be a whole number followed by s, m, h, d or w, such as 30d.",
  "err.volume_delete_forbidden": "Volume {volume} is outside this credential's resource grants, so it was not deleted.",
  "err.volume_shared_tools":
    "Volume {volume} is the shared tools volume. It holds the tools of every box, so it is not deleted.",
  "err.volume_system": "Volume {volume} is a MiniBox system volume, so it is not deleted.",
  "err.volume_not_orphan": "Volume {volume} is no longer an orphan, so it was kept.",
  "err.volume_prune_ids_required":
    "A prune that removes volumes must name them: send the ids its dry run listed, and only those are removed.",
  "err.volume_attach_forbidden": "This credential may not attach volume {volume}.",
  "err.volume_write_forbidden": "This credential may not write volume {volume}.",
  "err.volume_create_forbidden": "This credential may not create volumes.",
  "err.volume_tools_create_forbidden":
    "Only the owner may create a tools volume; a token may not, not even an admin token.",
  "err.volume_chown_failed": "Could not change ownership of a new volume: {detail}",
  "err.volume_prepare_failed": "Could not prepare the volume directory: {detail}",
  "err.storage_permission_denied": "Storage pool {pool} denied permission to create the volume directory: {detail}",
  "err.storage_unwritable":
    "Uid 1000, the box user, cannot write the new volume directory {path}, so the volume was not created: {detail}",
  "err.storage_squash_hint":
    "On the NAS, set the export to all_squash,anonuid=1000,anongid=1000, or root_squash,anonuid=1000,anongid=1000, so the squashed user is uid 1000. Setup guide: https://github.com/ArnoChenFx/minibox/blob/main/docs/user-guide/nfs.md",
  "err.helper_image_missing": "Base template image {image} is missing, so volume helpers cannot run.",
  "err.helper_image_build_failed": "Base template image {image} is missing, and building it failed: {detail}",
  "err.volume_over_limit":
    "Volume {volume} is over its hard limit: {used} MB used, limit {limit} MB. Boxes that mount it cannot start.",
  "err.volume_over_limit_hint": "Raise or clear the hard limit, or free space in the volume, then start the box.",
  "err.volume_limit_order": "The soft limit must not be above the hard limit.",
  "err.volume_limit_nfs":
    "Volume {volume} is on an NFS pool, where usage is measured for the whole share, so a limit on it would not hold. Set a quota on the NAS export instead.",
  "err.volume_usage_timeout": "Usage of volume {volume} did not answer within {seconds} s, so it was not measured.",
  "err.host_disk_low":
    "The host disk has {free}% free, below the minimum of {min}%, so MiniBox does not create volumes or checkpoints until space is freed.",
  "err.host_disk_low_hint": "Free space on the disk the engine uses, or lower HOST_DISK_MIN_FREE_PERCENT.",
  "err.file_path_invalid": "File path must be at most 512 bytes, without NUL or line breaks.",
  "err.file_path_escape": "File path must stay inside the volume (no .. or absolute escape).",
  "err.file_symlink_loop": "Too many levels of symbolic links in the file path (more than {max}).",
  "err.file_not_found": "File or directory {path} was not found on the volume.",
  "err.file_is_directory": "{path} is a directory. Use list_files or download a tar archive.",
  "err.file_is_directory_hint": "Call list_files for listings, or GET /api/volumes/:id/files/archive for a tar.",
  "err.file_not_text": "File is not valid UTF-8. Read it again with encoding set to base64.",
  "err.file_not_text_hint": "Pass encoding base64 for binary files.",
  "err.file_content_invalid": "content must be a string within the size limit.",
  "err.file_content_too_large": "Content must be at most {max} bytes.",
  "err.file_encoding_invalid": "encoding must be utf-8 or base64.",
  "err.file_depth_range": "maxDepth must be an integer between 0 and {max}.",
  "err.file_limit_range": "limit must be an integer between 1 and {max}.",
  "err.file_list_failed": "Could not list files: {detail}",
  "err.file_copy_invalid": "from and to must be different paths inside the volume.",
  "err.file_copy_into_self": "Cannot copy a path into itself or a subdirectory of itself.",
  "err.file_copy_failed": "Could not copy files: {detail}",
  "err.file_upload_type": "A file is uploaded as application/octet-stream.",
  "err.file_upload_length": "The upload must declare its length in Content-Length.",
  "err.file_upload_too_large":
    "The file is larger than the upload limit of {limit} MB. Raise FILE_UPLOAD_MAX_MB to allow it.",
  "err.file_upload_mismatch": "The upload did not match the {length} bytes its Content-Length declared.",
  "err.file_upload_failed": "Could not upload the file: {detail}",
  "err.file_exists": "{path} already exists.",
  "err.file_target_is_directory": "{path} is a directory, so a file cannot replace it.",
  "err.file_parent_not_directory": "{path} is not a directory, so nothing can be created inside it.",
  "err.file_root_protected": "The volume root cannot be moved or deleted.",
  "err.file_move_invalid": "from and to must be different paths inside the volume.",
  "err.file_move_into_self": "Cannot move a path into itself or a subdirectory of itself.",
  "err.file_move_failed": "Could not move the file: {detail}",
  "err.file_delete_failed": "Could not delete the file: {detail}",
  "err.mount_path_invalid": "Mount path {path} must be an absolute path without empty, . or .. segments.",
  "err.mount_duplicate": "Mount path {path} is listed more than once.",
  "err.mount_not_found": "No mount at {path}.",
  "err.mount_create_invalid":
    "A mount names either an existing volume with volume, path and mode, or a role to create with role. A role mount takes the role's own path and mode, and a volume mount needs both.",
  "err.mount_create_role_duplicate": "Role {role} is listed more than once, so MiniBox cannot create its volume.",
  "err.mount_create_role_path":
    "A mount that creates the {role} volume cannot mount it at {path}. That role is mounted at {expected}.",
  "err.mount_create_role_mode":
    "A mount that creates the {role} volume cannot mount it {mode}. That role is mounted {expected}.",
  "err.mount_create_volume_role":
    "A mount cannot name both volume {volume} and role {role}. Name the volume to attach it, or the role to create it.",
  "err.volume_tools_unavailable":
    "No shared tools volume exists on this host yet, so this box gets none. MiniBox creates one when a box is created with the tools role.",
  "err.storage_confirm_required":
    "This change was not applied. Send the same request with confirm set to true to apply the preview. Nothing has changed.",
  "err.pool_not_found": "Storage pool {pool} was not found.",
  "err.pool_admin_forbidden": "This credential may not change storage pools.",
  "err.pool_backend_invalid": "Pool {pool} has an unknown backend.",
  "err.pool_local_backend": "The local pool must stay a local backend.",
  "err.nfs_pool_invalid": "NFS pool {pool} needs a server and an absolute export path.",
  "err.nfs_options_invalid": "NFS options for pool {pool} must be up to 16 tokens of letters, digits and . _ = -.",
  "err.path_pool_invalid": "Path pool {pool} needs an absolute root directory.",
  "err.marker_invalid": "A path pool marker must be a single file name, not a path.",
  "err.pool_path_invalid": "{what} path {path} must be absolute and must not contain ..",
  "err.pool_duplicate": "Pool names must be unique.",
  "err.pool_default_conflict": "Choose exactly one default storage pool.",
  "err.pool_in_use": "Pool {pool} still has volumes, so it cannot be removed, renamed or change backend.",
  "err.role_pool_unknown": "Role {role} points at pool {pool}, which does not exist.",
  "err.exec_command_required": "Provide exactly one of cmd or argv.",
  "err.exec_command_hint": "cmd runs through /bin/sh -c. argv is the program and its arguments, with no shell.",
  "err.exec_cmd_invalid": "cmd must be a string of at most {max} bytes and must not contain NUL.",
  "err.exec_argv_invalid":
    "argv must contain 1 to {max} non-empty strings. Each string is at most 16384 bytes and must not contain NUL.",
  "err.exec_cwd_invalid": "cwd must be an absolute path of at most {max} bytes, without NUL or line breaks.",
  "err.exec_env_invalid":
    "env must be an object of at most 64 names. A name starts with a letter or underscore, and a value is a string of at most 32768 bytes without NUL.",
  "err.exec_timeout_range": "timeoutSec must be an integer between {min} and {max}.",
  "err.exec_timeout_foreground": "A foreground exec may use at most {max} seconds of timeoutSec.",
  "err.exec_timeout_foreground_hint": "For a longer command, set background to true and poll it with exec_get.",
  "err.exec_stdin_invalid": "stdin must be a string of at most {max} bytes.",
  "err.exec_user_invalid": "user must be a user name or id, optionally with a group, such as dev or 1000:1000.",
  "err.exec_user_strict": "The strict profile runs exec only as dev or 1000, not as {user}.",
  "err.exec_user_strict_hint":
    "Use the default user. Other users need a box with the standard or relaxed profile, which is set when the box is created.",
  "err.exec_wait_range": "waitMs must be an integer between 0 and {max}.",
  "err.exec_id_invalid": "execId must be ex_ followed by 26 Crockford base32 characters.",
  "err.exec_not_found": "No exec with that id is known.",
  "err.exec_not_found_hint":
    "Finished commands stay in memory only until the server restarts or the in-memory list drops them. Saved output is available from the output endpoint while the file is kept.",
  "err.exec_not_running": "That exec is not running.",
  "err.exec_not_running_hint": "It has already exited. Read the result with exec_get.",
  "err.exec_kill_failed": "The exec could not be stopped: {detail}",
  "err.exec_kill_failed_hint":
    "The exec is still running. Call exec_kill again, or check its processes inside the box.",
  "err.exec_background_box_limit": "This box already has {max} background execs running.",
  "err.exec_background_total_limit": "MiniBox already has {max} background execs running.",
  "err.exec_background_limit_hint": "Wait for one to finish, or stop one with exec_kill, then try again.",
  "err.exec_wake_failed_hint": "The box was stopped and starting it failed. Check the box, then retry exec.",
  "err.exec_output_missing": "No saved output for that exec.",
  "err.exec_output_missing_hint":
    "Output is kept for a limited time. If the command is still running, call exec_get and try again.",
  "err.session_name_invalid":
    "Session name must start with a letter or digit, use only letters, digits, dashes and underscores, and be at most 32 characters.",
  "err.session_keys_invalid": "keys must be 1 to {max} key names, such as Enter, Tab, C-c or a single character.",
  "err.session_text_invalid": "text must be a string of at most {max} bytes without NUL.",
  "err.session_input_required": "Provide exactly one of keys or text.",
  "err.session_lines_range": "lines must be an integer between 1 and {max}.",
  "err.session_since_invalid": "since must be the cursor that the previous session_read of this session returned.",
  "err.session_not_found_hint": "List the box's sessions, or start one with session_start.",
  "err.session_box_stopped_hint":
    "The box is stopped, which ends its sessions. Start the box, then call session_start.",
  "err.session_taken_over": "Session {name} is under human control, so an agent cannot send to it or close it.",
  "err.session_taken_over_hint":
    "A person is working in this session. Read it with session_read and try again in a little while.",
  "err.session_image_unsupported":
    "This box's image is too old to run sessions: it lacks tmux or the dev user from the base template.",
  "err.session_image_unsupported_hint":
    "Build the base template again, then rebuild this box onto the current base template.",
  "err.session_tmux_failed": "tmux failed: {detail}",
  "err.session_tmux_timeout": "tmux did not finish within {max} seconds.",
  "err.session_viewer_tmux_old": "Read-only viewers need tmux 3.2 or later, and this box has tmux {version}.",
  "err.session_viewer_tmux_old_hint": "Rebuild the box from the base template, or install tmux 3.2 or later inside it.",
  "err.session_box_limit": "This box already has {max} sessions.",
  "err.session_box_limit_hint": "Close a session you no longer need, then try again.",
  "err.session_attach_limit": "This session already has {max} terminals open.",
  "err.session_viewer_attach_limit":
    "Read-only viewers already have {max} terminals on this session, and {reserved} stay free for the console.",
  "err.session_attach_limit_hint": "Close one of them, then try again.",
  "err.mcp_bearer_required": "MCP requires an Authorization Bearer access key or agent token.",
  "err.mcp_bearer_hint":
    "Send the header Authorization: Bearer and the access key or an agent token. A browser session cookie is not accepted on /mcp.",
  "err.mcp_owner_key_refused": "The owner access key is not accepted on /mcp. Use an agent token.",
  "err.mcp_owner_key_hint":
    "Create an agent token in Settings, or with minibox token create, and send it as the Bearer key. The setup is in the agents guide: https://github.com/ArnoChenFx/minibox/blob/main/docs/user-guide/agents.md#create-a-token-for-an-agent",
  "err.mcp_toolset_invalid": "Unknown MCP toolset.",
  "err.mcp_toolset_hint":
    "Use core, session, network, storage, tools, meta or rebuild, for example /mcp?toolsets=core,session.",
  "err.mcp_not_sse": "GET /mcp does not stream events.",
  "err.mcp_not_sse_hint": "Post JSON-RPC to /mcp. DELETE /mcp closes a session.",
  "err.startup_command_empty": "The startup command is empty. Enter a command, or remove it.",
  "err.startup_command_too_long": "The startup command is longer than {max} bytes.",
  "err.startup_command_control": "The startup command has a control character. Only tabs and line breaks are allowed.",
  "err.startup_command_none": "No startup command is set on this box.",
  "err.startup_command_box_stopped": "The box is stopped, so the startup command cannot run now.",
  "err.startup_command_box_stopped_hint": "Start the box. The command runs at every start.",
  "err.startup_command_failed": "MiniBox could not run the startup command: {detail}",
  "err.startup_command_clone_failed": "The startup command did not start, because the repository clone failed.",
  "err.startup_command_setup_failed":
    "The startup command did not start, because the box's setup failed. The setup task shows why.",
  "err.startup_command_clone_unfinished":
    "The startup command did not start, because a server restart cut the box's setup short. Run the command again to start it.",
  "err.startup_command_awaits_clone": "The startup command waits for the box's setup to finish.",
  "err.startup_command_invalid": "The startup command must be text.",
  "err.startup_command_forbidden":
    "A startup command runs in the box and may hold secrets. This credential may not set, remove or run one. It needs the exec and secret:use scopes, or the admin preset.",
  "err.startup_session_forbidden":
    "The minibox-init session shows a box's startup command output. This credential may not use it. It needs the exec and secret:use scopes, or the admin preset.",
  "err.notify_channel_id_invalid":
    "A channel id is 1 to 32 lowercase letters, digits or hyphens, starting with a letter.",
  "err.notify_channel_not_found": "Notification channel {channel} was not found.",
  "err.notify_channel_limit": "At most {max} notification channels can exist. Delete one, then add another.",
  "err.notify_type_invalid": "Channel type must be webhook, ntfy or telegram.",
  "err.notify_name_invalid": "A channel name is 1 to 64 characters, with no line breaks or control characters.",
  "err.notify_events_invalid": "Choose at least one notice, and each notice at most once.",
  "err.notify_boxes_invalid":
    "Boxes are box names or ids: at most {max}, each 1 to 128 characters. Leave the list empty to notify for every box.",
  "err.notify_url_invalid":
    "The webhook URL must be an http or https address with no user name or password, at most 2048 characters.",
  "err.notify_url_required": "A webhook channel needs a URL.",
  "err.notify_server_invalid": "The ntfy server must be an http or https address with no user name or password.",
  "err.notify_topic_invalid": "The ntfy topic is 1 to 64 letters, digits, underscores or hyphens.",
  "err.notify_topic_required": "An ntfy channel needs a topic.",
  "err.notify_chat_invalid":
    "The Telegram chat must be a chat id such as -1001234567890, or a channel such as @alerts.",
  "err.notify_chat_required": "A Telegram channel needs a chat id.",
  "err.notify_secret_invalid": "A secret is 8 to 512 characters, with no line breaks or control characters.",
  "err.notify_secret_required": "A Telegram channel needs its bot token as the secret.",
  "err.tool_catalog_invalid": "Tool catalog entry {file} is invalid: {detail}.",
  "err.tool_unknown": "Unknown tool “{id}”.",
  "err.tool_needs_root": "Tool “{id}” requires root, which MiniBox does not run for tool installs.",
  "err.tool_volume_missing":
    "No shared tools volume exists on this host yet. Create a box with the default mounts first.",
  "err.tool_install_failed": "Installing “{id}” failed: {detail}",
  "err.tool_stop_failed": "Could not stop “{id}” in the box, so it was not uninstalled: {detail}",
  "err.tool_install_timeout": "Installing “{id}” timed out.",
  "err.tool_detect_failed": "Could not check which tools are installed in this box: {detail}",
  "err.tool_reconcile_failed": "Could not install the requested tools: {detail}.",
  "err.tool_ids_invalid": "tools must be an array of catalog ids (letters, digits and hyphens), at most 32 entries.",
  "err.tool_version_invalid":
    "Tool version must be latest or a pin of letters, digits, dots, underscores, plus and hyphen (optional leading v), at most 64 characters.",
  "err.tool_version_unsupported":
    "Tool “{id}” installs the latest release only, because its installer takes no version pin.",
  "err.tool_unmanaged":
    "Tool “{id}” is installed outside MiniBox, in the box image or home volume, so MiniBox cannot change it.",
  "err.tool_id_invalid":
    "A tool id starts with a lowercase letter, then lowercase letters, digits or hyphens, and is at most 63 characters.",
  "err.tool_custom_text_invalid": "{label} must be one line of at most {max} characters, without control characters.",
  "err.tool_custom_command_invalid":
    "{label} must be at most {max} characters. Line breaks and tabs are allowed, other control characters are not.",
  "err.tool_custom_placeholder_invalid":
    "{label} uses {placeholder}, which is not a placeholder. Use prefix, version, package, package_spec or bin.",
  "err.tool_custom_package_invalid":
    "{label} may contain only letters, digits, @, dots, underscores, slashes, plus and hyphen, must start with a letter, digit or @, and be at most 214 characters.",
  "err.tool_category_invalid": "Category must be one of agents, languages, terminal or networking.",
  "err.tool_source_invalid": "Source must be npm, pip or script.",
  "err.tool_estimated_invalid": "Estimated size must be a whole number of MB from 1 to {max}.",
  "err.tool_custom_forbidden": "This credential may not change the custom tool catalog.",
  "err.tool_custom_builtin":
    "“{id}” is a built-in tool. Tick “Replace the built-in entry” to replace its catalog entry, or choose another id.",
  "err.tool_custom_builtin_delete": "“{id}” is a built-in tool with no custom entry, so there is nothing to delete.",
  "err.tool_custom_not_found": "No custom tool “{id}” is saved in tools.d.",
  "err.tool_custom_file_conflict":
    "tools.d/{file} also defines “{id}”, so the saved entry would not take effect. Remove or rename that file, then try again.",
  "err.tool_custom_file_other":
    "tools.d/{file} defines “{other}”. Saving “{id}” there would replace that entry. Remove or rename that file, then try again.",
  "err.backup_not_found": "Backup {id} was not found.",
  "err.backup_exists": "Backup {id} is already stored here, so it was not stored again.",
  "err.backup_running": "A backup is already running. Wait for it to finish, then try again.",
  "err.backup_invalid": "The backup is not valid: {reason}",
  "err.backup_passphrase_invalid":
    "The passphrase must be 12 to 1024 characters, with no leading or trailing spaces and no line breaks.",
  "err.secret_name_reserved":
    "Names that start with target. are reserved for a target's credentials. Manage targets in Settings.",
  "err.target_not_found": "Target {id} was not found.",
  "err.target_name_taken": "A target named {name} already exists.",
  "err.target_name_invalid": "A target name is 1 to 64 characters, with no line breaks or control characters.",
  "err.target_field_not_allowed": "{label} does not apply to this kind of target.",
  "err.target_field_invalid": "{label} is not valid.",
  "err.target_endpoint_invalid":
    "The endpoint must be an https address. Plain http is accepted only for localhost, 127.0.0.1 and [::1].",
  "err.target_path_invalid":
    "The path must be relative to the target's folder, with no . or .. segments and no control characters.",
  "err.target_key_invalid": "The private key cannot be used: {reason}.",
  "err.target_host_key_required": "Confirm the server's host key before saving this target.",
  "err.target_host_key_unconfirmed": "The server presented the host key {fingerprint}, which has not been confirmed.",
  "err.target_host_key_mismatch":
    "The server presented the host key {fingerprint}, which is not the one this target was saved with. Nothing was sent to it.",
  "err.target_unreachable": "The target cannot be reached. Check its address and the network.",
  "err.target_auth_failed": "The target refused the credentials.",
  "err.target_forbidden": "The target denied access to its folder.",
  "err.target_failed": "The target failed: {reason}",
  "err.target_credentials_missing": "The credentials of target {name} are missing. Remove the target and add it again.",
  "err.target_object_missing": "{object} is not on the target.",
  "err.target_object_differs": "{object} is on the target with other contents, so it was not replaced.",
  "err.target_object_held": "{object} is already stored here with other contents, so it was not replaced.",
  "err.target_object_invalid": "The object is not valid: {reason}",
  "err.target_busy": "Target {name} is busy with another transfer. Try again when it finishes.",
  "err.target_object_busy": "{object} is already being pulled. Try again when that transfer finishes.",
};

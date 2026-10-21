/**
 * User-facing error messages. The server always answers in English and also returns a stable
 * `key` + `params` so the web UI can show a translated message (see web/js/i18n/*.js, `err.*`).
 */
export const LABELS = {
  name: "Name",
  boxName: "Box name",
  templateName: "Template name",
  snapshotName: "Snapshot name",
  cpus: "CPU cores",
  memory: "Memory",
  pids: "Process limit",
} as const;
export type LabelKey = keyof typeof LABELS;

export const MESSAGES = {
  invalid_json_object: "Request body must be a JSON object.",
  invalid_json: "Request body is not valid JSON.",
  field_required: "{label} is required.",
  name_invalid:
    "{label} may only contain letters, digits, dots, underscores and hyphens, must start with a letter or digit, and be at most 63 characters.",
  not_a_number: "{label} must be a number.",
  cpus_range: "CPU cores must be between {min} and {max}.",
  memory_range: "Memory must be an integer between {min} and {max} (MB).",
  tail_range: "tail must be an integer between 1 and {max}.",
  not_boolean: "{field} must be a boolean.",
  template_required: "Please choose a template.",
  image_ref_invalid: "Invalid image reference.",
  profile_invalid: "Security profile must be one of standard, strict or relaxed.",
  description_invalid: "Description must be a single line without control characters, such as line breaks or tabs.",
  resources_required: "Provide at least one of cpus, memoryMb or pids.",
  revision_required: "Send the request header If-Match with this box's current revision.",
  revision_mismatch: "This box is at revision {revision}, not {expected}. Refresh it and try again.",
  revision_invalid: "If-Match must be the box revision, a positive integer.",
  box_update_empty:
    "Provide at least one of name, cpus, memoryMb, pids, labels, idleTimeoutSec, ttlSec, template, mounts, env, network or profile.",
  mount_invalid:
    "Each mount needs a volume name, an absolute path and a mode of rw or ro. At most {max} mounts, and each path once.",
  env_invalid:
    "Each environment entry needs a name and a value or a secretRef. At most {max} entries, and each name once.",
  network_invalid:
    "Network name must start with a letter or digit and contain only letters, digits, dots, underscores and hyphens.",
  rebuild_empty: "Nothing in this request changes the template, mounts, environment, network or security profile.",
  rebuild_confirm_required:
    "This change rebuilds the box and was not applied. Send the same request with confirm set to true to apply the preview. Volumes, the stable id and the name are kept. The writable layer, running processes and the container IP are lost.",
  rebuild_start_failed: "The new container did not start. The previous container and spec were restored.",
  rebuild_name_conflict: "Cannot rebuild while {name} is still in use. Remove that container and try again.",
  pids_range: "Process limit must be an integer between {min} and {max}.",
  idle_timeout_invalid: "Idle timeout must be a positive number of seconds up to {max}, or null to clear it.",
  ttl_invalid: "TTL must be a positive number of seconds up to {max}, or null to clear it.",
  label_invalid:
    "Labels may have at most 32 entries. Keys follow box name rules, and each value is a single line of at most 256 characters.",
  box_claim_failed: "Could not claim this container as a box: {detail}.",
  docker_unavailable:
    "Cannot connect to the Docker daemon. Make sure Docker is running and the current user can access it.",
  docker_not_found: "Not found: {detail}",
  docker_conflict: "Conflict: {detail}",
  docker_error: "Docker error: {detail}",
  unknown_error: "Unknown error",
  api_not_found: "API endpoint not found.",
  method_not_allowed: "Method not allowed.",
  unsupported_media_type: "Use Content-Type: application/json (requests without a body may omit it).",
  origin_forbidden:
    "Blocked: the request's Origin is not this MiniBox address and is not listed in ALLOWED_ORIGINS. If you reach MiniBox through a tunnel or reverse proxy, add its public address (for example https://minibox.example.com) to ALLOWED_ORIGINS and restart MiniBox.",
  unauthorized: "Not signed in, or the access key is invalid.",
  operation_forbidden: "This credential may not run {op}.",
  run_invalid:
    "X-Minibox-Run must be 1 to 64 letters, digits, dots, colons, underscores or hyphens, starting with a letter or digit.",
  event_filter_invalid: "{field} must be 1 to 200 characters, without control characters.",
  event_status_invalid: "status must be one of started, ok, error or denied.",
  event_limit_range: "limit must be an integer between 1 and {max}.",
  event_cursor_invalid: "cursor must be a sequence number from an earlier page.",
  event_since_invalid: "since must be an ISO 8601 date or date and time, such as 2026-10-20T00:00:00Z.",
  last_event_id_invalid: "Last-Event-ID must be a sequence number from an earlier event.",
  task_not_found: "Task not found.",
  task_busy: "This operation is already running.",
  task_not_running: "This task is not running.",
  task_cancelled: "The task was cancelled.",
  task_interrupted: "The task was interrupted because MiniBox stopped.",
  task_id_invalid: "Task id must be a 26-character ULID.",
  task_status_invalid: "status must be one of running, succeeded, failed, cancelled or interrupted.",
  task_limit_range: "limit must be an integer between 1 and {max}.",
  terminal_not_running: "The box is not running, so a terminal can't be opened.",
  ws_upgrade_failed: "WebSocket upgrade failed.",
  too_many_attempts: "Too many attempts. Please try again in 5 minutes.",
  wrong_key: "Incorrect access key.",
  box_not_found: "Box not found.",
  session_not_found: "Session not found.",
  snapshot_not_found: "Snapshot not found.",
  template_not_found: "Template not found.",
  template_image_missing:
    "Template image {image} does not exist. Build it on the Templates page or choose another template.",
  box_exists: "A box named “{name}” already exists.",
  box_network_conflict:
    "Network {network} already exists but is not a bridge with inter-container communication disabled. Remove it when no box uses it, then try again.",
  volume_reserved: "Volume {volume} holds MiniBox's own data and cannot be mounted into a box.",
  volume_unmanaged: "Volume {volume} was not created by MiniBox, so a box cannot mount it.",
  volume_in_use: "Volume {volume} is already mounted by another box.",
  volume_missing:
    "Volume {volume} is recorded by MiniBox but no longer exists in the engine. MiniBox does not recreate it. Delete the volume record or restore the engine volume.",
  network_reserved: "Boxes cannot join network {network}. Host, none and container networks are refused.",
  network_not_managed: "Boxes cannot join network {network}. Boxes join {managed}.",
  cpu_over_host: "CPU cores exceed the host limit ({cores} cores).",
  memory_over_host: "Memory exceeds the host limit ({gb} GB).",
  storage_unreachable: "Storage pool {pool} is unreachable: {detail}",
  volume_not_found: "Volume {volume} was not found.",
  volume_exists: "A volume named “{name}” already exists.",
  volume_mounted: "Volume {name} is mounted by {box}.",
  volume_delete_failed: "Volume {name} could not be deleted: {detail}",
  volume_attach_forbidden: "This credential may not attach volume {volume}.",
  volume_chown_failed: "Could not change ownership of a new volume: {detail}",
  volume_prepare_failed: "Could not prepare the volume directory: {detail}",
  helper_image_missing: "Base template image {image} is missing, so volume helpers cannot run.",
  mount_path_invalid: "Mount path {path} must be an absolute path without empty, . or .. segments.",
  mount_duplicate: "Mount path {path} is listed more than once.",
  mount_not_found: "No mount at {path}.",
  pool_not_found: "Storage pool {pool} was not found.",
  pool_backend_invalid: "Pool {pool} has an unknown backend.",
  pool_local_backend: "The local pool must stay a local backend.",
  nfs_pool_invalid: "NFS pool {pool} needs a server and an absolute export path.",
  nfs_options_invalid: "NFS options for pool {pool} must be up to 16 tokens of letters, digits and . _ = -.",
  path_pool_invalid: "Path pool {pool} needs an absolute root directory.",
  marker_invalid: "A path pool marker must be a single file name, not a path.",
  pool_path_invalid: "{what} path {path} must be absolute and must not contain ..",
  pool_duplicate: "Pool names must be unique.",
  pool_default_conflict: "Choose exactly one default storage pool.",
  pool_in_use: "Pool {pool} still has volumes, so it cannot be removed or change backend.",
  role_pool_unknown: "Role {role} points at pool {pool}, which does not exist.",
} as const;
export type MessageKey = keyof typeof MESSAGES;

export type Params = Record<string, string | number>;
export interface Msg {
  key: MessageKey;
  params?: Params;
  text: string;
}

/** Build a message: English text for logs/API clients plus key/params for UI translation. */
export function msg(key: MessageKey, params?: Params): Msg {
  const text = MESSAGES[key].replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = params?.[k];
    if (v === undefined) return m;
    return k === "label" && typeof v === "string" && v in LABELS ? LABELS[v as LabelKey] : String(v);
  });
  return { key, params, text };
}

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
  network_reserved: "Boxes cannot join network {network}. Host, none and container networks are refused.",
  network_not_managed: "Boxes cannot join network {network}. Boxes join {managed}.",
  cpu_over_host: "CPU cores exceed the host limit ({cores} cores).",
  memory_over_host: "Memory exceeds the host limit ({gb} GB).",
  exec_command_required: "Provide exactly one of cmd or argv.",
  exec_command_hint: "cmd runs through /bin/sh -c. argv is the program and its arguments, with no shell.",
  exec_cmd_invalid: "cmd must be a string of at most {max} bytes and must not contain NUL.",
  exec_argv_invalid:
    "argv must contain 1 to {max} non-empty strings. Each string is at most 16384 bytes and must not contain NUL.",
  exec_cwd_invalid: "cwd must be an absolute path of at most {max} bytes, without NUL or line breaks.",
  exec_env_invalid:
    "env must be an object of at most 64 names. A name starts with a letter or underscore, and a value is a string of at most 32768 bytes without NUL.",
  exec_timeout_range: "timeoutSec must be an integer between {min} and {max}.",
  exec_timeout_foreground: "A foreground exec may use at most {max} seconds of timeoutSec.",
  exec_timeout_foreground_hint: "For a longer command, set background to true and poll it with exec_get.",
  exec_stdin_invalid: "stdin must be a string of at most {max} bytes.",
  exec_user_invalid: "user must be a user name or id, optionally with a group, such as dev or 1000:1000.",
  exec_user_strict: "The strict profile runs exec only as dev or 1000, not as {user}.",
  exec_user_strict_hint:
    "Use the default user. Other users need a box with the standard or relaxed profile, which is set when the box is created.",
  exec_wait_range: "waitMs must be an integer between 0 and {max}.",
  exec_id_invalid: "execId must be ex_ followed by 26 Crockford base32 characters.",
  exec_not_found: "No exec with that id is known.",
  exec_not_found_hint:
    "Finished commands stay in memory only until the server restarts or the in-memory list drops them. Saved output is available from the output endpoint while the file is kept.",
  exec_not_running: "That exec is not running.",
  exec_not_running_hint: "It has already exited. Read the result with exec_get.",
  exec_kill_failed: "The exec could not be stopped: {detail}",
  exec_kill_failed_hint: "The exec is still running. Call exec_kill again, or check its processes inside the box.",
  exec_background_box_limit: "This box already has {max} background execs running.",
  exec_background_total_limit: "MiniBox already has {max} background execs running.",
  exec_background_limit_hint: "Wait for one to finish, or stop one with exec_kill, then try again.",
  exec_wake_failed_hint: "The box was stopped and starting it failed. Check the box, then retry exec.",
  exec_output_missing: "No saved output for that exec.",
  exec_output_missing_hint:
    "Output is kept for a limited time. If the command is still running, call exec_get and try again.",
  session_name_invalid:
    "Session name must start with a letter or digit, use only letters, digits, dashes and underscores, and be at most 32 characters.",
  session_keys_invalid: "keys must be 1 to {max} key names, such as Enter, Tab, C-c or a single character.",
  session_text_invalid: "text must be a string of at most {max} bytes without NUL.",
  session_input_required: "Provide exactly one of keys or text.",
  session_lines_range: "lines must be an integer between 1 and {max}.",
  session_since_invalid: "since must be the cursor that the previous session_read of this session returned.",
  session_not_found_hint: "List the box's sessions, or start one with session_start.",
  session_box_stopped_hint: "The box is stopped, which ends its sessions. Start the box, then call session_start.",
  session_taken_over: "Session {name} is under human control, so input is refused.",
  session_taken_over_hint:
    "A person is working in this session. Read it with session_read and send again in a little while.",
  session_tmux_missing: "This box does not have tmux, so sessions are unavailable.",
  session_tmux_missing_hint:
    "Boxes from the base template include tmux. Rebuild the box from it, or install tmux inside the box.",
  session_tmux_failed: "tmux failed: {detail}",
  mcp_bearer_required: "MCP requires an Authorization Bearer access key.",
  mcp_bearer_hint:
    "Send the header Authorization: Bearer and the access key. A browser session cookie is not accepted on /mcp.",
  mcp_toolset_invalid: "Unknown MCP toolset.",
  mcp_toolset_hint:
    "Use core, session, network, storage, tools, meta or rebuild, for example /mcp?toolsets=core,session.",
  mcp_not_sse: "GET /mcp does not stream events.",
  mcp_not_sse_hint: "Post JSON-RPC to /mcp. DELETE /mcp closes a session.",
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

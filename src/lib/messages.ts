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
  description_invalid: "Description must be a single line without control characters, such as line breaks or tabs.",
  resources_required: "Provide at least one of cpus or memoryMb.",
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
  terminal_not_running: "The box is not running, so a terminal can't be opened.",
  ws_upgrade_failed: "WebSocket upgrade failed.",
  too_many_attempts: "Too many attempts. Please try again in 5 minutes.",
  wrong_key: "Incorrect access key.",
  box_not_found: "Box not found.",
  snapshot_not_found: "Snapshot not found.",
  template_not_found: "Template not found.",
  template_image_missing:
    "Template image {image} does not exist. Build it on the Templates page or choose another template.",
  box_exists: "A box named “{name}” already exists.",
  cpu_over_host: "CPU cores exceed the host limit ({cores} cores).",
  memory_over_host: "Memory exceeds the host limit ({gb} GB).",
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

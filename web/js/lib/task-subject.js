const TOOL_OPS = new Set(["tool.install", "tool.upgrade", "tool.uninstall"]);

/**
 * The name a task acted on. Tasks written before the server recorded `subject` still name the tool in their result, or
 * in the error when the install failed.
 */
export function subjectOf(task) {
  if (task.subject) return task.subject;
  if (!TOOL_OPS.has(task.op)) return "";
  return task.result?.id ?? task.error?.params?.id ?? "";
}

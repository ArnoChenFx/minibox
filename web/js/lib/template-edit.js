/**
 * The setup an edit sends: the postCreateCommand as the argv a recipe keeps, and the forwarded ports. A blank command and
 * no ports mean the template asks for no setup, which is sent as `null` so a recipe that had one drops it. Pure, so the
 * edit dialog and the tests share it.
 */
export function initOf(command, ports) {
  const text = String(command ?? "").trim();
  const init = {
    ...(text === "" ? {} : { postCreate: ["/bin/sh", "-c", text] }),
    ...(ports.length === 0 ? {} : { forwardPorts: [...ports] }),
  };
  return Object.keys(init).length === 0 ? null : init;
}

/**
 * Reads the ports a caller typed. A comma or space separated list of integers between 1 and 65535, or an empty string for
 * none. Returns `{ ports }`, or `{ problem }` naming the entry that is not a port. Pure, so the dialog and the tests share
 * it.
 */
export function readPorts(text) {
  const parts = String(text ?? "")
    .split(/[\s,]+/)
    .filter((part) => part !== "");
  if (parts.length === 0) return { ports: [] };
  const ports = [];
  for (const part of parts) {
    const port = Number(part);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: part };
    ports.push(port);
  }
  return { ports };
}

/** The postCreateCommand as one line to type, from the argv a recipe keeps. */
export function commandText(command) {
  if (command === undefined || command.length === 0) return "";
  return command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c"
    ? command[2]
    : command.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

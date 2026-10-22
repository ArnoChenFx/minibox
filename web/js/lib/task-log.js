/**
 * Splits a task's log into the shell commands it ran and the output that followed. The tool runner writes each command
 * as a line that starts with "$ ", directly under a banner line that names the action. The banner and the command are
 * not output, so both are returned apart from it.
 */
export function splitTaskLog(text) {
  const lines = text.split("\n");
  const kept = [];
  const commands = [];
  lines.forEach((line, index) => {
    if (!line.startsWith("$ ")) {
      kept.push(line);
      return;
    }
    const above = index > 0 ? lines[index - 1] : "";
    const banner = above !== "" && !above.startsWith("$ ") ? kept.pop().replace(/\r$/, "") : null;
    commands.push({ banner, command: line.slice(2).replace(/\r$/, "") });
  });
  return { commands, output: kept.join("\n") };
}

/** The marker the server puts in front of a log it has trimmed. */
export const LOG_OMITTED = "… earlier output omitted …\n";

/**
 * Keeps at most `max` characters from the end of a streamed log, so a long build does not grow the panel's text, and
 * the cost of re-rendering it, without bound. The cut moves to the next line break, and the result starts with the
 * marker the server uses when it trims.
 */
export function capLog(text, max) {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  const cut = tail.indexOf("\n");
  return LOG_OMITTED + (cut === -1 ? tail : tail.slice(cut + 1));
}

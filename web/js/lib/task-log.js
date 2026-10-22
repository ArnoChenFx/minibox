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

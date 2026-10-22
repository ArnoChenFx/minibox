/**
 * The custom tool form without the DOM: the command templates a source starts from, what a source change does to the
 * commands already typed, the form's starting values, which ids are built in, and the request body. The server checks
 * the body again, so these rules only keep the form in step with it.
 */

export const COMMAND_FIELDS = ["install", "upgrade", "uninstall", "stop", "detect"];

/** Command fields that may be left blank. A blank one is left out of the request body. */
export const OPTIONAL_COMMANDS = ["stop"];

/** The server's limits, so the inputs can refuse what the server would refuse. */
export const CUSTOM_LIMITS = Object.freeze({
  id: 63,
  name: 80,
  description: 300,
  package: 214,
  bin: 63,
  requires: 600,
  command: 16000,
});

const CUSTOM_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const DETECT = "command -v {{bin}} >/dev/null && {{bin}} --version 2>/dev/null";

/** The npm commands of catalog/claude-code.json. `detect` names the binary by its placeholder, not `claude`. */
const NPM_COMMANDS = Object.freeze({
  install: "npm install -g --prefix {{prefix}} {{package_spec}}",
  upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
  uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
  detect: DETECT,
});

/** One virtualenv per package under tools/venvs, with the binary linked into tools/bin, so uninstall removes exactly that. */
const PIP_INSTALL =
  "python3 -m venv {{prefix}}/venvs/{{bin}} && {{prefix}}/venvs/{{bin}}/bin/pip install --upgrade {{package_spec}} && mkdir -p {{prefix}}/bin && ln -sfn ../venvs/{{bin}}/bin/{{bin}} {{prefix}}/bin/{{bin}}";
const PIP_COMMANDS = Object.freeze({
  install: PIP_INSTALL,
  upgrade: PIP_INSTALL,
  uninstall: "rm -f {{prefix}}/bin/{{bin}} && rm -rf {{prefix}}/venvs/{{bin}}",
  detect: DETECT,
});

/** The command templates of a source, or `null` for a script, which has none: its four commands are written by hand. */
export function commandTemplate(source) {
  if (source === "npm") return { ...NPM_COMMANDS };
  if (source === "pip") return { ...PIP_COMMANDS };
  return null;
}

/**
 * The commands after the source changes. A command still holding the old source's template follows the new source (a
 * script has none, so it clears; no source has a stop template), and a command the admin typed or changed stays as it is.
 */
export function commandsForSource(commands, fromSource, toSource) {
  const before = commandTemplate(fromSource) ?? {};
  const after = commandTemplate(toSource) ?? {};
  return Object.fromEntries(
    COMMAND_FIELDS.map((field) => {
      const current = commands[field] ?? "";
      const untouched = current === "" || current === before[field];
      return [field, untouched ? (after[field] ?? "") : current];
    }),
  );
}

/** The form's starting values. A new entry starts on npm, with its templates; an existing entry shows its own text. */
export function customToolForm(entry) {
  if (!entry) {
    return {
      id: "",
      name: "",
      description: "",
      category: "agents",
      source: "npm",
      package: "",
      bin: "",
      requires: "",
      estimatedMb: "50",
      needsRoot: false,
      overrideBuiltin: false,
      ...commandTemplate("npm"),
      stop: "",
    };
  }
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    source: entry.source,
    package: entry.package,
    bin: entry.bin,
    requires: entry.requires ?? "",
    estimatedMb: String(entry.estimatedMb),
    needsRoot: entry.needsRoot,
    overrideBuiltin: entry.overridesBuiltin,
    install: entry.install,
    upgrade: entry.upgrade,
    uninstall: entry.uninstall,
    stop: entry.stop ?? "",
    detect: entry.detect,
  };
}

export function validCustomId(id) {
  return CUSTOM_ID_RE.test(id);
}

/**
 * Whether saving `id` replaces a built-in entry. A custom entry reports this itself. Any other id the merged catalog
 * lists is built in, because a custom entry is the only way a catalog id can be missing from the bundled catalog.
 */
export function isBuiltinId(id, catalogIds, customById) {
  const custom = customById.get(id);
  return custom ? custom.overridesBuiltin : catalogIds.has(id);
}

/**
 * The request body of `PUT /api/tools/custom/:id`, without the id, which the path carries. Text is trimmed as the server
 * trims it, and a blank requirement is left out. A size that is not a plain number goes as typed, so the server can name
 * the problem rather than the form guessing.
 */
export function customToolBody(values) {
  const size = String(values.estimatedMb).trim();
  const body = {
    name: values.name.trim(),
    description: values.description.trim(),
    category: values.category,
    source: values.source,
    package: values.package.trim(),
    bin: values.bin.trim(),
    needsRoot: values.needsRoot === true,
    estimatedMb: /^\d+$/.test(size) ? Number(size) : size,
    install: values.install.trim(),
    upgrade: values.upgrade.trim(),
    uninstall: values.uninstall.trim(),
    detect: values.detect.trim(),
    overrideBuiltin: values.overrideBuiltin === true,
  };
  const requires = values.requires.trim();
  if (requires) body.requires = requires;
  const stop = (values.stop ?? "").trim();
  if (stop) body.stop = stop;
  return body;
}

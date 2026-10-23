/** The source kinds a template can be built from, in the order the dialog shows them. */
export const SOURCE_KINDS = ["dockerfile", "git", "context", "devcontainer"];

/**
 * The translation key of each kind's name, shown in the dialog and on the template card. `official` is not a source the
 * dialog offers: MiniBox builds those itself.
 */
export const KIND_LABEL_KEYS = {
  dockerfile: "tp.kindDockerfile",
  git: "tp.kindGit",
  context: "tp.kindContext",
  devcontainer: "tp.kindDevcontainer",
  official: "tp.kindOfficial",
};

/** The same rule the server applies to an image reference, so a typo is caught before the request. */
const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/;
const IMAGE_REF_MAX = 255;

export function imageRefOk(value) {
  const v = text(value);
  return v !== "" && v.length <= IMAGE_REF_MAX && IMAGE_REF_RE.test(v);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Copies each non-empty field into `out` under its request name. Empty optional fields are left out of the body. */
function withFields(out, pairs) {
  for (const [key, value] of pairs) {
    const v = text(value);
    if (v !== "") out[key] = v;
  }
  return out;
}

/**
 * The `source` of a template create, from the fields one kind's panel shows. A Dockerfile is sent as typed; the other
 * kinds send trimmed values. Returns `{ source }`, or `{ problem, key }` naming the field and the message to show.
 */
export function templateSource(kind, fields) {
  if (kind === "dockerfile") {
    const dockerfile = typeof fields.text === "string" ? fields.text : "";
    if (dockerfile.trim() === "") return { problem: "text", key: "tp.errDockerfile" };
    return { source: { kind, text: dockerfile } };
  }
  if (!["git", "context", "devcontainer"].includes(kind)) return { problem: "kind", key: "tp.errKind" };
  const url = text(fields.url);
  if (url === "") return { problem: "url", key: "src.errUrl" };
  if (kind === "git") {
    return {
      source: withFields({ kind, url }, [
        ["branch", fields.branch],
        ["subdir", fields.subdir],
        ["dockerfile", fields.dockerfile],
        ["secretRef", fields.secretRef],
      ]),
    };
  }
  if (kind === "context") return { source: withFields({ kind, url }, [["dockerfile", fields.dockerfile]]) };
  return {
    source: withFields({ kind, url }, [
      ["branch", fields.branch],
      ["path", fields.path],
      ["secretRef", fields.secretRef],
    ]),
  };
}

/**
 * The `repo` of a box create from the clone fields, or `{ repo: null }` when no URL is given. A branch or a secret
 * without a URL is a problem with the URL.
 */
export function cloneRepo(fields) {
  const url = text(fields.url);
  if (url === "") {
    return text(fields.branch) || text(fields.secretRef) ? { problem: "url", key: "src.errUrl" } : { repo: null };
  }
  return {
    repo: withFields({ url }, [
      ["branch", fields.branch],
      ["secretRef", fields.secretRef],
    ]),
  };
}

/** The least a host needs to be labelled: its id and the name a person reads it by. */
export interface Labelled {
  readonly id: string;
  readonly name: string;
}

/**
 * A host's name as compared for uniqueness: in Unicode NFC, trimmed and without its case, so `Lab`, ` lab ` and a `Café`
 * typed with a combining accent are each the one name a reader would read as one machine. The name itself is kept as the
 * operator typed it, since it is only what the console shows.
 */
export function foldName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/**
 * A host as a person reads it, for a message or a list that has more than one host at hand. The name is the label, and no
 * two hosts may share one, so the name is normally the whole label. A hosts file written before that rule existed can
 * still hold two hosts of one name, and MiniBox loads such a file rather than refusing to boot, so a shared name is
 * completed with the id: the id is how every call addresses a host, and adding it only where a name is actually shared
 * keeps a name a label rather than a key.
 */
export function hostLabel(host: Labelled, hosts: readonly Labelled[]): string {
  const folded = foldName(host.name);
  const shared = hosts.some((other) => other.id !== host.id && foldName(other.name) === folded);
  return shared ? `${host.name} · ${host.id}` : host.name;
}

/** The hosts each registered host is listed with, kept by the registry as hosts come and go. */
const peers = new WeakMap<Labelled, readonly Labelled[]>();

/** Records `hosts` as the list each of them is labelled among. The registry calls it whenever its list changes. */
export function relabel(hosts: readonly Labelled[]): void {
  const list = [...hosts];
  for (const host of list) peers.set(host, list);
}

/**
 * The label a message about one host quotes: its name, with its id when another registered host shares that name. A host
 * that is not registered is labelled by its name alone. The label is worked out when it is asked for, so it is never
 * older than the names it compares.
 */
export function labelOf(host: Labelled): string {
  const list = peers.get(host);
  return list ? hostLabel(host, list) : host.name;
}

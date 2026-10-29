/** The least a host needs to be labelled: its id and the name a person reads it by. */
export interface Labelled {
  readonly id: string;
  readonly name: string;
}

/**
 * A host as a person reads it, for a message or a list that has more than one host at hand. The name is the label, and no
 * two hosts may share one, so the name is normally the whole label. A hosts file written before that rule existed can
 * still hold two hosts of one name, and MiniBox loads such a file rather than refusing to boot, so a shared name is
 * completed with the id: the id is how every call addresses a host, and adding it only where a name is actually shared
 * keeps a name a label rather than a key. A name is compared trimmed and without its case, as adding a host compares it.
 */
export function hostLabel(host: Labelled, hosts: readonly Labelled[]): string {
  const folded = host.name.trim().toLowerCase();
  const shared = hosts.some((other) => other.id !== host.id && other.name.trim().toLowerCase() === folded);
  return shared ? `${host.name} · ${host.id}` : host.name;
}
